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
  private readonly loadingSignal = signal(false);

  readonly profile = this.profileSignal.asReadonly();
  readonly sessions = this.sessionsSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();

  /** Read the profile and the live sessions together; the screen renders both under one spinner. */
  async load(): Promise<void> {
    this.loadingSignal.set(true);
    try {
      const [profile, sessions] = await Promise.all([
        firstValueFrom(this.http.get<Profile>('/api/auth/profile')),
        firstValueFrom(this.http.get<readonly AccountSession[]>('/api/auth/sessions')),
      ]);
      this.profileSignal.set(profile);
      this.sessionsSignal.set(sessions);
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
