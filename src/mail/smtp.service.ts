import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../env';
import type { Target } from '../types';

export interface RawDelivery {
  /** Message complet, en-têtes compris, tel qu'il partira sur le réseau. */
  message: Buffer;
  envelopeFrom: string;
  envelopeTo: string;
}

/**
 * Envoi SMTP.
 *
 * Un transport est ouvert par relève et refermé derrière : avec `pool`, la
 * même connexion sert pour tous les messages d'une boîte (les serveurs de
 * soumission n'aiment pas qu'on rouvre une session par message), et une fois
 * la relève finie on ne laisse pas traîner de socket ouverte pendant les
 * dizaines de minutes qui séparent deux passages.
 */
@Injectable()
export class SmtpService {
  createTransport(target: Target): Transporter {
    return nodemailer.createTransport({
      host: target.host.trim(),
      port: target.port,
      secure: target.secure,
      auth: target.user ? { user: target.user, pass: target.pass } : undefined,
      pool: true,
      maxConnections: 1,
      tls: target.allowInvalidCert ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: env.smtpTimeout,
      greetingTimeout: env.smtpTimeout,
      socketTimeout: env.smtpTimeout,
    });
  }

  /**
   * Remet le message tel quel : `raw` court-circuite la fabrication de message
   * de nodemailer, et `envelope` fixe le MAIL FROM / RCPT TO indépendamment des
   * en-têtes. C'est exactement ce que fait un serveur qui relaie.
   */
  async sendRaw(transport: Transporter, delivery: RawDelivery): Promise<string> {
    const info = await transport.sendMail({
      envelope: { from: delivery.envelopeFrom, to: delivery.envelopeTo },
      raw: delivery.message,
    });
    return String(info.response ?? info.messageId ?? 'envoyé');
  }

  /** Message ordinaire, pour les alertes. */
  async sendText(
    target: Target,
    to: string,
    subject: string,
    text: string,
  ): Promise<void> {
    const transport = this.createTransport(target);
    try {
      await transport.sendMail({
        from: target.from || target.user,
        to,
        subject,
        text,
      });
    } finally {
      transport.close();
    }
  }

  /** Teste la connexion et l'authentification, sans rien envoyer. */
  async verify(target: Target): Promise<string> {
    const transport = this.createTransport(target);
    try {
      await transport.verify();
      return `connexion établie sur ${target.host}:${target.port}`;
    } finally {
      transport.close();
    }
  }
}
