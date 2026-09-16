import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { isUnreachable } from '../api/unreachable';

export interface Session {
  readonly userId: string;
  readonly householdId: string;
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  readonly sessionId: string;
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

  async signUp(email: string, password: string, displayName: string): Promise<void> {
    const tokens = await firstValueFrom(
      this.http.post<AuthTokensResponse>('/api/auth/signup', { email, password, displayName }),
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

  async signOut(): Promise<void> {
    try {
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
