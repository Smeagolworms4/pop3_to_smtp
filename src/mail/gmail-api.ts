import type { Target } from '../types';

/**
 * Import par l'API Gmail.
 *
 * Le dépôt IMAP range le message dans un dossier, point final : ni filtres, ni
 * catégories, ni antispam. `users.messages.import` fait autre chose — Google le
 * décrit comme « standard email delivery scanning and classification similar to
 * receiving via SMTP » : le message traverse la chaîne de livraison, donc les
 * règles de tri s'appliquent, exactement comme s'il était arrivé par SMTP.
 *
 * Et comme rien n'est réexpédié, le `From:` d'origine reste en place : c'est le
 * dépôt IMAP avec les filtres en plus. Le prix à payer est OAuth, là où l'IMAP
 * se contentait d'un mot de passe d'application.
 *
 * Les URL sont relues à chaque appel depuis l'environnement : c'est ce qui
 * permet aux tests de tourner contre un faux Google plutôt que contre le vrai.
 */

const authUrl = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const uploadUrl = () =>
  process.env.GMAIL_UPLOAD_URL ||
  'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/import';

/**
 * Le seul droit demandé : insérer. Pas de lecture de la boîte, pas d'envoi —
 * si le jeton fuit, il ne permet rien d'autre que d'y ajouter des messages.
 */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.insert';

const HTTP_TIMEOUT = 30_000;

/**
 * Jetons d'accès en cours de validité, par destination.
 *
 * Un jeton vaut une heure ; le regénérer à chaque message serait un appel réseau
 * de plus pour rien. Le cache vit en mémoire : un redémarrage le perd, et c'est
 * sans conséquence puisqu'il se rachète avec le jeton de rafraîchissement.
 */
const tokens = new Map<string, { value: string; expiresAt: number }>();

/** URL vers laquelle envoyer l'utilisateur pour qu'il autorise l'accès. */
export function authorizationUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    // `offline` pour obtenir un jeton de rafraîchissement, `consent` pour que
    // Google le redonne même si l'utilisateur avait déjà autorisé l'appli — sans
    // quoi une seconde autorisation revient les mains vides.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${authUrl()}?${params.toString()}`;
}

/** Échange le code reçu au retour d'autorisation contre un jeton durable. */
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const data = await postForm(tokenUrl(), body);
  if (!data.refresh_token) {
    throw new Error(
      'Google n’a pas renvoyé de jeton de rafraîchissement. Retirez l’accès de l’application ' +
        'dans votre compte Google, puis recommencez.',
    );
  }
  return String(data.refresh_token);
}

/** Jeton d'accès valide, repris du cache ou racheté au besoin. */
export async function accessToken(target: Target): Promise<string> {
  const cached = tokens.get(target.id);
  // Une minute de marge : un jeton qui expire pendant l'appel ne sert à rien.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  if (!target.oauthRefreshToken) {
    throw new Error('compte Google non connecté : autorisez l’accès depuis l’interface');
  }

  const body = new URLSearchParams({
    client_id: target.oauthClientId,
    client_secret: target.oauthClientSecret,
    refresh_token: target.oauthRefreshToken,
    grant_type: 'refresh_token',
  });

  let data: Record<string, unknown>;
  try {
    data = await postForm(tokenUrl(), body);
  } catch (err) {
    // `invalid_grant` = le jeton n'est plus valable. Le dire franchement, parce
    // que la seule issue est de recliquer sur « Connecter » : mot de passe
    // Google changé, accès révoqué, ou écran de consentement resté en « Test »
    // (Google y fait expirer le jeton au bout de sept jours).
    if (err instanceof Error && /invalid_grant/i.test(err.message)) {
      throw new Error(
        'autorisation Google expirée ou révoquée : reconnectez le compte depuis l’interface ' +
          '(mot de passe changé, accès retiré, ou écran de consentement resté en « Test »)',
      );
    }
    throw err;
  }

  const value = String(data.access_token ?? '');
  if (!value) throw new Error('Google n’a pas renvoyé de jeton d’accès');

  const ttl = Number(data.expires_in) || 3600;
  tokens.set(target.id, { value, expiresAt: Date.now() + ttl * 1000 });
  return value;
}

/** Oublie le jeton en cache d'une destination (identifiants modifiés, suppression). */
export function forgetToken(targetId: string): void {
  tokens.delete(targetId);
}

/**
 * Importe un message brut avec ses métadonnées dans une requête multipart.
 *
 * Gmail ne met pas automatiquement les messages importés dans INBOX et ne les
 * marque pas UNREAD. Les labels sont donc déclarés dans la partie JSON, tandis
 * que la partie `message/rfc822` conserve le message original octet pour octet.
 */
export async function importMessage(target: Target, message: Buffer): Promise<string> {
  const token = await accessToken(target);
  const params = new URLSearchParams({
    uploadType: 'multipart',
    // La date du message plutôt que celle de l'import : une boîte relevée d'un
    // coup se range dans l'ordre où les messages sont arrivés.
    internalDateSource: 'dateHeader',
    neverMarkSpam: target.neverMarkSpam ? 'true' : 'false',
  });

  const boundary = `formail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const labels = target.markRead ? ['INBOX'] : ['INBOX', 'UNREAD'];
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify({ labelIds: labels }) +
        `\r\n--${boundary}\r\n` +
        'Content-Type: message/rfc822\r\n\r\n',
      'utf8',
    ),
    message,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const response = await fetchWithTimeout(`${uploadUrl()}?${params.toString()}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary="${boundary}"`,
    },
    body: new Uint8Array(body),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(describeError(response.status, text));

  const id = safeParse(text)?.id;
  return id ? `importé (${id})` : 'importé';
}

/**
 * Vérifie ce qui peut l'être sans toucher à la boîte : obtenir un jeton prouve
 * que les identifiants du client et l'autorisation tiennent toujours. Le droit
 * demandé ne permet pas de lire le profil, donc on ne va pas plus loin.
 */
export async function verifyAccess(target: Target): Promise<string> {
  await accessToken(target);
  return 'compte Google connecté, autorisation valide';
}

// --- Plomberie HTTP ---------------------------------------------------------

async function postForm(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(describeError(response.status, text));
  return safeParse(text) ?? {};
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HTTP_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Google n’a pas répondu en ${HTTP_TIMEOUT / 1000} s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Le message d'erreur de Google est bien plus parlant que son code HTTP. */
function describeError(status: number, text: string): string {
  const parsed = safeParse(text);
  const detail =
    (parsed?.error as { message?: string } | undefined)?.message ??
    (typeof parsed?.error === 'string'
      ? [parsed.error, parsed.error_description].filter(Boolean).join(' : ')
      : '') ??
    '';
  return detail ? `${detail} (HTTP ${status})` : `Google a répondu HTTP ${status}`;
}

function safeParse(text: string): Record<string, any> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
