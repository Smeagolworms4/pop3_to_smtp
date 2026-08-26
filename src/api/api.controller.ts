import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { forcedSettings } from '../env';
import { recentLogs } from '../logger';
import { ForwarderService, TestResult } from '../mail/forwarder.service';
import { resolveHeaderMode } from '../mail/rewrite';
import { NotifyService } from '../notify/notify.service';
import { SchedulerService } from '../scheduler.service';
import { StoreService } from '../store/store.service';
import type { Source, Target } from '../types';
import {
  maskConfig,
  maskSource,
  maskTarget,
  normalizeNotify,
  normalizeSettings,
  normalizeSource,
  normalizeTarget,
} from './dto';

type Raw = Record<string, unknown>;

@Controller('api')
export class ApiController {
  constructor(
    private readonly store: StoreService,
    private readonly forwarder: ForwarderService,
    private readonly scheduler: SchedulerService,
    private readonly notify: NotifyService,
  ) {}

  // --- Lecture --------------------------------------------------------------

  @Get('status')
  status() {
    const config = this.store.getConfig();
    return {
      running: this.forwarder.isRunning,
      runningLabel: this.forwarder.runningLabel,
      nextRunAt: this.scheduler.nextRunAt,
      // Prochaine relève de chaque boîte : chacune a son propre rythme.
      nextRuns: this.scheduler.nextRuns,
      lastRun: this.store.getState().lastRun,
      // Dernière action de chaque boîte : une carte doit montrer la sienne, pas
      // celle de la voisine relevée entre-temps.
      lastRuns: this.store.lastRuns(),
      config: maskConfig(config),
      // Réglages imposés par le .env : l'interface les affiche verrouillés.
      forced: forcedSettings(),
      // Mode réellement appliqué par destination, `auto` résolu. Une
      // destination IMAP n'en a pas : rien n'est réécrit chez elle.
      resolvedModes: Object.fromEntries(
        config.targets.map((t) => [t.id, t.kind === 'imap' ? 'imap' : resolveHeaderMode(t)]),
      ),
    };
  }

  @Get('history')
  history(@Query('limit') limit?: string, @Query('sourceId') sourceId?: string) {
    const n = Math.min(200, Math.max(1, Number(limit) || 10));
    return this.store.history(n, sourceId || undefined);
  }

  @Get('logs')
  logs(@Query('limit') limit?: string) {
    return recentLogs(Math.min(500, Math.max(1, Number(limit) || 200)));
  }

  // --- Réglages -------------------------------------------------------------

  @Put('settings')
  async settings(@Body() body: Raw) {
    const settings = await this.store.updateConfig((config) => {
      config.settings = normalizeSettings(body, config.settings);
      return config.settings;
    });
    // Le délai a pu changer : on repart de maintenant.
    this.scheduler.reschedule();
    return settings;
  }

  @Put('notify')
  async notifySettings(@Body() body: Raw) {
    const notify = await this.store.updateConfig((config) => {
      config.notify = normalizeNotify(body, config.notify);
      return config.notify;
    });
    return { ...notify, freeMobilePass: notify.freeMobilePass ? '••••••••' : '' };
  }

  @Post('notify/test')
  test() {
    return this.notify.dispatch(
      'pop3-to-smtp : test',
      'Ceci est une notification de test envoyée depuis l’interface.',
    );
  }

  // --- Destinations (SMTP) --------------------------------------------------

  @Post('targets')
  async createTarget(@Body() body: Raw) {
    const target = normalizeTarget(body);
    requireTarget(target);
    await this.store.updateConfig((config) => config.targets.push(target));
    return { item: maskTarget(target), test: await this.forwarder.testTarget(target) };
  }

  @Put('targets/:id')
  async updateTarget(@Param('id') id: string, @Body() body: Raw) {
    const previous = this.store.getTarget(id);
    if (!previous) throw new NotFoundException('destination introuvable');

    const target = normalizeTarget(body, previous);
    requireTarget(target);
    await this.store.updateConfig((config) => {
      config.targets[config.targets.findIndex((t) => t.id === id)] = target;
    });
    return { item: maskTarget(target), test: await this.forwarder.testTarget(target) };
  }

  @Delete('targets/:id')
  async deleteTarget(@Param('id') id: string) {
    const used = this.store.getConfig().sources.filter((s) => s.targetId === id);
    if (used.length) {
      throw new BadRequestException(
        `destination utilisée par : ${used.map((s) => s.name).join(', ')}`,
      );
    }
    await this.store.updateConfig((config) => {
      config.targets = config.targets.filter((t) => t.id !== id);
      if (config.notify.emailTargetId === id) config.notify.emailTargetId = '';
    });
    return { ok: true };
  }

  /** Test d'une destination, enregistrée ou non (bouton « Tester »). */
  @Post('targets/test')
  testTarget(@Body() body: Raw): Promise<TestResult> {
    const previous = typeof body.id === 'string' ? this.store.getTarget(body.id) : undefined;
    const target = normalizeTarget(body, previous);
    requireTarget(target);
    return this.forwarder.testTarget(target);
  }

  // --- Boîtes POP3 ----------------------------------------------------------

  @Post('sources')
  async createSource(@Body() body: Raw) {
    const source = normalizeSource(body);
    this.requireSource(source);
    await this.store.updateConfig((config) => config.sources.push(source));
    return { item: maskSource(source), test: await this.forwarder.testSource(source) };
  }

  @Put('sources/:id')
  async updateSource(@Param('id') id: string, @Body() body: Raw) {
    const previous = this.store.getSource(id);
    if (!previous) throw new NotFoundException('boîte introuvable');

    const source = normalizeSource(body, previous);
    this.requireSource(source);
    await this.store.updateConfig((config) => {
      config.sources[config.sources.findIndex((s) => s.id === id)] = source;
    });
    return { item: maskSource(source), test: await this.forwarder.testSource(source) };
  }

  @Delete('sources/:id')
  async deleteSource(@Param('id') id: string) {
    await this.store.updateConfig((config) => {
      config.sources = config.sources.filter((s) => s.id !== id);
    });
    this.store.forgetSource(id);
    await this.store.persistState();
    return { ok: true };
  }

  @Post('sources/test')
  testSource(@Body() body: Raw): Promise<TestResult> {
    const previous = typeof body.id === 'string' ? this.store.getSource(body.id) : undefined;
    const source = normalizeSource(body, previous);
    this.requireSource(source, { needTarget: false });
    return this.forwarder.testSource(source);
  }

  /** Marque le contenu actuel comme déjà traité, sans rien renvoyer. */
  @Post('sources/:id/seen')
  markSeen(@Param('id') id: string): Promise<TestResult> {
    return this.forwarder.markAllSeen(id);
  }

  // --- Relèves --------------------------------------------------------------

  @Post('run')
  async run() {
    const entries = await this.forwarder.runAll('manual');
    this.scheduler.reschedule();
    return entries;
  }

  @Post('sources/:id/run')
  async runSource(@Param('id') id: string) {
    const entry = await this.forwarder.runSource(id, 'manual');
    this.scheduler.reschedule(id);
    return entry;
  }

  // --- Validations ----------------------------------------------------------

  private requireSource(source: Source, options = { needTarget: true }): void {
    if (!source.host) throw new BadRequestException('serveur POP3 manquant');
    if (!source.user) throw new BadRequestException('identifiant manquant');
    if (options.needTarget) {
      if (!source.targetId) throw new BadRequestException('aucune destination choisie');
      if (!this.store.getTarget(source.targetId)) {
        throw new BadRequestException('la destination choisie n’existe pas');
      }
    }
  }
}

function requireTarget(target: Target): void {
  if (target.kind === 'imap') {
    if (!target.host) throw new BadRequestException('serveur IMAP manquant');
    if (!target.user) throw new BadRequestException('identifiant IMAP manquant');
    // L'adresse de dépôt ne sert qu'aux en-têtes de traçage : la boîte, c'est
    // celle du compte. Rien à exiger de plus.
    return;
  }
  if (!target.host) throw new BadRequestException('serveur SMTP manquant');
  if (!target.to) throw new BadRequestException('adresse de destination manquante');
}
