import { env } from './env';

export interface LogLine {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = LEVELS[(env.logLevel as keyof typeof LEVELS) ?? 'info'] ?? LEVELS.info;

/** Tampon circulaire : l'interface affiche le journal sans écrire de fichier. */
const RING_SIZE = 500;
const ring: LogLine[] = [];

export function recentLogs(limit = RING_SIZE): LogLine[] {
  return ring.slice(-limit);
}

function emit(level: LogLine['level'], scope: string, args: unknown[]): void {
  const message = args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line: LogLine = { ts: new Date().toISOString(), level, scope, message };

  ring.push(line);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  if (LEVELS[level] < threshold) return;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${line.ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}\n`);
}

export function makeLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => emit('debug', scope, a),
    info: (...a: unknown[]) => emit('info', scope, a),
    warn: (...a: unknown[]) => emit('warn', scope, a),
    error: (...a: unknown[]) => emit('error', scope, a),
  };
}
