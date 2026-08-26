import * as net from 'node:net';
import * as tls from 'node:tls';

/**
 * Client IMAP (RFC 3501), réduit à ce dont on a besoin : se connecter,
 * s'authentifier, et **déposer** un message dans un dossier avec APPEND.
 *
 * Écrit à la main pour les mêmes raisons que `pop3.ts` : trois commandes
 * suffisent, et aucune bibliothèque n'est à la hauteur de la promesse « ce
 * qu'on dépose est exactement ce qu'on a relevé ». Le message est un Buffer du
 * début à la fin ; rien ne passe par une chaîne de caractères, donc rien ne se
 * fait re-encoder au passage.
 *
 * C'est ce mode qui règle le « moi » de Gmail : aucun serveur d'envoi n'étant
 * traversé, personne ne réécrit le `From:`, et SPF/DKIM/DMARC n'ont pas leur
 * mot à dire — le message est simplement rangé dans la boîte.
 */

const CRLF = Buffer.from('\r\n');

export interface ImapOptions {
  host: string;
  port: number;
  /** true = TLS direct (993), false = clair puis STARTTLS si possible (143). */
  secure: boolean;
  user: string;
  pass: string;
  /** Délai maximum d'une commande, en millisecondes. */
  timeoutMs: number;
  /** Accepter un certificat auto-signé. */
  allowInvalidCert: boolean;
}

export interface AppendOptions {
  /** Drapeaux posés à l'arrivée. Vide = message non lu. */
  flags?: string[];
  /**
   * Date interne du message, celle sur laquelle le client de messagerie trie.
   * Sans elle, tout ce qu'on dépose porterait l'heure de la relève.
   */
  internalDate?: Date;
}

interface Response {
  /** Lignes `*` reçues avant la réponse taguée. */
  untagged: string[];
  /** OK, NO ou BAD. */
  status: string;
  /** Le reste de la ligne taguée, code entre crochets compris. */
  text: string;
}

interface Waiter {
  resolve: (value: Response) => void;
  reject: (err: Error) => void;
  tag: string;
  untagged: string[];
  /** Appelé sur `+ ...` : le serveur réclame la suite. */
  onContinue: (() => void) | null;
  timer: NodeJS.Timeout;
}

export class ImapClient {
  private socket: net.Socket | tls.TLSSocket;
  private pending: Buffer = Buffer.alloc(0);
  private waiter: Waiter | null = null;
  private counter = 0;
  private closed = false;
  private fatal: Error | null = null;
  /** Capacités annoncées, en majuscules. */
  private caps = new Set<string>();
  /** Octets d'un littéral entrant restant à avaler. */
  private literalRemaining = 0;

  private constructor(
    socket: net.Socket | tls.TLSSocket,
    private readonly options: ImapOptions,
  ) {
    this.socket = socket;
    this.attach();
  }

  /** Ouvre la connexion, salue le serveur et s'authentifie. */
  static async connect(options: ImapOptions): Promise<ImapClient> {
    const socket = await openSocket(options);
    const client = new ImapClient(socket, options);

    try {
      await client.readGreeting();
      await client.refreshCapabilities();
      if (!options.secure && client.caps.has('STARTTLS')) await client.upgradeToTls();
      await client.login();
    } catch (err) {
      client.destroy();
      throw err;
    }
    return client;
  }

  // --- Commandes ------------------------------------------------------------

  /**
   * Dépose un message dans un dossier.
   *
   * Le littéral est envoyé en deux temps — annonce de la taille, puis les
   * octets une fois le `+` reçu. `LITERAL+` permettrait de tout envoyer d'un
   * coup, mais économiser un aller-retour par message ne vaut pas le risque
   * d'un serveur qui ne l'annonce que du bout des lèvres.
   */
  async append(folder: string, message: Buffer, options: AppendOptions = {}): Promise<string> {
    const box = encodeFolder(folder || 'INBOX');
    const flags = (options.flags ?? []).join(' ');
    const parts = [
      `APPEND ${quoted(box)}`,
      flags ? `(${flags})` : '',
      options.internalDate ? quoted(imapDate(options.internalDate)) : '',
      `{${message.length}}`,
    ].filter(Boolean);

    const run = () =>
      this.send(parts.join(' '), () => {
        this.socket.write(message);
        this.socket.write(CRLF);
      });

    try {
      return (await run()).text;
    } catch (err) {
      // `[TRYCREATE]` : le dossier n'existe pas encore. C'est le cas nominal la
      // première fois qu'on dépose ailleurs que dans INBOX.
      if (!(err instanceof Error) || !/\[TRYCREATE\]/i.test(err.message)) throw err;
      await this.send(`CREATE ${quoted(box)}`);
      return (await run()).text;
    }
  }

  /** Nombre de messages dans un dossier. Sert au test de connexion. */
  async count(folder: string): Promise<number> {
    const box = encodeFolder(folder || 'INBOX');
    const { untagged } = await this.send(`STATUS ${quoted(box)} (MESSAGES)`);
    for (const line of untagged) {
      const found = /MESSAGES\s+(\d+)/i.exec(line);
      if (found) return Number(found[1]);
    }
    return 0;
  }

  /** Ferme proprement la session. */
  async logout(): Promise<void> {
    if (this.closed) return;
    try {
      await this.send('LOGOUT');
    } catch {
      // Un LOGOUT raté n'annule rien : les APPEND sont déjà validés.
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
      this.waiter.reject(new Error('connexion IMAP fermée'));
      this.waiter = null;
    }
  }

  // --- Authentification -----------------------------------------------------

  private async login(): Promise<void> {
    await this.send(`LOGIN ${quoted(this.options.user)} ${quoted(this.options.pass)}`);
    // Le serveur réannonce ses capacités après authentification ; certaines
    // (dont la liste des dossiers spéciaux) n'apparaissent qu'à ce moment-là.
    await this.refreshCapabilities();
  }

  private async refreshCapabilities(): Promise<void> {
    const { untagged } = await this.send('CAPABILITY');
    this.caps = new Set(
      untagged
        .filter((l) => /^CAPABILITY\b/i.test(l))
        .flatMap((l) => l.split(/\s+/).slice(1))
        .map((c) => c.toUpperCase()),
    );
  }

  /** Bascule une connexion en clair vers TLS (RFC 2595). */
  private async upgradeToTls(): Promise<void> {
    await this.send('STARTTLS');
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
    this.literalRemaining = 0;
    this.attach();
    await this.refreshCapabilities();
  }

  // --- Plomberie ------------------------------------------------------------

  private attach(): void {
    this.socket.on('data', (chunk: Buffer) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      this.drain();
    });
    this.socket.on('error', (err: Error) => this.fail(err));
    this.socket.on('close', () => this.fail(new Error('connexion IMAP interrompue')));
  }

  private fail(err: Error): void {
    this.fatal = err;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(err);
      this.waiter = null;
    }
  }

  /** La bannière d'accueil est une ligne `* OK`, sans tag à attendre. */
  private readGreeting(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.destroy();
        reject(new Error(`délai IMAP dépassé (${this.options.timeoutMs} ms)`));
      }, this.options.timeoutMs);

      this.waiter = {
        tag: '',
        untagged: [],
        onContinue: null,
        timer,
        resolve: () => resolve(),
        reject,
      };
      this.drain();
    });
  }

  /**
   * Envoie une commande taguée et attend sa réponse.
   * `onContinue` est appelé si le serveur réclame la suite d'un littéral.
   */
  private send(command: string, onContinue?: () => void): Promise<Response> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.waiter) return Promise.reject(new Error('commande IMAP déjà en cours'));

    const tag = `a${++this.counter}`;
    const promise = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.destroy();
        reject(new Error(`délai IMAP dépassé (${this.options.timeoutMs} ms)`));
      }, this.options.timeoutMs);

      this.waiter = { tag, untagged: [], onContinue: onContinue ?? null, timer, resolve, reject };
    });

    this.socket.write(`${tag} ${command}\r\n`);
    // Le tampon peut déjà contenir une notification spontanée du serveur :
    // on la consomme tout de suite plutôt que d'attendre le prochain paquet.
    this.drain();
    return promise;
  }

  /** Consomme le tampon ligne par ligne, littéraux entrants avalés au passage. */
  private drain(): void {
    for (;;) {
      const w = this.waiter;
      if (!w) return;

      if (this.literalRemaining > 0) {
        const take = Math.min(this.literalRemaining, this.pending.length);
        this.pending = this.pending.subarray(take);
        this.literalRemaining -= take;
        if (this.literalRemaining > 0) return;
      }

      const eol = this.pending.indexOf(CRLF);
      if (eol === -1) return;

      const line = this.pending.subarray(0, eol).toString('utf8');
      this.pending = this.pending.subarray(eol + 2);

      // Une ligne peut se terminer par l'annonce d'un littéral : les octets qui
      // suivent sont des données, pas des lignes de protocole. On ne fait aucun
      // FETCH, donc leur contenu ne nous sert à rien — on les saute.
      const literal = /\{(\d+)\}$/.exec(line);
      if (literal) this.literalRemaining = Number(literal[1]);

      if (line.startsWith('+')) {
        // Le serveur attend la suite. Un `+` inattendu (par exemple sur une
        // commande refusée en cours de route) ne doit pas bloquer la session.
        if (w.onContinue) {
          const resume = w.onContinue;
          w.onContinue = null;
          resume();
        }
        continue;
      }

      if (line.startsWith('* ')) {
        w.untagged.push(line.slice(2));
        // La bannière d'accueil n'attend rien d'autre.
        if (!w.tag) {
          const greeting = /^\*\s+(OK|PREAUTH|BYE|NO|BAD)\b\s*(.*)$/i.exec(line);
          if (greeting) {
            const [, status, text] = greeting;
            this.finish(w, () =>
              /^(OK|PREAUTH)$/i.test(status)
                ? w.resolve({ untagged: w.untagged, status: status.toUpperCase(), text })
                : w.reject(new Error(text || 'connexion IMAP refusée')),
            );
          }
        }
        continue;
      }

      if (w.tag && line.startsWith(`${w.tag} `)) {
        const rest = line.slice(w.tag.length + 1);
        const found = /^(OK|NO|BAD)\s*(.*)$/i.exec(rest);
        const status = (found?.[1] ?? 'BAD').toUpperCase();
        const text = found?.[2] ?? rest;
        this.finish(w, () =>
          status === 'OK'
            ? w.resolve({ untagged: w.untagged, status, text })
            : w.reject(new Error(text || `commande IMAP refusée (${status})`)),
        );
      }
      // Tout le reste (réponse d'une commande abandonnée) est ignoré.
    }
  }

  private finish(w: Waiter, settle: () => void): void {
    clearTimeout(w.timer);
    this.waiter = null;
    settle();
  }
}

function openSocket(options: ImapOptions): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };

    const socket = options.secure
      ? tls.connect({
          host: options.host,
          port: options.port,
          servername: options.host,
          rejectUnauthorized: !options.allowInvalidCert,
        })
      : net.connect({ host: options.host, port: options.port });

    const ready = options.secure ? 'secureConnect' : 'connect';
    socket.setTimeout(options.timeoutMs, () => onError(new Error('délai de connexion IMAP dépassé')));
    socket.once('error', onError);
    socket.once(ready, () => {
      socket.setTimeout(0);
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/** Chaîne entre guillemets, au sens IMAP (RFC 3501 §4.3). */
export function quoted(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

/**
 * Nom de dossier en UTF-7 modifié (RFC 3501 §5.1.3).
 *
 * Sans ça, un dossier « Relevé » arrive sous un nom illisible — ou ne se crée
 * pas du tout. Les serveurs qui parlent UTF-8 acceptent aussi cette forme.
 */
export function encodeFolder(name: string): string {
  let out = '';
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    // Base64 de l'UTF-16BE, sans remplissage, avec ',' à la place de '/'.
    const utf16 = Buffer.from(buffer, 'utf16le').swap16();
    out += '&' + utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
    buffer = '';
  };

  for (const char of name) {
    const code = char.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += char === '&' ? '&-' : char;
    } else {
      buffer += char;
    }
  }
  flush();
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Date au format INTERNALDATE : `22-Aug-2026 23:38:00 +0200`. */
export function imapDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);

  return (
    `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}
