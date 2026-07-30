import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { makeLogger } from './logger';
import { ForwarderService } from './mail/forwarder.service';
import { StoreService } from './store/store.service';
import type { Source } from './types';

const log = makeLogger('minuteur');

/** Cadence de l'horloge interne : la précision utile est de l'ordre de la minute. */
const TICK = 10_000;

/** Laisse le serveur web répondre avant de lancer la première relève. */
const STARTUP_DELAY = 5_000;

/**
 * Déclenchement périodique, **une échéance par boîte**.
 *
 * Une seule horloge bat, et à chaque battement on relève les boîtes arrivées à
 * échéance. C'est plus simple qu'un minuteur par boîte (rien à annuler quand on
 * modifie un réglage), et ça évite surtout que deux boîtes de même période
 * partent en même temps : les relèves s'enchaînent, elles ne s'empilent pas.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  /** Prochaine échéance par identifiant de boîte. */
  private due = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly store: StoreService,
    private readonly forwarder: ForwarderService,
  ) {}

  onApplicationBootstrap(): void {
    const startAt = this.store.getSettings().runOnStart ? Date.now() + STARTUP_DELAY : 0;
    for (const source of this.activeSources()) {
      this.due.set(source.id, startAt || this.nextFor(source));
    }
    this.timer = setInterval(() => void this.tick(), TICK);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Prochaine relève, toutes boîtes confondues. */
  get nextRunAt(): string | null {
    const times = [...this.due.values()].filter(Boolean);
    return times.length ? new Date(Math.min(...times)).toISOString() : null;
  }

  /** Prochaine relève de chaque boîte, pour l'interface. */
  get nextRuns(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const source of this.store.getConfig().sources) {
      const at = this.due.get(source.id);
      out[source.id] = at ? new Date(at).toISOString() : null;
    }
    return out;
  }

  /**
   * Repousse l'échéance d'une boîte (ou de toutes) : appelé après une relève
   * manuelle et après un changement de réglage, pour que « toutes les 10
   * minutes » reparte bien de maintenant.
   */
  reschedule(sourceId?: string): void {
    if (this.stopped) return;

    const sources = this.activeSources().filter((s) => !sourceId || s.id === sourceId);
    for (const source of sources) this.due.set(source.id, this.nextFor(source));

    // Une boîte supprimée ou désactivée ne doit plus figurer dans les échéances.
    const known = new Set(this.activeSources().map((s) => s.id));
    for (const id of this.due.keys()) {
      if (!known.has(id)) this.due.delete(id);
    }
    for (const source of this.activeSources()) {
      if (!this.due.has(source.id)) this.due.set(source.id, this.nextFor(source));
    }
  }

  /** Délai retenu pour une boîte : le sien, sinon celui du réglage global. */
  intervalFor(source: Source): number {
    return source.refreshMinutes ?? this.store.getSettings().refreshMinutes;
  }

  private activeSources(): Source[] {
    return this.store.getConfig().sources.filter((s) => s.enabled);
  }

  /** `0` signifie « pas de relève automatique » : aucune échéance. */
  private nextFor(source: Source): number {
    const minutes = this.intervalFor(source);
    return minutes > 0 ? Date.now() + minutes * 60_000 : 0;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.forwarder.isRunning) return;

    const now = Date.now();
    const ready = this.activeSources().filter((s) => {
      const at = this.due.get(s.id);
      return at !== undefined && at > 0 && at <= now;
    });

    // Les boîtes ajoutées depuis le dernier passage entrent dans la ronde.
    for (const source of this.activeSources()) {
      if (!this.due.has(source.id)) this.due.set(source.id, this.nextFor(source));
    }

    for (const source of ready) {
      try {
        await this.forwarder.runSource(source.id, 'schedule');
      } catch (err) {
        // `runSource` consigne déjà l'échec dans l'historique ; on n'arrive ici
        // que sur un imprévu, et il ne doit pas arrêter l'horloge.
        log.error(`relève de ${source.name} :`, err);
      } finally {
        this.due.set(source.id, this.nextFor(source));
      }
    }
  }
}
