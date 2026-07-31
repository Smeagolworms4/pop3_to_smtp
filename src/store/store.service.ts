import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env, forcedSettings } from '../env';
import { makeLogger } from '../logger';
import type { AppConfig, HistoryEntry, RunState, Settings, Source, Target } from '../types';

const log = makeLogger('store');

/**
 * Persistance : deux fichiers JSON dans le volume `data`.
 *
 * - `config.json` : ce que l'utilisateur a réglé (boîtes, destinations, préfs).
 * - `state.json`  : ce que le programme a retenu (UIDs déjà traités, historique).
 *
 * Séparer les deux évite qu'un historique volumineux mette la configuration en
 * danger à chaque écriture, et permet de sauvegarder l'un sans l'autre.
 */
@Injectable()
export class StoreService implements OnModuleInit {
  private config: AppConfig = defaultConfig();
  private state: RunState = defaultState();
  /** Les écritures se suivent : jamais deux `rename` concurrents sur un fichier. */
  private queue: Promise<unknown> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    await fs.mkdir(env.dataDir, { recursive: true });
    this.config = await readJson(env.configFile, defaultConfig());
    this.state = await readJson(env.stateFile, defaultState());
    this.applyForcedSettings();
    await this.persistConfig();
    log.info(
      `configuration chargée : ${this.config.sources.length} boîte(s), ${this.config.targets.length} destination(s)`,
    );
  }

  /**
   * Une variable renseignée dans le .env a le dernier mot : elle écrase ce que
   * l'interface aurait enregistré, et le réglage s'affiche verrouillé.
   */
  private applyForcedSettings(): void {
    const forced = forcedSettings();
    for (const key of Object.keys(forced) as Array<keyof Settings>) {
      (this.config.settings[key] as unknown) = env.defaults[key];
    }
  }

  // --- Configuration --------------------------------------------------------

  getConfig(): AppConfig {
    return this.config;
  }

  getSettings(): Settings {
    return this.config.settings;
  }

  getSource(id: string): Source | undefined {
    return this.config.sources.find((s) => s.id === id);
  }

  getTarget(id: string): Target | undefined {
    return this.config.targets.find((t) => t.id === id);
  }

  /** Applique une modification puis écrit sur disque. */
  async updateConfig<T>(mutate: (config: AppConfig) => T): Promise<T> {
    const result = mutate(this.config);
    this.applyForcedSettings();
    await this.persistConfig();
    return result;
  }

  private persistConfig(): Promise<void> {
    return this.write(env.configFile, this.config);
  }

  // --- État d'exécution -----------------------------------------------------

  getState(): RunState {
    return this.state;
  }

  /** UIDs déjà traités pour cette boîte. */
  seenUids(sourceId: string): Set<string> {
    return new Set(Object.keys(this.state.seen[sourceId] ?? {}));
  }

  markSeen(sourceId: string, uid: string): void {
    (this.state.seen[sourceId] ??= {})[uid] = Date.now();
  }

  /**
   * Oublie les UIDs qui ne sont plus sur le serveur : sans ça le fichier
   * grossit indéfiniment sur une boîte en mode « déplacement ».
   */
  pruneSeen(sourceId: string, presentUids: Set<string>): void {
    const seen = this.state.seen[sourceId];
    if (!seen) return;
    for (const uid of Object.keys(seen)) {
      if (!presentUids.has(uid)) delete seen[uid];
    }
  }

  forgetSource(sourceId: string): void {
    delete this.state.seen[sourceId];
  }

  pushHistory(entry: HistoryEntry): void {
    this.state.lastRun = entry;
    this.state.history.unshift(entry);
    this.pruneHistory();
  }

  /**
   * Conserve les dernières actions **de chaque boîte**, et non les dernières
   * tout court : sans ça, une boîte relevée toutes les 5 minutes efface à elle
   * seule l'historique d'une boîte relevée une fois par jour.
   */
  private pruneHistory(): void {
    const max = Math.max(10, this.config.settings.historyMax);
    const kept = new Map<string, number>();

    this.state.history = this.state.history.filter((entry) => {
      const count = (kept.get(entry.sourceId) ?? 0) + 1;
      kept.set(entry.sourceId, count);
      return count <= max;
    });
  }

  /** Historique, éventuellement restreint à une boîte. */
  history(limit: number, sourceId?: string): HistoryEntry[] {
    const all = sourceId
      ? this.state.history.filter((h) => h.sourceId === sourceId)
      : this.state.history;
    return all.slice(0, limit);
  }

  /** Dernière action de chaque boîte, pour l'affichage des cartes. */
  lastRuns(): Record<string, HistoryEntry> {
    const out: Record<string, HistoryEntry> = {};
    // L'historique est trié du plus récent au plus ancien : le premier vu pour
    // une boîte est le bon.
    for (const entry of this.state.history) {
      if (!out[entry.sourceId]) out[entry.sourceId] = entry;
    }
    return out;
  }

  persistState(): Promise<void> {
    return this.write(env.stateFile, this.state);
  }

  // --- Écriture atomique ----------------------------------------------------

  /**
   * Écrit dans un fichier temporaire puis renomme : une coupure de courant ne
   * peut pas laisser un JSON tronqué, le fichier est soit l'ancien soit le neuf.
   */
  private write(file: string, data: unknown): Promise<void> {
    const task = this.queue.then(async () => {
      const tmp = `${file}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, file);
    });
    // La file continue même si une écriture échoue, sinon tout se bloquerait.
    this.queue = task.catch((err) => log.error(`écriture de ${path.basename(file)} :`, err));
    return task;
  }
}

export const newId = (): string => randomUUID();

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as T;
    return { ...fallback, ...parsed };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn(`${path.basename(file)} illisible, valeurs par défaut appliquées :`, err);
    }
    return fallback;
  }
}

function defaultConfig(): AppConfig {
  return {
    version: 1,
    settings: { ...env.defaults },
    targets: [],
    sources: [],
    notify: {
      events: ['error'],
      emailTargetId: '',
      emailTo: '',
      ntfyServer: 'https://ntfy.sh',
      ntfyTopic: '',
      webhookUrl: '',
      webhookMethod: 'POST',
      webhookContentType: 'application/json',
      webhookTemplate: '{"title":"{{title}}","message":"{{text}}"}',
      freeMobileUser: '',
      freeMobilePass: '',
    },
  };
}

function defaultState(): RunState {
  return { version: 1, seen: {}, lastRun: null, history: [] };
}
