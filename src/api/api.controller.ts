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
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { forcedSettings } from '../env';
import { recentLogs } from '../logger';
import { errorMessage, ForwarderService, TestResult } from '../mail/forwarder.service';
import { authorizationUrl, exchangeCode, forgetToken } from '../mail/gmail-api';
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

/**
 * Autorisations Google en cours, par jeton d'état.
 *
 * Le `state` d'OAuth relie le retour de Google à la destination qui l'a
 * demandé, et prouve que c'est bien nous qui avons lancé le parcours. Il vit en
 * mémoire : un redémarrage au milieu d'une autorisation ne fait que la perdre,
 * il suffit de recliquer.
 */
const pendingAuth = new Map<string, { targetId: string; redirectUri: string; expiresAt: number }>();

const AUTH_TTL = 10 * 60 * 1000;

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
  status(@Req() req: Request) {
    const config = this.store.getConfig();
    return {
      // L'adresse de retour que Google doit connaître : c'est celle-ci, telle
      // que le serveur la calcule, qu'il faut coller dans la console Google.
      oauthRedirectUri: redirectUriFrom(req),
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
      // Mode réellement appliqué par destination, `auto` résolu. Un dépôt IMAP
      // ou un import Gmail n'en a pas : rien n'est réécrit chez eux.
      resolvedModes: Object.fromEntries(
        config.targets.map((t) => [t.id, t.kind === 'smtp' ? resolveHeaderMode(t) : t.kind]),
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
    forgetToken(id);
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
    forgetToken(id);
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

  // --- Autorisation Google (destinations « API Gmail ») ---------------------

  /** Prépare le parcours d'autorisation et rend l'URL où envoyer le navigateur. */
  @Post('targets/:id/oauth')
  startOauth(@Param('id') id: string, @Req() req: Request) {
    const target = this.store.getTarget(id);
    if (!target) throw new NotFoundException('destination introuvable');
    if (target.kind !== 'gmail-api') {
      throw new BadRequestException('cette destination n’utilise pas l’API Gmail');
    }
    if (!target.oauthClientId || !target.oauthClientSecret) {
      throw new BadRequestException('renseignez d’abord l’identifiant et le secret du client');
    }

    const redirectUri = redirectUriFrom(req);
    const state = randomUUID();
    prunePendingAuth();
    pendingAuth.set(state, { targetId: id, redirectUri, expiresAt: Date.now() + AUTH_TTL });

    return { url: authorizationUrl(target.oauthClientId, redirectUri, state) };
  }

  /**
   * Retour de Google. On échange le code contre un jeton durable, puis on
   * renvoie l'utilisateur vers l'interface : c'est un navigateur qui arrive
   * ici, pas un appel d'API, donc une redirection vaut mieux qu'un JSON.
   */
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const back = (params: Record<string, string>) =>
      res.redirect('/?' + new URLSearchParams(params).toString());

    const pending = pendingAuth.get(state ?? '');
    pendingAuth.delete(state ?? '');

    if (error) return back({ oauth: 'error', message: error });
    if (!pending || pending.expiresAt < Date.now()) {
      return back({ oauth: 'error', message: 'autorisation expirée, recommencez' });
    }

    const target = this.store.getTarget(pending.targetId);
    if (!target) return back({ oauth: 'error', message: 'destination introuvable' });

    try {
      const refreshToken = await exchangeCode(
        target.oauthClientId,
        target.oauthClientSecret,
        code,
        pending.redirectUri,
      );
      await this.store.updateConfig((config) => {
        const found = config.targets.find((t) => t.id === target.id);
        if (found) found.oauthRefreshToken = refreshToken;
      });
      forgetToken(target.id);
      return back({ oauth: 'ok', name: target.name });
    } catch (err) {
      return back({ oauth: 'error', message: errorMessage(err) });
    }
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

/**
 * Adresse de retour d'OAuth, telle que le navigateur voit l'application.
 *
 * Derrière un proxy, `Host` est celui du conteneur : ce sont les en-têtes
 * `X-Forwarded-*` qui portent le nom public. Google compare cette adresse au
 * caractère près avec celle déclarée dans la console, d'où l'importance de la
 * calculer ici plutôt que de la deviner.
 */
function redirectUriFrom(req: Request): string {
  const first = (value: unknown, fallback: string): string =>
    String(Array.isArray(value) ? value[0] : (value ?? '') || fallback)
      .split(',')[0]
      .trim();

  const proto = first(req.headers['x-forwarded-proto'], req.protocol || 'http');
  const host = first(req.headers['x-forwarded-host'], req.headers.host || 'localhost');
  return `${proto}://${host}/api/oauth/callback`;
}

function prunePendingAuth(): void {
  const now = Date.now();
  for (const [state, pending] of pendingAuth) {
    if (pending.expiresAt < now) pendingAuth.delete(state);
  }
}

function requireTarget(target: Target): void {
  if (target.kind === 'gmail-api') {
    if (!target.oauthClientId) throw new BadRequestException('identifiant client OAuth manquant');
    if (!target.oauthClientSecret) throw new BadRequestException('secret client OAuth manquant');
    return;
  }
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
