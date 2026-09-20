import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { CONFIG, type AppConfig } from '../../config/config';
import { tr, type CopyLocale } from '../../common/i18n/copy';

/**
 * Outbound email: verification, password reset, and later budget alerts.
 *
 * In development `SMTP_URL` points at Mailhog, so nothing leaves the machine and every message is
 * inspectable at http://localhost:8025. When `SMTP_URL` is unset the service logs instead of
 * sending, which keeps tests and local runs free of a mail dependency.
 *
 * ## The reader's language, not the writer's
 *
 * These two messages used to be Serbian-only, so an English reader's first contact with the product —
 * the verification mail — was in a language they had not chosen. They are now a catalogue pair and the
 * caller passes the **recipient's** stored locale (ADR-040). The subject and body are whole sentences:
 * docs/13 §8.1 puts the Serbian voice in the second person singular, and a sentence assembled from
 * fragments cannot agree in a language that inflects.
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

  async sendEmailVerification(
    to: string,
    token: string,
    locale: CopyLocale = 'en',
  ): Promise<void> {
    const link = `${this.config.APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
    const minutes = Math.round(this.config.EMAIL_TOKEN_TTL_SECONDS / 60);
    await this.send(
      to,
      tr(locale, { en: 'Confirm your email address', sr: 'Potvrdite svoju email adresu' }),
      [
        tr(locale, { en: 'Welcome!', sr: 'Dobrodošli!' }),
        '',
        tr(locale, {
          en: 'Confirm your email address by clicking the link below:',
          sr: 'Potvrdite svoju email adresu klikom na link ispod:',
        }),
        link,
        '',
        tr(
          locale,
          { en: 'The link expires in {minutes} minutes.', sr: 'Link ističe za {minutes} minuta.' },
          { minutes },
        ),
        tr(locale, {
          en: 'If you did not create this account, you can ignore this message.',
          sr: 'Ako niste vi napravili nalog, slobodno ignorišite ovu poruku.',
        }),
      ].join('\n'),
    );
  }

  async sendPasswordReset(to: string, token: string, locale: CopyLocale = 'en'): Promise<void> {
    const link = `${this.config.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
    const minutes = Math.round(this.config.EMAIL_TOKEN_TTL_SECONDS / 60);
    await this.send(
      to,
      tr(locale, { en: 'Reset your password', sr: 'Reset lozinke' }),
      [
        tr(locale, {
          en: 'A password reset was requested for your account.',
          sr: 'Zatražen je reset lozinke za vaš nalog.',
        }),
        '',
        link,
        '',
        tr(
          locale,
          { en: 'The link expires in {minutes} minutes.', sr: 'Link ističe za {minutes} minuta.' },
          { minutes },
        ),
        tr(locale, {
          en: 'If you did not request this, ignore this message — your password stays unchanged.',
          sr: 'Ako niste vi zatražili reset, ignorišite ovu poruku — lozinka ostaje nepromenjena.',
        }),
      ].join('\n'),
    );
  }

  /**
   * Confirm a new email address (docs/02 §4.18, docs/06 §2).
   *
   * Sent to the **new** address, never the old one: the person who can read the mailbox being added
   * is the one whose consent the change needs, and the old address is not proof of that. The old
   * address stays the login identity until this link is consumed, so an abandoned change is inert.
   */
  async sendEmailChange(to: string, token: string, locale: CopyLocale = 'en'): Promise<void> {
    const link = `${this.config.APP_BASE_URL}/verify-email?token=${encodeURIComponent(token)}&change=1`;
    const minutes = Math.round(this.config.EMAIL_TOKEN_TTL_SECONDS / 60);
    await this.send(
      to,
      tr(locale, { en: 'Confirm your new email address', sr: 'Potvrdite novu email adresu' }),
      [
        tr(locale, {
          en: 'Confirm this address to use it for your account:',
          sr: 'Potvrdite ovu adresu da biste je koristili za svoj nalog:',
        }),
        link,
        '',
        tr(
          locale,
          { en: 'The link expires in {minutes} minutes.', sr: 'Link ističe za {minutes} minuta.' },
          { minutes },
        ),
        tr(locale, {
          en: 'Until you confirm it, your current address stays the one you sign in with.',
          sr: 'Dok je ne potvrdite, prijavljujete se sa trenutnom adresom.',
        }),
        tr(locale, {
          en: 'If you did not ask for this, ignore this message — nothing changes.',
          sr: 'Ako niste vi tražili ovo, ignorišite poruku — ništa se ne menja.',
        }),
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
    // The display name is `APP_NAME`, never a literal: AGENTS.md forbids hardcoding the brand, which
    // is a working title (ADR-014). This header used to spell the brand out.
    await this.transporter.sendMail({
      from: `${this.config.APP_NAME} <noreply@finmate.local>`,
      to,
      subject,
      text,
    });
  }
}
