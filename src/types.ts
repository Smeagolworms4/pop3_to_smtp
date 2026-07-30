/**
 * Modèle de données persisté dans data/config.json et data/state.json.
 *
 * Tout ce qui est modifiable depuis l'interface vit ici : le .env ne sert qu'à
 * fournir des valeurs par défaut (et à verrouiller ce qu'on veut figer).
 */

import type { Pop3Security } from './mail/pop3';

export type { Pop3Security };

/** Comment réécrire les en-têtes avant de renvoyer le message. */
export type HeaderMode = 'auto' | 'redirect' | 'gmail-safe';

/** Ce qu'on met dans le MAIL FROM de l'enveloppe SMTP. */
export type EnvelopeFrom = 'auto' | 'original' | 'smtp';

/** Une destination : un serveur SMTP + l'adresse où déposer les messages. */
export interface Target {
  id: string;
  name: string;
  enabled: boolean;
  /** Serveur de sortie. */
  host: string;
  port: number;
  /** true = TLS direct (465), false = STARTTLS (587/25). */
  secure: boolean;
  user: string;
  pass: string;
  /** Adresse de dépôt : le « vers » de la redirection. */
  to: string;
  /**
   * Adresse affichée en From quand on est obligé de la réécrire (mode
   * gmail-safe). Vide = on prend `user`.
   */
  from: string;
  headerMode: HeaderMode;
  envelopeFrom: EnvelopeFrom;
  /**
   * Regénérer le Message-ID. Par défaut on garde celui d'origine : c'est ce qui
   * permet aux réponses de se raccrocher à la bonne conversation.
   */
  newMessageId: boolean;
  /** Ne pas vérifier le certificat du serveur (auto-signé). */
  allowInvalidCert: boolean;
}

/** Une source : une boîte POP3 relevée périodiquement. */
export interface Source {
  id: string;
  name: string;
  enabled: boolean;
  host: string;
  port: number;
  /**
   * `tls` = chiffré d'emblée (995, le cas normal), `starttls` = clair puis
   * bascule (110), `none` = clair de bout en bout (à éviter).
   */
  security: Pop3Security;
  user: string;
  pass: string;
  /** Destination vers laquelle renvoyer ce que contient cette boîte. */
  targetId: string;
  /** true = déplacement (DELE après envoi). false = copie (on laisse sur le serveur). */
  deleteAfterFetch: boolean;
  /** Ne pas vérifier le certificat du serveur (auto-signé). */
  allowInvalidCert: boolean;
}

export type NotifyEvent = 'error' | 'forward' | 'run';

export interface NotifySettings {
  /** Catégories actives. `error` seule par défaut. */
  events: NotifyEvent[];
  /** Notification par mail : on réutilise le SMTP d'une destination. */
  emailTargetId: string;
  /** Destinataire de l'alerte (vide = le `to` de la destination choisie). */
  emailTo: string;
  ntfyServer: string;
  ntfyTopic: string;
  webhookUrl: string;
  webhookMethod: string;
  webhookContentType: string;
  /** Gabarit du corps ; {{title}} et {{text}} sont remplacés. */
  webhookTemplate: string;
  /** SMS via l'API Free Mobile (FR). */
  freeMobileUser: string;
  freeMobilePass: string;
}

export interface Settings {
  /** Délai entre deux relèves, en minutes. 0 = automatique désactivé. */
  refreshMinutes: number;
  /** Relever une première fois au démarrage du conteneur. */
  runOnStart: boolean;
  /** Nombre maximum de messages traités par boîte et par passage. */
  maxPerRun: number;
  /** Messages plus gros que ça : ignorés (Mo). */
  maxSizeMb: number;
  /** Nombre d'actions gardées dans l'historique. */
  historyMax: number;
}

export interface AppConfig {
  version: number;
  settings: Settings;
  targets: Target[];
  sources: Source[];
  notify: NotifySettings;
}

/** Résultat, par message, d'une relève. */
export interface MessageResult {
  uid: string;
  from: string;
  subject: string;
  date: string;
  size: number;
  status: 'forwarded' | 'skipped' | 'error';
  error?: string;
}

/** Une entrée d'historique = une relève d'une boîte (ou une erreur globale). */
export interface HistoryEntry {
  id: string;
  at: string;
  finishedAt?: string;
  durationMs: number;
  sourceId: string;
  sourceName: string;
  targetName: string;
  /** `manual` quand la relève a été forcée depuis l'interface. */
  trigger: 'schedule' | 'manual' | 'startup';
  status: 'ok' | 'partial' | 'error';
  total: number;
  forwarded: number;
  skipped: number;
  deleted: number;
  error?: string;
  messages: MessageResult[];
}

export interface RunState {
  version: number;
  /** UIDs déjà traités, par source : { sourceId: { uid: timestamp } } */
  seen: Record<string, Record<string, number>>;
  lastRun: HistoryEntry | null;
  history: HistoryEntry[];
}
