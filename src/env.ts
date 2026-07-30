import 'dotenv/config';
import * as path from 'node:path';
import type { Settings } from './types';

const bool = (v: string | undefined, def: boolean): boolean => {
  if (v === undefined || v.trim() === '') return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase());
};

const num = (v: string | undefined, def: number): number => {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const dataDir = process.env.DATA_DIR || path.resolve('data');

export const env = {
  dataDir,
  configFile: path.join(dataDir, 'config.json'),
  stateFile: path.join(dataDir, 'state.json'),

  webPort: num(process.env.WEB_PORT, 8080),
  /** Auth basique de l'interface. Vide = pas d'authentification. */
  webUser: process.env.WEB_USER || '',
  webPassword: process.env.WEB_PASSWORD || '',

  /** Valeurs par défaut des réglages, surchargeables depuis l'interface. */
  defaults: {
    refreshMinutes: num(process.env.REFRESH_MINUTES, 10),
    runOnStart: bool(process.env.RUN_ON_START, true),
    maxPerRun: num(process.env.MAX_PER_RUN, 50),
    maxSizeMb: num(process.env.MAX_SIZE_MB, 25),
    historyMax: num(process.env.HISTORY_MAX, 200),
  } satisfies Settings,

  /** Délais réseau, en millisecondes. */
  pop3Timeout: num(process.env.POP3_TIMEOUT, 60_000),
  smtpTimeout: num(process.env.SMTP_TIMEOUT, 60_000),

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

/**
 * Réglage → variable d'environnement correspondante. Une variable renseignée
 * dans le .env verrouille le réglage : l'interface l'affiche grisé plutôt que
 * de laisser croire qu'on peut le changer.
 */
export const SETTINGS_ENV_KEYS: Record<keyof Settings, string> = {
  refreshMinutes: 'REFRESH_MINUTES',
  runOnStart: 'RUN_ON_START',
  maxPerRun: 'MAX_PER_RUN',
  maxSizeMb: 'MAX_SIZE_MB',
  historyMax: 'HISTORY_MAX',
};

const isSet = (name: string): boolean => {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '';
};

/** { réglage: 'NOM_DE_VARIABLE' } pour tout ce que le .env impose. */
export function forcedSettings(): Partial<Record<keyof Settings, string>> {
  const forced: Partial<Record<keyof Settings, string>> = {};
  for (const [key, name] of Object.entries(SETTINGS_ENV_KEYS)) {
    if (isSet(name)) forced[key as keyof Settings] = name;
  }
  return forced;
}
