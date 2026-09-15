import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { CONFIG, type AppConfig } from '../../config/config';

/**
 * Outbound email: verification, password reset, and later budget alerts.
 *
 * In development `SMTP_URL` points at Mailhog, so nothing leaves the machine and every message is
 * inspectable at http://localhost:8025. When `SMTP_URL` is unset the service logs instead of
 * sending, which keeps tests and local runs free of a mail dependency.
 *
 * Templates are plain text here on purpose: Phase 0 needs the flows to work, not to look good.
 * HTML templates land with the notification work in Phase 3 (docs/05 §9).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.transporter = config.SMTP_URL ? createTransport(config.SMTP_URL) : null;
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    const link = `${this.config.APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await this.send(
      to,
      'Potvrdite svoju email adresu',
      [
        'Dobrodošli!',
        '',
        'Potvrdite svoju email adresu klikom na link ispod:',
        link,
        '',
        `Link ističe za ${Math.round(this.config.EMAIL_TOKEN_TTL_SECONDS / 60)} minuta.`,
        'Ako niste vi napravili nalog, slobodno ignorišite ovu poruku.',
      ].join('\n'),
    );
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    const link = `${this.config.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await this.send(
      to,
      'Reset lozinke',
      [
        'Zatražen je reset lozinke za vaš nalog.',
        '',
        link,
        '',
        `Link ističe za ${Math.round(this.config.EMAIL_TOKEN_TTL_SECONDS / 60)} minuta.`,
        'Ako niste vi zatražili reset, ignorišite ovu poruku — lozinka ostaje nepromenjena.',
      ].join('\n'),
    );
  }

  /**
   * A notification (F-22). The body is composed by the notifications module and is already
   * **lock-screen safe** for this channel (docs/08 T-09): no amounts, no entity names — an email lands
   * on a phone's lock screen just as a push does.
   *
   * Plain text, like the two above: HTML notification templates are the notification-centre work
   * (docs/05 §9), and a mail we can read in Mailhog is what the dispatch path needs today.
   */
  async sendNotification(to: string, subject: string, text: string): Promise<void> {
    await this.send(to, subject, text);
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.transporter) {
      // Deliberately logs the body in development so the flow is testable without SMTP. This must
      // never happen in production: `SMTP_URL` is required there (see below).
      this.logger.warn(`SMTP_URL is unset — not sending "${subject}" to ${to}. Body:\n${text}`);
      return;
    }
    await this.transporter.sendMail({ from: 'FinMate <noreply@finmate.local>', to, subject, text });
  }
}
