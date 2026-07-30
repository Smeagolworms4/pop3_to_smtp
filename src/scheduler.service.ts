import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { makeLogger } from './logger';
import { ForwarderService } from './mail/forwarder.service';
import { StoreService } from './store/store.service';

const log = makeLogger('minuteur');

/** Laisse le serveur web répondre avant de lancer la première relève. */
const STARTUP_DELAY = 3_000;

/**
 * Déclenchement périodique.
 *
 * Un `setTimeout` réarmé après chaque passage, et non un `setInterval` : si une
 * relève dure plus longtemps que le délai configuré, le passage suivant attend
 * qu'elle soit finie au lieu de s'empiler dessus.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private nextAt: number | null = null;
  private stopped = false;

  constructor(
    private readonly store: StoreService,
    private readonly forwarder: ForwarderService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.store.getSettings().runOnStart) {
      this.timer = setTimeout(() => this.tick('startup'), STARTUP_DELAY);
      this.nextAt = Date.now() + STARTUP_DELAY;
    } else {
      this.reschedule();
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Horodatage du prochain passage automatique, pour l'interface. */
  get nextRunAt(): string | null {
    return this.nextAt ? new Date(this.nextAt).toISOString() : null;
  }

  /**
   * (Ré)arme le minuteur. À appeler après un changement de réglage ou une
   * relève manuelle : le délai repart de maintenant, comme on l'attend d'un
   * « toutes les 10 minutes ».
   */
  reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    if (this.stopped) return;

    const minutes = this.store.getSettings().refreshMinutes;
    if (!minutes || minutes <= 0) {
      log.info('relève automatique désactivée');
      return;
    }

    const delay = minutes * 60_000;
    this.nextAt = Date.now() + delay;
    this.timer = setTimeout(() => this.tick('schedule'), delay);
  }

  private async tick(trigger: 'schedule' | 'startup'): Promise<void> {
    try {
      await this.forwarder.runAll(trigger);
    } catch (err) {
      // `runAll` consigne déjà chaque échec de boîte dans l'historique ; on
      // n'arrive ici que sur un imprévu, et il ne doit pas tuer le minuteur.
      log.error('relève automatique :', err);
    } finally {
      this.reschedule();
    }
  }
}
