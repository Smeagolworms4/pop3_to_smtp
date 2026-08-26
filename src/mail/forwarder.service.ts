import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { env } from '../env';
import { makeLogger } from '../logger';
import { NotifyService } from '../notify/notify.service';
import { StoreService } from '../store/store.service';
import type { HistoryEntry, MessageResult, Source, Target } from '../types';
import { DeliveryChannel, openChannel, verifyTarget } from './delivery';
import { Pop3Client } from './pop3';
import { rewriteMessage } from './rewrite';
import { SmtpService } from './smtp.service';

const log = makeLogger('relève');

export interface TestResult {
  ok: boolean;
  message: string;
  /** Nombre de messages présents dans la boîte, pour un test POP3 réussi. */
  count?: number;
}

/**
 * Le cœur : relever une boîte POP3 et remettre ce qu'elle contient à la
 * destination associée — envoi SMTP ou dépôt IMAP, selon ce qu'elle est.
 *
 * Deux invariants tiennent la fiabilité de l'ensemble :
 *
 * - un message n'est marqué « traité » **qu'après** son acceptation par la
 *   destination, et n'est supprimé de la boîte source qu'après ça. Une panne
 *   au milieu d'une relève fait au pire un doublon, jamais une perte ;
 * - une seule relève à la fois. Deux passages simultanés sur la même boîte
 *   enverraient les mêmes messages deux fois.
 */
@Injectable()
export class ForwarderService {
  private running: Promise<unknown> | null = null;
  private currentLabel = '';

  constructor(
    private readonly store: StoreService,
    private readonly smtp: SmtpService,
    private readonly notify: NotifyService,
  ) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  get runningLabel(): string {
    return this.currentLabel;
  }

  /**
   * Relève toutes les boîtes actives. Si une relève est déjà en cours, on
   * attend qu'elle finisse plutôt que de la doubler.
   */
  async runAll(trigger: HistoryEntry['trigger']): Promise<HistoryEntry[]> {
    return this.exclusive('toutes les boîtes', async () => {
      const sources = this.store.getConfig().sources.filter((s) => s.enabled);
      const results: HistoryEntry[] = [];
      for (const source of sources) {
        results.push(await this.collect(source, trigger));
      }
      return results;
    });
  }

  /** Relève une seule boîte, y compris si elle est désactivée (bouton manuel). */
  async runSource(sourceId: string, trigger: HistoryEntry['trigger']): Promise<HistoryEntry> {
    const source = this.store.getSource(sourceId);
    if (!source) throw new Error('boîte introuvable');
    return this.exclusive(source.name || source.user, () => this.collect(source, trigger));
  }

  private async exclusive<T>(label: string, task: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.catch(() => undefined);

    this.currentLabel = label;
    const promise = task().finally(() => {
      this.running = null;
      this.currentLabel = '';
    });
    this.running = promise;
    return promise;
  }

  // --- Relève d'une boîte ---------------------------------------------------

  private async collect(source: Source, trigger: HistoryEntry['trigger']): Promise<HistoryEntry> {
    const startedAt = Date.now();
    const target = this.store.getTarget(source.targetId);

    const entry: HistoryEntry = {
      id: randomUUID(),
      at: new Date(startedAt).toISOString(),
      durationMs: 0,
      sourceId: source.id,
      sourceName: source.name || source.user,
      targetName: target ? target.name || target.to : '—',
      trigger,
      status: 'ok',
      total: 0,
      forwarded: 0,
      skipped: 0,
      deleted: 0,
      messages: [],
    };

    let client: Pop3Client | null = null;
    let channel: DeliveryChannel | null = null;

    try {
      if (!target) throw new Error('aucune destination associée à cette boîte');
      if (!target.enabled) throw new Error(`destination « ${target.name} » désactivée`);

      client = await Pop3Client.connect(pop3Options(source));
      const inbox = await client.list();
      const present = new Set(inbox.map((m) => m.uid));
      const seen = this.store.seenUids(source.id);
      const settings = this.store.getSettings();
      const maxBytes = Math.max(0, settings.maxSizeMb) * 1024 * 1024;

      const fresh = inbox.filter((m) => !seen.has(m.uid));
      entry.total = fresh.length;

      // Plafond propre à la boîte, sinon celui du réglage global. `0` = tout
      // traiter : si quelque chose casse en route, l'alerte le dira et les
      // messages non traités repasseront au tour suivant.
      const maxPerRun = source.maxPerRun ?? settings.maxPerRun;
      const batch = maxPerRun > 0 ? fresh.slice(0, maxPerRun) : fresh;
      if (batch.length < fresh.length) {
        log.info(
          `${entry.sourceName} : ${fresh.length} nouveaux, ${batch.length} traités ce passage`,
        );
      }

      if (batch.length) channel = await openChannel(target, this.smtp);

      for (const item of batch) {
        const result = await this.forwardOne(client, channel!, source, target, item, maxBytes);
        entry.messages.push(result);

        if (result.status === 'forwarded') {
          entry.forwarded++;
          this.store.markSeen(source.id, item.uid);
          if (source.deleteAfterFetch) {
            await client.dele(item.num);
            entry.deleted++;
          }
        } else if (result.status === 'skipped') {
          entry.skipped++;
          // Un message ignoré une fois le sera toujours : inutile de le
          // reproposer à chaque passage.
          this.store.markSeen(source.id, item.uid);
        }
        // En cas d'erreur, on ne marque rien : il repassera au prochain tour.

        await this.store.persistState();
      }

      this.store.pruneSeen(source.id, present);
      // Le QUIT valide les suppressions demandées : s'il échoue, le serveur
      // annule tout et les messages restent en place.
      await client.quit();
      client = null;

      const failed = entry.messages.filter((m) => m.status === 'error').length;
      if (failed) entry.status = entry.forwarded ? 'partial' : 'error';
      if (failed && !entry.error) entry.error = `${failed} message(s) en échec`;
    } catch (err) {
      entry.status = 'error';
      entry.error = errorMessage(err);
      log.error(`${entry.sourceName} :`, entry.error);
    } finally {
      channel?.close();
      client?.destroy();
      entry.durationMs = Date.now() - startedAt;
      entry.finishedAt = new Date().toISOString();
      this.store.pushHistory(entry);
      await this.store.persistState();
    }

    if (entry.status === 'ok' && entry.forwarded) {
      log.info(
        `${entry.sourceName} → ${entry.targetName} : ${entry.forwarded} message(s) redirigé(s)`,
      );
    }
    await this.notify.onRunFinished(entry);
    return entry;
  }

  /** Relève, réécrit et remet un message. N'émet jamais : le résultat est rendu. */
  private async forwardOne(
    client: Pop3Client,
    channel: DeliveryChannel,
    source: Source,
    target: Target,
    item: { num: number; uid: string; size: number },
    maxBytes: number,
  ): Promise<MessageResult> {
    const base: MessageResult = {
      uid: item.uid,
      from: '',
      subject: '',
      date: '',
      size: item.size,
      status: 'error',
    };

    if (maxBytes && item.size > maxBytes) {
      return { ...base, status: 'skipped', error: `message de ${formatSize(item.size)} ignoré` };
    }

    try {
      // Marge sur la taille annoncée par LIST : certains serveurs mentent un peu,
      // mais pas au point de justifier de télécharger 200 Mo.
      const raw = await client.retr(item.num, maxBytes ? Math.ceil(maxBytes * 1.5) : 0);
      const rewritten = rewriteMessage(raw, source, target);

      await channel.deliver(rewritten);

      return {
        ...base,
        status: 'forwarded',
        size: raw.length,
        from: rewritten.info.from || rewritten.info.fromAddress,
        subject: rewritten.info.subject,
        date: rewritten.info.date,
      };
    } catch (err) {
      return { ...base, status: 'error', error: errorMessage(err) };
    }
  }

  // --- Tests et entretien ---------------------------------------------------

  /** Vérifie qu'une boîte POP3 répond et s'authentifie. */
  async testSource(source: Source): Promise<TestResult> {
    let client: Pop3Client | null = null;
    try {
      client = await Pop3Client.connect(pop3Options(source));
      const inbox = await client.list();
      await client.quit();
      client = null;
      return {
        ok: true,
        message: `connexion réussie — ${inbox.length} message(s) dans la boîte`,
        count: inbox.length,
      };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    } finally {
      client?.destroy();
    }
  }

  async testTarget(target: Target): Promise<TestResult> {
    try {
      return { ok: true, message: await verifyTarget(target, this.smtp) };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /**
   * Marque tout le contenu actuel comme déjà traité, sans rien envoyer.
   * Utile en branchant une boîte qui contient dix ans d'archives.
   */
  async markAllSeen(sourceId: string): Promise<TestResult> {
    const source = this.store.getSource(sourceId);
    if (!source) throw new Error('boîte introuvable');

    let client: Pop3Client | null = null;
    try {
      client = await Pop3Client.connect(pop3Options(source));
      const inbox = await client.list();
      for (const item of inbox) this.store.markSeen(source.id, item.uid);
      await client.quit();
      client = null;
      await this.store.persistState();
      return { ok: true, message: `${inbox.length} message(s) marqué(s) comme déjà traités` };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    } finally {
      client?.destroy();
    }
  }
}

function pop3Options(source: Source) {
  return {
    host: source.host.trim(),
    port: source.port,
    security: source.security,
    user: source.user,
    pass: source.pass,
    timeoutMs: env.pop3Timeout,
    allowInvalidCert: source.allowInvalidCert,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
