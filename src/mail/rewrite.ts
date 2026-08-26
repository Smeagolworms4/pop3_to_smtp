import {
  buildMessage,
  decodeWords,
  formatAddress,
  getHeader,
  hasHeader,
  makeMessageId,
  parseAddress,
  prependHeaders,
  removeHeaders,
  removeHeadersByPrefix,
  rfc2822Date,
  setHeader,
  splitMessage,
} from './headers';
import type { HeaderMode, Source, Target } from '../types';

export interface RewriteResult {
  /** Message prêt à être remis au SMTP, tel quel. */
  message: Buffer;
  /** MAIL FROM de l'enveloppe. */
  envelopeFrom: string;
  /** RCPT TO de l'enveloppe. */
  envelopeTo: string;
  /** Mode réellement appliqué (utile quand le réglage vaut `auto`). */
  mode: Exclude<HeaderMode, 'auto'>;
  /** Pour l'historique et l'interface. */
  info: { from: string; fromAddress: string; subject: string; date: string };
}

/**
 * En-têtes d'authentification qui ne survivent pas à une réécriture du `From:`.
 * Les laisser en place, c'est livrer un message avec une signature qui ne
 * vérifie plus : Gmail le compte comme un signal négatif. On préfère un message
 * non signé à un message mal signé.
 */
const BROKEN_BY_REWRITE = [
  'DKIM-Signature',
  'X-Google-DKIM-Signature',
  'Authentication-Results',
  'ARC-Seal',
  'ARC-Message-Signature',
  'ARC-Authentication-Results',
];

const GMAIL_HOSTS = /(^|\.)(gmail|googlemail)\.com$|(^|\.)smtp\.google\.com$/i;

/**
 * Gmail en soumission (smtp.gmail.com) réécrit le `From:` dès qu'il ne
 * correspond pas au compte authentifié : garder l'expéditeur d'origine est
 * impossible, autant le faire nous-mêmes proprement plutôt que de le subir.
 *
 * Un dépôt IMAP — comme un import par l'API Gmail — échappe à tout ça : rien
 * n'est envoyé, donc rien ne peut être réécrit. Le réglage est alors sans objet
 * et le message reste intact.
 */
export function resolveHeaderMode(target: Target): Exclude<HeaderMode, 'auto'> {
  if (target.kind === 'imap' || target.kind === 'gmail-api') return 'redirect';
  if (target.headerMode === 'redirect' || target.headerMode === 'gmail-safe') return target.headerMode;
  return GMAIL_HOSTS.test(target.host.trim()) ? 'gmail-safe' : 'redirect';
}

/**
 * Adresse de la boîte d'arrivée, telle qu'elle apparaît dans les en-têtes de
 * traçage. En dépôt IMAP, `to` est facultatif : l'identifiant du compte fait
 * tout aussi bien l'affaire, et vaut mieux qu'un `<>` vide.
 */
function deliveryAddress(target: Target): string {
  const to = target.to.trim();
  if (to) return to;
  const user = target.user.trim();
  return target.kind !== 'smtp' && user.includes('@') ? user : '';
}

/**
 * Prépare un message relevé en POP3 pour son renvoi en SMTP.
 *
 * En mode `redirect`, le message ressort **identique** : seuls des en-têtes de
 * traçage sont ajoutés au-dessus, exactement comme le ferait un serveur de
 * redirection. C'est le mode d'un dépôt IMAP ou d'un import Gmail, où personne
 * n'a rien à imposer. En mode `gmail-safe`, le `From:` est réécrit (Gmail l'imposerait
 * de toute façon) mais le `Reply-To:` pointe sur l'expéditeur d'origine, donc
 * « Répondre » écrit bien à la bonne personne.
 */
export function rewriteMessage(raw: Buffer, source: Source, target: Target): RewriteResult {
  const parts = splitMessage(raw);
  const { eol } = parts;
  let head = parts.head;

  const originalFromRaw = getHeader(head, 'From', eol) ?? '';
  const originalFrom = parseAddress(originalFromRaw);
  const subject = decodeWords(getHeader(head, 'Subject', eol) ?? '');
  const date = getHeader(head, 'Date', eol) ?? '';

  const mode = resolveHeaderMode(target);
  const smtpIdentity = senderIdentity(target);
  const destination = deliveryAddress(target);
  const sourceLabel = source.user || source.name || source.host;

  // Le Return-Path est posé par le serveur qui délivre : celui du message
  // d'origine n'a plus de sens ici et perturbe la lecture des en-têtes.
  head = removeHeaders(head, ['Return-Path', 'Bcc', 'Resent-Bcc'], eol);

  if (mode === 'gmail-safe') {
    head = removeHeaders(head, BROKEN_BY_REWRITE, eol);
    head = removeHeadersByPrefix(head, ['ARC-'], eol);

    // « Répondre » doit atteindre l'expéditeur d'origine, pas la boîte relais.
    if (originalFrom && !hasHeader(head, 'Reply-To', eol)) {
      head = prependHeaders(head, [['Reply-To', originalFromRaw]], eol);
    }

    if (smtpIdentity) {
      const shownName = originalFrom
        ? `${originalFrom.name || originalFrom.address} (via ${sourceLabel})`
        : `via ${sourceLabel}`;
      head = setHeader(head, 'From', formatAddress({ name: shownName, address: smtpIdentity }), eol);
    }
    if (originalFromRaw) {
      head = prependHeaders(head, [['X-Original-From', originalFromRaw]], eol);
    }
  }

  if (target.newMessageId) {
    const previous = getHeader(head, 'Message-ID', eol);
    head = setHeader(head, 'Message-ID', makeMessageId(), eol);
    if (previous) head = prependHeaders(head, [['X-Original-Message-ID', previous]], eol);
  }

  // Traces de la redirection, dans l'ordre où un MTA les empilerait. Elles
  // s'ajoutent *au-dessus* des en-têtes existants : aucune signature DKIM n'en
  // souffre, y compris en dépôt IMAP où le message doit rester vérifiable.
  const trace: Array<[string, string]> = [];
  if (destination) trace.push(['Delivered-To', destination]);
  trace.push([
    'Received',
    `from ${source.host} by pop3-to-smtp with POP3` +
      (destination ? ` for <${destination}>` : '') +
      `; ${rfc2822Date()}`,
  ]);
  if (destination) {
    trace.push(['X-Forwarded-To', destination]);
    trace.push(['X-Forwarded-For', `${originalFrom?.address || sourceLabel} ${destination}`]);
  }
  trace.push(['X-POP3-To-SMTP-Source', sourceLabel]);
  head = prependHeaders(head, trace, eol);

  const envelopeFrom = pickEnvelopeFrom(target, mode, originalFrom?.address, smtpIdentity);

  return {
    message: buildMessage({ head, body: parts.body, eol }),
    envelopeFrom,
    envelopeTo: destination,
    mode,
    info: {
      from: originalFrom ? decodeWords(originalFromRaw) : '',
      fromAddress: originalFrom?.address ?? '',
      subject,
      date,
    },
  };
}

/**
 * Adresse sous laquelle le relais s'exprime.
 *
 * On prend le premier candidat qui ressemble vraiment à une adresse. C'est
 * indispensable parce que beaucoup de serveurs — Gmail le premier — acceptent
 * de s'authentifier avec un identifiant nu (`jean` plutôt que
 * `jean@gmail.com`) : le reprendre tel quel fabriquerait un `From:` et un
 * MAIL FROM syntaxiquement invalides, que le serveur d'en face rejetterait.
 * L'adresse de dépôt sert de dernier recours : sur un compte personnel, c'est
 * presque toujours la même boîte.
 */
function senderIdentity(target: Target): string {
  const candidates = [target.from, target.user, target.to].map((v) => (v ?? '').trim());
  return candidates.find((v) => v.includes('@')) ?? '';
}

/**
 * Le MAIL FROM décide où repartent les rapports de non-remise, et c'est lui que
 * regarde SPF. Sur un relais authentifié (Gmail, FAI, service transactionnel),
 * seule l'adresse du compte est acceptée ; sur un relais qu'on héberge, garder
 * l'expéditeur d'origine reproduit le comportement d'une vraie redirection.
 */
function pickEnvelopeFrom(
  target: Target,
  mode: Exclude<HeaderMode, 'auto'>,
  originalAddress: string | undefined,
  smtpIdentity: string,
): string {
  if (target.envelopeFrom === 'smtp') return smtpIdentity;
  if (target.envelopeFrom === 'original') return originalAddress || smtpIdentity;
  return mode === 'gmail-safe' ? smtpIdentity : originalAddress || smtpIdentity;
}
