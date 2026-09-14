import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Session {
  readonly userId: string;
  readonly householdId: string;
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  readonly sessionId: string;
}

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

  readonly accessToken = this.accessTokenSignal.asReadonly();
  readonly session = this.sessionSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.sessionSignal() !== null);

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
  }

  async signIn(email: string, password: string): Promise<void> {
    const tokens = await firstValueFrom(
      this.http.post<AuthTokensResponse>('/api/auth/login', { email, password }),
    );
    this.accessTokenSignal.set(tokens.accessToken);
    await this.loadSession();
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      // Clear locally even if the call failed: leaving the UI authenticated after the user asked to
      // leave is worse than an orphaned server session, which expires on its own.
      this.clear();
    }
  }

  /**
   * Restore a session after a reload, using the refresh cookie.
   *
   * Called once during bootstrap. A failure is not an error worth surfacing — it just means the
   * visitor is not signed in.
   */
  async restore(): Promise<void> {
    try {
      const tokens = await firstValueFrom(
        this.http.post<AuthTokensResponse>('/api/auth/refresh', {}),
      );
      if (!tokens.accessToken) {
        this.clear();
        return;
      }
      this.accessTokenSignal.set(tokens.accessToken);
      await this.loadSession();
    } catch {
      this.clear();
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
