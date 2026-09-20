import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { isUnreachable } from '../api/unreachable';

export interface Session {
  readonly userId: string;
  readonly householdId: string;
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  readonly sessionId: string;
  /**
   * The account fields the shell renders and the profile screen edits. They arrive with the same
   * `GET /auth/me` the session does, so the header's account block shows the real name with no
   * second request (docs/02 §2.2; it named the role until 0.6.4).
   */
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly emailVerified: boolean;
  /** A staged address change awaiting its confirmation link, or `null`. */
  readonly pendingEmail: string | null;
}

/**
 * Why this page load has no session.
 *
 * `UNREACHABLE` is the only arm that opens the offline shell (ADR-033): nothing answered, so the app
 * cannot know whether the session is still valid — and an unlocked install may look at what it already
 * holds. `REFUSED` is an answer (`401` and friends) and must be respected; `SIGNED_OUT` is the user's own
 * choice, which an unlock must never undo.
 */
export type SessionFailure = 'UNREACHABLE' | 'REFUSED' | 'SIGNED_OUT';

interface AuthTokensResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
}

/**
 * Authentication state, held in signals.
 *
 * The access token lives **in memory only**. A refresh token is an `httpOnly` cookie the app cannot
 * read, so a page reload loses the access token and the app silently refreshes once on boot — which
 * is why `restore()` exists and why the guard can await it.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly http = inject(HttpClient);

  private readonly accessTokenSignal = signal<string | null>(null);
  private readonly sessionSignal = signal<Session | null>(null);
  private readonly restoreFailureSignal = signal<SessionFailure | null>(null);

  readonly accessToken = this.accessTokenSignal.asReadonly();
  readonly session = this.sessionSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.sessionSignal() !== null);

  /**
   * Why the last restore failed, or `null` when there is a session or none has been attempted.
   *
   * Read by `authenticatedGuard` (to decide whether an unlocked install may reach its local data) and by
   * the offline shell (ADR-033). Deliberately *not* rendered as an error by the auth pages: a visitor who
   * is simply not signed in is not a failure.
   */
  readonly restoreFailure = this.restoreFailureSignal.asReadonly();

  /**
   * Roles are read from the API, never inferred from the token: authority is resolved from the
   * database per request (docs/08 §3), so the client must not cache a claim and act on it.
   */
  readonly role = computed(() => this.sessionSignal()?.role ?? null);

  async signUp(
    email: string,
    password: string,
    displayName: string,
    // The language the visitor is signing up in, stored so the verification mail and every later
    // notification are written in it (ADR-040).
    locale?: string,
  ): Promise<void> {
    const tokens = await firstValueFrom(
      this.http.post<AuthTokensResponse>('/api/auth/signup', {
        email,
        password,
        displayName,
        ...(locale === undefined ? {} : { locale }),
      }),
    );
    this.accessTokenSignal.set(tokens.accessToken);
    await this.loadSession();
    this.restoreFailureSignal.set(null);
  }

  async signIn(email: string, password: string): Promise<void> {
    const tokens = await firstValueFrom(
      this.http.post<AuthTokensResponse>('/api/auth/login', { email, password }),
    );
    this.accessTokenSignal.set(tokens.accessToken);
    await this.loadSession();
    this.restoreFailureSignal.set(null);
  }

  /**
   * Ask for a password-reset link (F-28, task 5.8).
   *
   * The API answers `204` even for an unknown address, so nothing here can report whether the account
   * exists — that is deliberate, and the screen's copy has to keep the same promise (docs/06 §2).
   */
  async requestPasswordReset(email: string): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/request-password-reset', { email }));
  }

  /**
   * Consume a reset link.
   *
   * The API revokes **every** session for the user once this succeeds (a reset implies the old
   * credentials may be compromised), so local state is cleared here: the access token this store may
   * still hold is dead the moment the password changes, and the caller sends the person to sign-in.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/reset-password', { token, password }));
    this.clear();
  }

  /**
   * Confirm an email address (F-28, task 5.8).
   *
   * The token is one-shot — consumed by the first call — so a screen that posts it twice reports a
   * failure the second time and must not treat that as an error of its own.
   */
  async verifyEmail(token: string): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/verify-email', { token }));
  }

  /**
   * Confirm a staged email change (docs/02 §4.18).
   *
   * The link is clicked from a mailbox, so this can run on the `/verify-email` screen with or
   * without a session. When there *is* one, the session's own `email` has just changed and the
   * shell's cached copy of it is stale, so it is re-read.
   */
  async confirmEmailChange(token: string): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/confirm-email-change', { token }));
    await this.refresh();
  }

  /**
   * Re-read `GET /auth/me` after something outside this store changed the account — a rename on
   * `/profile`, or a confirmed email change.
   *
   * Silent on failure: the session is still valid and only the cached copy is stale, so an error
   * banner over a display name would overstate the problem. The next navigation re-reads anyway.
   */
  async refresh(): Promise<void> {
    if (this.accessTokenSignal() === null) return;
    try {
      await this.loadSession();
    } catch {
      // Deliberately silent; see the doc comment.
    }
  }

  /**
   * Tell the API which language this reader chose (ADR-040).
   *
   * The switcher itself is a client signal (ADR-019) and works with no round trip — this exists so the
   * copy the **server** composes later (a verification mail, a password reset, an alert from the daily
   * job) is written in the same language. A failure is swallowed on purpose: the interface already
   * switched, and a language preference that could not be saved is not worth an error banner. It is
   * retried the next time the switcher is used, and the stored column keeps its previous value.
   */
  async rememberLocale(tag: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/locale', { locale: tag }));
    } catch {
      // Deliberately silent: see the doc comment.
    }
  }

  async signOut(): Promise<void> {    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      // Clear locally even if the call failed: leaving the UI authenticated after the user asked to
      // leave is worse than an orphaned server session, which expires on its own.
      this.clear();
      // And it is **the user's own choice**, which an unlock must never undo (ADR-033): without this,
      // an offline sign-out would leave `UNREACHABLE` standing and the guard would let the next unlock
      // walk straight back into the queue the user just left.
      this.restoreFailureSignal.set('SIGNED_OUT');
    }
  }

  /**
   * Restore a session after a reload, using the refresh cookie.
   *
   * Called once during bootstrap. A failure is not an error worth surfacing — it just means the
   * visitor is not signed in — but *why* it failed is recorded, because the guard and the offline shell
   * need to tell "nothing answered" from "the server said no" (ADR-033).
   */
  async restore(): Promise<void> {
    // A session the **user** ended is not re-attempted. ADR-033 makes that choice final for the page
    // load, and `anonymousGuard` calls this unconditionally on `/sign-in` — which is where sign-out now
    // navigates — so without this guard an offline sign-out would answer `UNREACHABLE`, flip
    // `restoreFailure` back and put the person in the offline shell (with the queue they just left)
    // instead of on the login form.
    if (this.restoreFailureSignal() === 'SIGNED_OUT') return;

    try {
      const tokens = await firstValueFrom(
        this.http.post<AuthTokensResponse>('/api/auth/refresh', {}),
      );
      if (!tokens.accessToken) {
        this.clear();
        this.restoreFailureSignal.set('REFUSED');
        return;
      }
      this.accessTokenSignal.set(tokens.accessToken);
      await this.loadSession();
      this.restoreFailureSignal.set(null);
    } catch (error) {
      this.clear();
      this.restoreFailureSignal.set(isUnreachable(error) ? 'UNREACHABLE' : 'REFUSED');
    }
  }

  /** Drop all local auth state. Safe to call at any time. */
  clear(): void {
    this.accessTokenSignal.set(null);
    this.sessionSignal.set(null);
  }

  private async loadSession(): Promise<void> {
    const session = await firstValueFrom(this.http.get<Session>('/api/auth/me'));
    this.sessionSignal.set(session);
  }
}
