import * as net from 'node:net';
import * as tls from 'node:tls';

/**
 * Client POP3 (RFC 1939).
 *
 * Écrit à la main, et c'est volontaire : le protocole tient en une dizaine de
 * commandes et n'a pas bougé depuis 1996, alors que les paquets npm qui
 * l'implémentent, eux, cassent (la version 0.15 de `node-pop3` livre du code
 * ESM dans un fichier `.cjs`, donc impossible à charger). Deux cents lignes
 * sous contrôle valent mieux qu'une dépendance à réparer.
 *
 * Le point important : `retr()` rend un **Buffer**, jamais une chaîne. Un
 * message qui contient de l'ISO-8859-1 en 8 bits survit tel quel, et c'est ce
 * qu'on renvoie au SMTP octet pour octet.
 */

const CRLF = Buffer.from('\r\n');
const TERMINATOR = Buffer.from('\r\n.\r\n');

export type Pop3Security = 'tls' | 'starttls' | 'none';

export interface Pop3Options {
  host: string;
  port: number;
  security: Pop3Security;
  user: string;
  pass: string;
  /** Délai maximum d'une commande, en millisecondes. */
  timeoutMs: number;
  /** Accepter un certificat auto-signé. */
  allowInvalidCert: boolean;
}

export interface Pop3Entry {
  num: number;
  uid: string;
  /** Taille en octets, d'après LIST. -1 si le serveur ne l'a pas donnée. */
  size: number;
}

interface Waiter {
  resolve: (value: { status: string; body: Buffer }) => void;
  reject: (err: Error) => void;
  multiline: boolean;
  maxBytes: number;
  statusLine: string | null;
  timer: NodeJS.Timeout;
}

export class Pop3Client {
  private socket: net.Socket | tls.TLSSocket;
  private pending: Buffer = Buffer.alloc(0);
  private waiter: Waiter | null = null;
  /** Position déjà scannée à la recherche du terminateur multi-lignes. */
  private scanFrom = 0;
  private closed = false;
  private fatal: Error | null = null;

  private constructor(
    socket: net.Socket | tls.TLSSocket,
    private readonly options: Pop3Options,
  ) {
    this.socket = socket;
    this.attach();
  }

  /** Ouvre la connexion, salue le serveur et s'authentifie. */
  static async connect(options: Pop3Options): Promise<Pop3Client> {
    const socket = await openSocket(options);
    const client = new Pop3Client(socket, options);

    try {
      await client.readGreeting();
      if (options.security === 'starttls') await client.upgradeToTls();
      await client.command('USER', options.user);
      await client.command('PASS', options.pass);
    } catch (err) {
      client.destroy();
      throw err;
    }
    return client;
  }

  // --- Commandes ------------------------------------------------------------

  /** Liste des messages présents, avec leur identifiant stable et leur taille. */
  async list(): Promise<Pop3Entry[]> {
    const sizes = new Map<number, number>();
    for (const line of await this.multiline('LIST')) {
      const [num, size] = line.split(/\s+/);
      if (num) sizes.set(Number(num), Number(size) || -1);
    }

    // UIDL donne l'identifiant unique et *stable* du message. C'est lui qui
    // permet de savoir ce qui a déjà été traité : le numéro de message, lui,
    // est renuméroté dès qu'un message est supprimé de la boîte.
    const entries: Pop3Entry[] = [];
    for (const line of await this.multiline('UIDL')) {
      const [num, uid] = line.split(/\s+/);
      if (!num || !uid) continue;
      entries.push({ num: Number(num), uid, size: sizes.get(Number(num)) ?? -1 });
    }
    return entries;
  }

  /** Récupère un message entier, octets bruts, dé-« dot-stuffé ». */
  async retr(num: number, maxBytes = 0): Promise<Buffer> {
    const { body } = await this.send(`RETR ${num}`, true, maxBytes);
    return dotUnstuff(body);
  }

  /** Marque un message pour suppression (effective au QUIT). */
  async dele(num: number): Promise<void> {
    await this.command('DELE', String(num));
  }

  /** Capacités annoncées par le serveur (vide si CAPA n'est pas supportée). */
  async capabilities(): Promise<string[]> {
    try {
      return await this.multiline('CAPA');
    } catch {
      return [];
    }
  }

  /**
   * Valide les suppressions et ferme proprement.
   * Un `QUIT` manqué annule les DELE : c'est le comportement du protocole, et
   * c'est une sécurité — mieux vaut un doublon qu'un message perdu.
   */
  async quit(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command('QUIT');
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeAllListeners();
    this.socket.destroy();
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error('connexion POP3 fermée'));
      this.waiter = null;
    }
  }

  // --- Plomberie ------------------------------------------------------------

  private attach(): void {
    this.socket.on('data', (chunk: Buffer) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      this.drain();
    });
    this.socket.on('error', (err: Error) => this.fail(err));
    this.socket.on('close', () => this.fail(new Error('connexion POP3 interrompue')));
  }

  private fail(err: Error): void {
    this.fatal = err;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(err);
      this.waiter = null;
    }
  }

  private readGreeting(): Promise<void> {
    return this.expect(false, 0).then(() => undefined);
  }

  private async command(name: string, arg?: string): Promise<string> {
    const { status } = await this.send(arg === undefined ? name : `${name} ${arg}`, false, 0);
    return status;
  }

  private async multiline(command: string): Promise<string[]> {
    const { body } = await this.send(command, true, 0);
    return body
      .toString('latin1')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  private send(
    command: string,
    multiline: boolean,
    maxBytes: number,
  ): Promise<{ status: string; body: Buffer }> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.waiter) return Promise.reject(new Error('commande POP3 déjà en cours'));

    const promise = this.expect(multiline, maxBytes);
    this.socket.write(command + '\r\n');
    return promise;
  }

  private expect(multiline: boolean, maxBytes: number): Promise<{ status: string; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.destroy();
        reject(new Error(`délai POP3 dépassé (${this.options.timeoutMs} ms)`));
      }, this.options.timeoutMs);

      this.waiter = { resolve, reject, multiline, maxBytes, statusLine: null, timer };
      this.drain();
    });
  }

  /** Consomme le tampon dès qu'une réponse complète y est disponible. */
  private drain(): void {
    const w = this.waiter;
    if (!w) return;

    if (w.statusLine === null) {
      const eol = this.pending.indexOf(CRLF);
      if (eol === -1) return;

      const line = this.pending.subarray(0, eol).toString('latin1');
      this.pending = this.pending.subarray(eol + 2);
      this.scanFrom = 0;

      if (line.startsWith('-ERR')) {
        this.finish(w, () => w.reject(new Error(line.replace(/^-ERR\s*/, '') || 'erreur POP3')));
        return;
      }
      if (!w.multiline) {
        this.finish(w, () => w.resolve({ status: line, body: Buffer.alloc(0) }));
        return;
      }
      w.statusLine = line;
    }

    if (w.maxBytes && this.pending.length > w.maxBytes) {
      this.finish(w, () => w.reject(new Error('message trop volumineux')));
      this.destroy();
      return;
    }

    // Corps vide : le serveur envoie directement la ligne de terminaison, sans
    // le CRLF qui la précède habituellement.
    if (this.pending.length >= 3 && this.pending[0] === 0x2e && this.pending[1] === 0x0d && this.pending[2] === 0x0a) {
      const status = w.statusLine!;
      this.pending = this.pending.subarray(3);
      this.finish(w, () => w.resolve({ status, body: Buffer.alloc(0) }));
      return;
    }

    const end = this.pending.indexOf(TERMINATOR, this.scanFrom);
    if (end === -1) {
      // Le terminateur peut être à cheval sur deux paquets : on garde de quoi
      // le reconnaître au prochain passage.
      this.scanFrom = Math.max(0, this.pending.length - TERMINATOR.length + 1);
      return;
    }

    const status = w.statusLine!;
    const body = this.pending.subarray(0, end + 2); // on garde le CRLF final
    this.pending = this.pending.subarray(end + TERMINATOR.length);
    this.scanFrom = 0;
    this.finish(w, () => w.resolve({ status, body }));
  }

  private finish(w: Waiter, settle: () => void): void {
    clearTimeout(w.timer);
    this.waiter = null;
    settle();
  }

  /** Bascule une connexion en clair vers TLS (commande STLS, RFC 2595). */
  private async upgradeToTls(): Promise<void> {
    await this.command('STLS');
    const plain = this.socket;
    plain.removeAllListeners();

    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const secure = tls.connect(
        {
          socket: plain,
          servername: this.options.host,
          rejectUnauthorized: !this.options.allowInvalidCert,
        },
        () => resolve(secure),
      );
      secure.once('error', reject);
    });
    this.pending = Buffer.alloc(0);
    this.scanFrom = 0;
    this.attach();
  }
}

function openSocket(options: Pop3Options): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };

    const socket =
      options.security === 'tls'
        ? tls.connect({
            host: options.host,
            port: options.port,
            servername: options.host,
            rejectUnauthorized: !options.allowInvalidCert,
          })
        : net.connect({ host: options.host, port: options.port });

    const ready = options.security === 'tls' ? 'secureConnect' : 'connect';
    socket.setTimeout(options.timeoutMs, () => onError(new Error('délai de connexion POP3 dépassé')));
    socket.once('error', onError);
    socket.once(ready, () => {
      socket.setTimeout(0);
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/**
 * Annule le « dot-stuffing » du protocole (RFC 1939 §3) : le serveur double le
 * point des lignes qui commencent par un point, pour qu'elles ne soient pas
 * confondues avec la fin du message.
 */
export function dotUnstuff(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let start = 0;
  let i = 0;

  // Cas de la toute première ligne, qui n'est précédée d'aucun CRLF.
  if (body.length >= 2 && body[0] === 0x2e && body[1] === 0x2e) start = 1;

  i = start;
  while (i <= body.length - 4) {
    if (
      body[i] === 0x0d &&
      body[i + 1] === 0x0a &&
      body[i + 2] === 0x2e &&
      body[i + 3] === 0x2e
    ) {
      chunks.push(body.subarray(start, i + 3));
      start = i + 4;
      i = start;
      continue;
    }
    i++;
  }
  if (!chunks.length) return start === 0 ? body : body.subarray(start);
  chunks.push(body.subarray(start));
  return Buffer.concat(chunks);
}
