import { Injectable, computed, inject, signal } from '@angular/core';

import { ErrorMessageService } from '../api/error-message.service';
import { GraphqlClient } from '../graphql/graphql.client';
import { I18nService } from '../i18n/i18n.service';
import {
  AI_CONSENT_POLICY_VERSION,
  purposeToAsk,
  stateOf,
  type AiEgressEntry,
  type ConsentKind,
  type ConsentRecord,
  type ConsentState,
  type RecordableConsentState,
} from './consent.view';

/**
 * The Household's AI consent, and what this deployment would send where — docs/08 §6.6, ADR-032.
 *
 * ## Two questions, one request
 *
 * The screen needs the **state** (`aiConsents`) and the **disclosure** (`aiEgress`), and they come from
 * one document because a consent screen that rendered a decision without saying what it permits would be
 * exactly the dark pattern §6.6 forbids. The egress rows are the deployment's configuration, not the
 * Household's data, so they are the same for everyone — and they are what makes the sheet truthful
 * instead of hardcoded: the client names the provider and region the *server* would use.
 *
 * ## The state is the server's, and it is re-read after every write
 *
 * A withdrawal has to take effect before the next AI call (§6.6), which the API enforces by asking the
 * gate per call. The client does not need to be clever about that; it does need to stop *showing* a
 * grant it no longer holds, so every write re-reads rather than patching the local list with what it
 * hoped the answer was. The append-only history means the newest row is the state, and only the server
 * knows which row that is.
 *
 * ## Failure is shown, never assumed
 *
 * A refused write leaves the previous state on screen and reports why: recording consent against a
 * Household the session cannot write to is the one thing this screen must not appear to have done.
 *
 * @module apps/web/src/app/core/consent
 */
@Injectable({ providedIn: 'root' })
export class ConsentService {
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly i18n = inject(I18nService);

  private readonly records = signal<readonly ConsentRecord[]>([]);
  private readonly egress = signal<readonly AiEgressEntry[]>([]);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /** Every purpose's current state, as the server last reported it. */
  readonly states = this.records.asReadonly();

  /** What this deployment would send where. Empty means nothing leaves this server. */
  readonly routes = this.egress.asReadonly();

  /**
   * The purpose a first-use sheet should offer, or `null`.
   *
   * `null` covers three different situations a caller must not conflate: nothing is routed anywhere, the
   * Household has already decided, or the question has not been loaded yet. Callers that need to tell
   * them apart read {@link states} and {@link routes}.
   */
  readonly askable = computed(() => purposeToAsk(this.records(), this.egress()));

  /** So a caller can label a row without a second lookup. */
  state(kind: ConsentKind): ConsentState {
    return stateOf(this.records(), kind);
  }

  /** Read the state and the disclosure. Safe to call more than once; the last answer wins. */
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{
        aiConsents: readonly ConsentRecord[];
        aiEgress: readonly AiEgressEntry[];
      }>(CONSENT_QUERY);
      this.records.set(result.aiConsents);
      this.egress.set(result.aiEgress);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Record a decision, then re-read the state.
   *
   * `surface` is the screen that showed the copy and `locale` the language it was shown in: both are
   * recorded as evidence (docs/03 §4's `evidence` JSON), so a record can be traced to the exact text a
   * person agreed to. The policy version is this client's, for the reason `AI_CONSENT_POLICY_VERSION`
   * gives.
   *
   * @returns whether the write succeeded, so a sheet can stay open on a refusal.
   */
  async record(
    kind: ConsentKind,
    state: RecordableConsentState,
    surface: string,
  ): Promise<boolean> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(RECORD_CONSENT, {
        input: {
          kind,
          state,
          policyVersion: AI_CONSENT_POLICY_VERSION,
          surface,
          locale: this.i18n.tag(),
        },
      });
      // Re-read rather than patch: the newest row is the state (the table is append-only), and a local
      // guess about which row that is would be a second implementation of the API's own rule.
      await this.load();
      return true;
    } catch (error) {
      this.error.set(this.errors.for(error));
      return false;
    } finally {
      this.saving.set(false);
    }
  }
}

const CONSENT_QUERY = /* GraphQL */ `
  query Consent {
    aiConsents {
      kind
      state
      recordedAt
      policyVersion
      purposes
    }
    aiEgress {
      purpose
      task
      endpoint
      provider
      region
      requiresConsent
    }
  }
`;

const RECORD_CONSENT = /* GraphQL */ `
  mutation RecordAiConsent($input: RecordConsentInput!) {
    recordAiConsent(input: $input) {
      kind
      state
    }
  }
`;
