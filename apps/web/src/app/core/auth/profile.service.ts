import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/**
 * The account's own profile, as `GET /auth/profile` returns it (docs/06 §2).
 *
 * `emailVerified` and `pendingEmail` are separate fields rather than a status string, because the
 * screen has to say three different things: confirmed, not yet confirmed, and *a change is waiting
 * for its link*. A single enum would collapse the third into the second.
 */
export interface Profile {
  readonly userId: string;
  readonly email: string;
  /** A staged address change awaiting its confirmation link, or `null`. */
  readonly pendingEmail: string | null;
  readonly displayName: string;
  readonly locale: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
}

/**
 * One live session.
 *
 * There is deliberately no device name: the API stores only hashes of the User-Agent and IP
 * (docs/08 §3.9), so the screen shows when the session started and when it was last used, and does
 * not invent a device it cannot identify.
 */
export interface AccountSession {
  readonly id: string;
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

/** The profile screen's view of an account's second factors (ADR-041). */
export interface MfaState {
  readonly totpEnabled: boolean;
  readonly emailOtpEnabled: boolean;
  /** Whether this deployment can enrol an authenticator at all (`MFA_ENCRYPTION_KEY` present). */
  readonly totpAvailable: boolean;
  readonly recoveryCodesRemaining: number;
}

/** A TOTP enrolment in progress: the secret and the URI that encodes it, shown once. */
export interface TotpSetup {
  readonly secret: string;
  readonly otpauthUri: string;
}

/**
 * What a profile load managed to read.
 *
 * The identity is required — without it there is nothing honest to render — but the session list and
 * the factor panel **degrade**: one of them failing must not blank the screen. That is not
 * hypothetical: a deployment serving the previous release answered `404` for `/auth/mfa`, and a
 * `Promise.all` over the three turned a working profile page into "failed to load" with nothing on
 * it.
 */
export interface ProfileLoadResult {
  readonly sessionsFailed: boolean;
  readonly mfaFailed: boolean;
}

/**
 * The profile screen's data and writes (docs/02 §4.18's **Profil** section).
 *
 * Kept out of `AuthStore`, which owns *whether* there is a session and is read by guards on every
 * navigation. This service is read by one screen on demand, so its state is not app-wide — the one
 * exception being the display name, which the shell's account block shows; a rename therefore asks
 * `AuthStore` to refresh as well as updating this.
 */
@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly http = inject(HttpClient);

  private readonly profileSignal = signal<Profile | null>(null);
  private readonly sessionsSignal = signal<readonly AccountSession[]>([]);
  private readonly mfaSignal = signal<MfaState | null>(null);
  private readonly loadingSignal = signal(false);
  private cached: ProfileLoadResult | null = null;

  readonly profile = this.profileSignal.asReadonly();
  readonly sessions = this.sessionsSignal.asReadonly();
  readonly mfa = this.mfaSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();

  /**
   * Load once, then serve the cache.
   *
   * The account shell's **Account** and **Security** panes are separate components that both read
   * this service, and either can be the first one shown — so without the guard, switching tabs would
   * re-fetch the profile, the session list and the factor state on every switch. A `load()` that
   * threw leaves the cache empty, so a failed identity read is retried on the next mount.
   */
  async ensureLoaded(): Promise<ProfileLoadResult> {
    if (this.cached !== null) return this.cached;
    const result = await this.load();
    this.cached = result;
    return result;
  }

  /**
   * Read the profile, the live sessions and the factor state together.
   *
   * `allSettled`, not `all`: the identity is the screen, so its failure propagates, but the other two
   * sections report their own failure and the rest of the page still renders. A `Promise.all` here
   * meant any single `404`/`500` produced an empty "failed to load".
   */
  async load(): Promise<ProfileLoadResult> {
    this.loadingSignal.set(true);
    try {
      const [profile, sessions, mfa] = await Promise.allSettled([
        firstValueFrom(this.http.get<Profile>('/api/auth/profile')),
        firstValueFrom(this.http.get<readonly AccountSession[]>('/api/auth/sessions')),
        firstValueFrom(this.http.get<MfaState>('/api/auth/mfa')),
      ]);

      if (profile.status === 'rejected') throw profile.reason;
      this.profileSignal.set(profile.value);

      if (sessions.status === 'fulfilled') this.sessionsSignal.set(sessions.value);
      else this.sessionsSignal.set([]);
      if (mfa.status === 'fulfilled') this.mfaSignal.set(mfa.value);
      else this.mfaSignal.set(null);

      return {
        sessionsFailed: sessions.status === 'rejected',
        mfaFailed: mfa.status === 'rejected',
      };
    } finally {
      this.loadingSignal.set(false);
    }
  }

  /** Rename. Returns the stored value so the form can show what actually landed. */
  async rename(displayName: string): Promise<Profile> {
    await firstValueFrom(this.http.patch('/api/auth/profile', { displayName }));
    return this.reloadProfile();
  }

  /**
   * Change the password. The API requires the current one and revokes every *other* session, so the
   * list is reloaded rather than assumed.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await firstValueFrom(
      this.http.post('/api/auth/change-password', { currentPassword, newPassword }),
    );
    await this.reloadSessions();
  }

  /**
   * Ask for a confirmation link on a new address.
   *
   * Nothing is applied here: the API stages the address and mails it. The returned profile is
   * re-read so the screen can show the staged address rather than pretending the change happened.
   */
  async changeEmail(email: string, password: string): Promise<Profile> {
    await firstValueFrom(this.http.post('/api/auth/change-email', { email, password }));
    return this.reloadProfile();
  }

  /** End one session. `current` in the answer means the caller has just signed itself out. */
  async revokeSession(id: string): Promise<{ revoked: boolean; current: boolean }> {
    const result = await firstValueFrom(
      this.http.delete<{ revoked: boolean; current: boolean }>(`/api/auth/sessions/${id}`),
    );
    await this.reloadSessions();
    return result;
  }

  /** End every other session. Returns how many were ended, so the screen can say so. */
  async revokeOtherSessions(): Promise<number> {
    const result = await firstValueFrom(
      this.http.post<{ revoked: number }>('/api/auth/sessions/revoke-others', {}),
    );
    await this.reloadSessions();
    return result.revoked;
  }

  // -------------------------------------------------------------------------------------------
  // Two-factor authentication (ADR-041). Every mutation sends the password: the API re-authenticates
  // before it touches a factor, and the screen asks for it once for all of them.
  // -------------------------------------------------------------------------------------------

  /** Re-read just the factor state, after a change that may have minted recovery codes. */
  async reloadMfa(): Promise<MfaState> {
    const state = await firstValueFrom(this.http.get<MfaState>('/api/auth/mfa'));
    this.mfaSignal.set(state);
    return state;
  }

  /** Begin enrolling an authenticator; the secret and URI are returned exactly once. */
  async startTotpSetup(password: string): Promise<TotpSetup> {
    return firstValueFrom(
      this.http.post<TotpSetup>('/api/auth/mfa/totp/setup', { password }),
    );
  }

  /** Confirm the authenticator with one code; the returned recovery codes are shown once. */
  async enableTotp(password: string, code: string): Promise<string[]> {
    const result = await firstValueFrom(
      this.http.post<{ recoveryCodes: string[] }>('/api/auth/mfa/totp/enable', { password, code }),
    );
    await this.reloadMfa();
    return result.recoveryCodes;
  }

  async disableTotp(password: string): Promise<void> {
    await firstValueFrom(this.http.post('/api/auth/mfa/totp/disable', { password }));
    await this.reloadMfa();
  }

  /** Turn the emailed-code factor on or off; codes are returned only when enabling minted them. */
  async setEmailOtp(password: string, enabled: boolean): Promise<string[]> {
    const result = await firstValueFrom(
      this.http.post<{ recoveryCodes: string[] }>('/api/auth/mfa/email', { password, enabled }),
    );
    await this.reloadMfa();
    return result.recoveryCodes;
  }

  /** Replace every unused recovery code with a fresh set, returned once. */
  async regenerateRecoveryCodes(password: string): Promise<string[]> {
    const result = await firstValueFrom(
      this.http.post<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', { password }),
    );
    await this.reloadMfa();
    return result.recoveryCodes;
  }

  private async reloadProfile(): Promise<Profile> {
    const profile = await firstValueFrom(this.http.get<Profile>('/api/auth/profile'));
    this.profileSignal.set(profile);
    return profile;
  }

  private async reloadSessions(): Promise<void> {
    const sessions = await firstValueFrom(
      this.http.get<readonly AccountSession[]>('/api/auth/sessions'),
    );
    this.sessionsSignal.set(sessions);
  }
}
