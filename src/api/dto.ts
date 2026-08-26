import { randomUUID } from 'node:crypto';
import type {
  AppConfig,
  HeaderMode,
  NotifyEvent,
  NotifySettings,
  Pop3Security,
  Settings,
  Source,
  Target,
  TargetKind,
} from '../types';

/**
 * Ce que l'interface reçoit à la place d'un mot de passe enregistré. Renvoyé
 * tel quel lors d'un enregistrement, il signifie « ne change pas celui-ci » :
 * les secrets ne repartent donc jamais vers le navigateur.
 */
export const MASK = '••••••••';

type Raw = Record<string, unknown>;

const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v.trim() : def);
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

const int = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def;

/**
 * Réglage propre à une boîte, qui peut aussi « suivre le réglage global ».
 * `null` ou chaîne vide expriment cet héritage ; absent = on ne touche à rien.
 */
const inherited = (v: unknown, previous: number | null, min: number, max: number): number | null => {
  if (v === undefined) return previous;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return previous;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Garde le secret déjà enregistré quand l'interface renvoie le masque. */
const secret = (v: unknown, previous: string): string => {
  if (typeof v !== 'string') return previous;
  return v === MASK ? previous : v;
};

const HEADER_MODES = ['auto', 'redirect', 'gmail-safe'] as const satisfies readonly HeaderMode[];
const TARGET_KINDS = ['smtp', 'imap'] as const satisfies readonly TargetKind[];
const ENVELOPE_FROM = ['auto', 'original', 'smtp'] as const;
const SECURITIES = ['tls', 'starttls', 'none'] as const satisfies readonly Pop3Security[];
const EVENTS = ['error', 'forward', 'run'] as const satisfies readonly NotifyEvent[];

export function normalizeTarget(input: Raw, previous?: Target): Target {
  const kind = oneOf(input.kind, TARGET_KINDS, previous?.kind ?? 'smtp');
  // Le dépôt IMAP se fait presque toujours en TLS direct : c'est le réglage
  // sensé par défaut, mais jamais celui qu'on impose à une destination
  // existante qui marchait autrement.
  const secure = bool(input.secure, previous?.secure ?? kind === 'imap');
  const defaultPort = kind === 'imap' ? (secure ? 993 : 143) : secure ? 465 : 587;
  return {
    id: previous?.id ?? randomUUID(),
    name: str(input.name, previous?.name ?? '') || 'Destination',
    enabled: bool(input.enabled, previous?.enabled ?? true),
    kind,
    host: str(input.host, previous?.host ?? ''),
    port: int(input.port, previous?.port ?? defaultPort, 1, 65535),
    secure,
    user: str(input.user, previous?.user ?? ''),
    pass: secret(input.pass, previous?.pass ?? ''),
    to: str(input.to, previous?.to ?? ''),
    folder: str(input.folder, previous?.folder ?? '') || 'INBOX',
    markRead: bool(input.markRead, previous?.markRead ?? false),
    from: str(input.from, previous?.from ?? ''),
    headerMode: oneOf(input.headerMode, HEADER_MODES, previous?.headerMode ?? 'auto'),
    envelopeFrom: oneOf(input.envelopeFrom, ENVELOPE_FROM, previous?.envelopeFrom ?? 'auto'),
    newMessageId: bool(input.newMessageId, previous?.newMessageId ?? false),
    allowInvalidCert: bool(input.allowInvalidCert, previous?.allowInvalidCert ?? false),
  };
}

export function normalizeSource(input: Raw, previous?: Source): Source {
  const security = oneOf(input.security, SECURITIES, previous?.security ?? 'tls');
  return {
    id: previous?.id ?? randomUUID(),
    name: str(input.name, previous?.name ?? '') || 'Boîte POP3',
    enabled: bool(input.enabled, previous?.enabled ?? true),
    host: str(input.host, previous?.host ?? ''),
    port: int(input.port, previous?.port ?? (security === 'tls' ? 995 : 110), 1, 65535),
    security,
    user: str(input.user, previous?.user ?? ''),
    pass: secret(input.pass, previous?.pass ?? ''),
    targetId: str(input.targetId, previous?.targetId ?? ''),
    refreshMinutes: inherited(input.refreshMinutes, previous?.refreshMinutes ?? null, 0, 10_080),
    maxPerRun: inherited(input.maxPerRun, previous?.maxPerRun ?? null, 0, 100_000),
    deleteAfterFetch: bool(input.deleteAfterFetch, previous?.deleteAfterFetch ?? false),
    allowInvalidCert: bool(input.allowInvalidCert, previous?.allowInvalidCert ?? false),
  };
}

export function normalizeSettings(input: Raw, previous: Settings): Settings {
  return {
    refreshMinutes: int(input.refreshMinutes, previous.refreshMinutes, 0, 10_080),
    runOnStart: bool(input.runOnStart, previous.runOnStart),
    // 0 = pas de plafond : on traite tout ce que la boîte contient.
    maxPerRun: int(input.maxPerRun, previous.maxPerRun, 0, 100_000),
    maxSizeMb: int(input.maxSizeMb, previous.maxSizeMb, 0, 200),
    historyMax: int(input.historyMax, previous.historyMax, 10, 5_000),
  };
}

export function normalizeNotify(input: Raw, previous: NotifySettings): NotifySettings {
  const events = Array.isArray(input.events)
    ? (input.events.filter((e) => EVENTS.includes(e as NotifyEvent)) as NotifyEvent[])
    : previous.events;

  return {
    events,
    emailTargetId: str(input.emailTargetId, previous.emailTargetId),
    emailTo: str(input.emailTo, previous.emailTo),
    ntfyServer: str(input.ntfyServer, previous.ntfyServer) || 'https://ntfy.sh',
    ntfyTopic: str(input.ntfyTopic, previous.ntfyTopic),
    webhookUrl: str(input.webhookUrl, previous.webhookUrl),
    webhookMethod: str(input.webhookMethod, previous.webhookMethod) || 'POST',
    webhookContentType: str(input.webhookContentType, previous.webhookContentType) || 'application/json',
    webhookTemplate: str(input.webhookTemplate, previous.webhookTemplate),
    freeMobileUser: str(input.freeMobileUser, previous.freeMobileUser),
    freeMobilePass: secret(input.freeMobilePass, previous.freeMobilePass),
  };
}

export const maskTarget = (t: Target): Target => ({ ...t, pass: t.pass ? MASK : '' });
export const maskSource = (s: Source): Source => ({ ...s, pass: s.pass ? MASK : '' });

/** Copie de la configuration sans aucun secret en clair. */
export function maskConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    targets: config.targets.map(maskTarget),
    sources: config.sources.map(maskSource),
    notify: {
      ...config.notify,
      freeMobilePass: config.notify.freeMobilePass ? MASK : '',
    },
  };
}
