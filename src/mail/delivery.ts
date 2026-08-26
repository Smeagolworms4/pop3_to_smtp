import { env } from '../env';
import type { Target } from '../types';
import { encodeWord, makeMessageId, rfc2822Date } from './headers';
import { ImapClient } from './imap';
import type { RewriteResult } from './rewrite';
import { SmtpService } from './smtp.service';

/**
 * Deux façons de faire arriver un message dans la boîte : l'envoyer par SMTP,
 * ou le déposer par IMAP. Le reste du programme n'a pas à savoir laquelle est
 * en jeu — il ouvre un canal, remet ses messages, referme.
 *
 * Le canal reste ouvert le temps d'une relève : les serveurs n'apprécient ni
 * qu'on ouvre une session par message, ni qu'on laisse traîner une socket
 * entre deux passages.
 */
export interface DeliveryChannel {
  /** Remet un message. Rend la réponse du serveur, pour le journal. */
  deliver(message: RewriteResult): Promise<string>;
  close(): void;
}

export async function openChannel(
  target: Target,
  smtp: SmtpService,
): Promise<DeliveryChannel> {
  if (target.kind !== 'imap') {
    const transport = smtp.createTransport(target);
    return {
      deliver: (message) => smtp.sendRaw(transport, message),
      close: () => transport.close(),
    };
  }

  const client = await ImapClient.connect(imapOptions(target));
  return {
    deliver: (message) =>
      client.append(target.folder, message.message, {
        flags: target.markRead ? ['\\Seen'] : [],
        // Sans date interne, tout ce qu'on dépose se retrouverait daté de la
        // relève : une boîte relevée d'un coup arriverait à plat, dans le
        // désordre. On reprend donc celle du message.
        internalDate: parseDate(message.info.date),
      }),
    close: () => void client.logout().catch(() => undefined),
  };
}

/** Vérifie que la destination répond et accepte l'authentification. */
export async function verifyTarget(target: Target, smtp: SmtpService): Promise<string> {
  if (target.kind !== 'imap') return smtp.verify(target);

  const client = await ImapClient.connect(imapOptions(target));
  try {
    const folder = target.folder || 'INBOX';
    const count = await client.count(folder);
    return `connexion établie sur ${target.host}:${target.port} — ${count} message(s) dans ${folder}`;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * Dépose une alerte dans la boîte, en mode IMAP. Le SMTP a `sendText` pour ça ;
 * ici il faut fabriquer le message nous-mêmes, personne d'autre ne le fera.
 */
export async function appendNotice(
  target: Target,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const from = target.from.trim() || (target.user.includes('@') ? target.user.trim() : to);
  const body = Buffer.from(
    [
      `From: ${encodeWord('pop3-to-smtp')} <${from}>`,
      `To: <${to}>`,
      `Subject: ${encodeWord(subject)}`,
      `Date: ${rfc2822Date()}`,
      `Message-ID: ${makeMessageId()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      '',
    ].join('\r\n'),
    'utf8',
  );

  const client = await ImapClient.connect(imapOptions(target));
  try {
    await client.append(target.folder, body);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function imapOptions(target: Target) {
  return {
    host: target.host.trim(),
    port: target.port,
    secure: target.secure,
    user: target.user,
    pass: target.pass,
    timeoutMs: env.imapTimeout,
    allowInvalidCert: target.allowInvalidCert,
  };
}

/** En-tête `Date:` du message → objet Date, si tant est qu'il soit lisible. */
function parseDate(raw: string): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
