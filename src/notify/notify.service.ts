import { Injectable } from '@nestjs/common';
import { makeLogger } from '../logger';
import { SmtpService } from '../mail/smtp.service';
import { StoreService } from '../store/store.service';
import type { HistoryEntry, NotifyEvent } from '../types';

const log = makeLogger('alerte');

export interface ChannelResult {
  channel: string;
  ok: boolean;
  message: string;
}

const HTTP_TIMEOUT = 10_000;

/**
 * Alertes.
 *
 * Une notification ne doit jamais faire échouer une relève : chaque canal est
 * isolé, et une erreur d'envoi part au journal sans remonter. Perdre une alerte
 * est ennuyeux, perdre un mail le serait beaucoup plus.
 */
@Injectable()
export class NotifyService {
  constructor(
    private readonly store: StoreService,
    private readonly smtp: SmtpService,
  ) {}

  /** Décide s'il y a lieu d'alerter à l'issue d'une relève, et le fait. */
  async onRunFinished(entry: HistoryEntry): Promise<void> {
    const { events } = this.store.getConfig().notify;
    const failed = entry.status === 'error' || entry.status === 'partial';

    if (failed && events.includes('error')) {
      await this.dispatch(
        `pop3-to-smtp : échec sur ${entry.sourceName}`,
        describeFailure(entry),
      );
      return;
    }
    if (entry.forwarded > 0 && events.includes('forward')) {
      await this.dispatch(
        `pop3-to-smtp : ${entry.forwarded} message(s) redirigé(s)`,
        describeSuccess(entry),
      );
      return;
    }
    if (events.includes('run')) {
      await this.dispatch('pop3-to-smtp : relève terminée', describeSuccess(entry));
    }
  }

  /** Envoie sur tous les canaux configurés. Utilisé aussi par le bouton de test. */
  async dispatch(title: string, text: string): Promise<ChannelResult[]> {
    const results = await Promise.all([
      this.byEmail(title, text),
      this.byNtfy(title, text),
      this.byWebhook(title, text),
      this.bySms(title, text),
    ]);

    const used = results.filter((r): r is ChannelResult => r !== null);
    for (const r of used) {
      if (!r.ok) log.warn(`${r.channel} : ${r.message}`);
    }
    return used;
  }

  /** Liste des catégories effectivement suivies, pour l'interface. */
  activeEvents(): NotifyEvent[] {
    return this.store.getConfig().notify.events;
  }

  // --- Canaux ---------------------------------------------------------------

  private async byEmail(title: string, text: string): Promise<ChannelResult | null> {
    const { emailTargetId, emailTo } = this.store.getConfig().notify;
    if (!emailTargetId) return null;

    const target = this.store.getTarget(emailTargetId);
    if (!target) return { channel: 'e-mail', ok: false, message: 'destination introuvable' };

    const to = emailTo.trim() || target.to;
    if (!to) return { channel: 'e-mail', ok: false, message: 'aucun destinataire' };

    try {
      await this.smtp.sendText(target, to, title, text);
      return { channel: 'e-mail', ok: true, message: `envoyé à ${to}` };
    } catch (err) {
      return { channel: 'e-mail', ok: false, message: asMessage(err) };
    }
  }

  private async byNtfy(title: string, text: string): Promise<ChannelResult | null> {
    const { ntfyServer, ntfyTopic } = this.store.getConfig().notify;
    if (!ntfyTopic) return null;

    const url = `${(ntfyServer || 'https://ntfy.sh').replace(/\/$/, '')}/${ntfyTopic}`;
    try {
      await httpSend(url, {
        method: 'POST',
        // Le titre passe par un en-tête : ntfy attend le corps en texte brut.
        headers: { Title: asciiHeader(title), Priority: 'default' },
        body: text,
      });
      return { channel: 'ntfy', ok: true, message: `publié sur ${ntfyTopic}` };
    } catch (err) {
      return { channel: 'ntfy', ok: false, message: asMessage(err) };
    }
  }

  private async byWebhook(title: string, text: string): Promise<ChannelResult | null> {
    const { webhookUrl, webhookMethod, webhookContentType, webhookTemplate } =
      this.store.getConfig().notify;
    if (!webhookUrl) return null;

    const isJson = webhookContentType.includes('json');
    const body = webhookTemplate
      .replace(/\{\{title\}\}/g, isJson ? escapeJson(title) : title)
      .replace(/\{\{text\}\}/g, isJson ? escapeJson(text) : text);

    try {
      await httpSend(webhookUrl, {
        method: (webhookMethod || 'POST').toUpperCase(),
        headers: { 'content-type': webhookContentType || 'application/json' },
        body,
      });
      return { channel: 'webhook', ok: true, message: 'appelé' };
    } catch (err) {
      return { channel: 'webhook', ok: false, message: asMessage(err) };
    }
  }

  private async bySms(title: string, text: string): Promise<ChannelResult | null> {
    const { freeMobileUser, freeMobilePass } = this.store.getConfig().notify;
    if (!freeMobileUser || !freeMobilePass) return null;

    // Un SMS, c'est court : on tronque plutôt que de se faire refuser l'envoi.
    const msg = `${title}\n${text}`.slice(0, 900);
    const url =
      'https://smsapi.free-mobile.fr/sendmsg' +
      `?user=${encodeURIComponent(freeMobileUser)}` +
      `&pass=${encodeURIComponent(freeMobilePass)}` +
      `&msg=${encodeURIComponent(msg)}`;

    try {
      await httpSend(url, { method: 'GET' });
      return { channel: 'SMS', ok: true, message: 'envoyé' };
    } catch (err) {
      return { channel: 'SMS', ok: false, message: asMessage(err) };
    }
  }
}

async function httpSend(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
}

function describeFailure(entry: HistoryEntry): string {
  const lines = [
    `Boîte : ${entry.sourceName}`,
    `Destination : ${entry.targetName}`,
    `Statut : ${entry.status === 'partial' ? 'partiel' : 'échec'}`,
  ];
  if (entry.error) lines.push(`Erreur : ${entry.error}`);
  if (entry.forwarded) lines.push(`Redirigés malgré tout : ${entry.forwarded}`);

  const failures = entry.messages.filter((m) => m.status === 'error').slice(0, 5);
  if (failures.length) {
    lines.push('', 'Messages en échec :');
    for (const m of failures) {
      lines.push(`— ${m.subject || '(sans objet)'} : ${m.error ?? 'erreur inconnue'}`);
    }
  }
  lines.push('', `Le ${new Date(entry.at).toLocaleString('fr-FR')}`);
  return lines.join('\n');
}

function describeSuccess(entry: HistoryEntry): string {
  return [
    `Boîte : ${entry.sourceName}`,
    `Destination : ${entry.targetName}`,
    `Redirigés : ${entry.forwarded}`,
    `Ignorés : ${entry.skipped}`,
    `Supprimés de la source : ${entry.deleted}`,
    `Durée : ${(entry.durationMs / 1000).toFixed(1)} s`,
  ].join('\n');
}

/** Les en-têtes HTTP n'acceptent que de l'ASCII : on translittère grossièrement. */
function asciiHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

const escapeJson = (value: string): string => JSON.stringify(value).slice(1, -1);

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
