import { describe, expect, it } from 'vitest';

import {
  AI_CONSENT_POLICY_VERSION,
  CONSENT_KINDS,
  canChangeConsent,
  egressDestinations,
  egressFor,
  needsConsent,
  purposeToAsk,
  stateOf,
  type AiEgressEntry,
  type ConsentRecord,
} from './consent.view';

/**
 * The consent surface's decisions, without a DOM — docs/08 §6.6, ADR-032.
 *
 * The two that matter are "is there anything to permit?" and "should we ask at all?", because getting
 * either wrong produces a specific defect: a sheet that asks permission for traffic that stays on this
 * server, or one that keeps asking somebody who already declined.
 */
function route(overrides: Partial<AiEgressEntry> = {}): AiEgressEntry {
  return {
    purpose: 'AI_DATA_PROCESSING',
    task: 'CLASSIFY',
    endpoint: 'DEEPSEEK_GLOBAL',
    provider: 'DEEPSEEK',
    region: 'NON_EEA',
    requiresConsent: true,
    ...overrides,
  };
}

function record(kind: ConsentRecord['kind'], state: ConsentRecord['state']): ConsentRecord {
  return { kind, state, recordedAt: null, policyVersion: null, purposes: [] };
}

describe('the consent view', () => {
  it('needs permission only for a route that genuinely leaves the EEA', () => {
    expect(needsConsent([route()], 'AI_DATA_PROCESSING')).toBe(true);
    // LOCAL is this node; an `_EU` endpoint is an EEA processor. Neither is a transfer, so neither is a
    // question — asking would ask about nothing.
    expect(
      needsConsent([route({ endpoint: 'LOCAL', region: 'LOCAL', requiresConsent: false })], 'AI_DATA_PROCESSING'),
    ).toBe(false);
    expect(
      needsConsent([route({ endpoint: 'DEEPSEEK_EU', region: 'EEA', requiresConsent: false })], 'AI_DATA_PROCESSING'),
    ).toBe(false);
  });

  it('has nothing to permit for a purpose no route carries', () => {
    // `CLOUD_OCR` on this deployment: OCR is unrouted, so there is no OCR decision to put to anybody.
    expect(needsConsent([route()], 'CLOUD_OCR')).toBe(false);
    expect(egressFor([route()], 'CLOUD_OCR')).toEqual([]);
    expect(egressDestinations([route()], 'CLOUD_OCR')).toEqual([]);
  });

  it('names a destination once, however many tasks ride it', () => {
    // Measured live on 2026-09-17: `CLASSIFY` and `NARRATE` both routed to `DEEPSEEK_GLOBAL`, and the
    // card printed the identical sentence twice. A route row is per task because a router routes tasks;
    // a sentence is per place, because that is what somebody is deciding about.
    expect(
      egressDestinations([route(), route({ task: 'NARRATE' })], 'AI_DATA_PROCESSING'),
    ).toEqual([{ provider: 'DEEPSEEK', region: 'NON_EEA' }]);
  });

  it('keeps destinations apart when either half of the pair differs, in the API’s order', () => {
    expect(
      egressDestinations(
        [
          route(),
          route({ task: 'NARRATE', endpoint: 'DEEPSEEK_EU', region: 'EEA', requiresConsent: false }),
          route({ task: 'PARSE', provider: 'OPENAI', region: 'EEA', requiresConsent: false }),
        ],
        'AI_DATA_PROCESSING',
      ),
    ).toEqual([
      { provider: 'DEEPSEEK', region: 'NON_EEA' },
      { provider: 'DEEPSEEK', region: 'EEA' },
      { provider: 'OPENAI', region: 'EEA' },
    ]);
  });

  it('asks once for an unasked purpose, and never again after a decline or a withdrawal', () => {
    const egress = [route()];

    expect(purposeToAsk([], egress)).toBe('AI_DATA_PROCESSING');
    expect(purposeToAsk([record('AI_DATA_PROCESSING', 'NOT_ASKED')], egress)).toBe('AI_DATA_PROCESSING');
    // `DECLINED` and `WITHDRAWN` are answers. Asking on the next capture is the nagging §6.6 calls out as
    // a dark pattern, and the way back is settings.
    expect(purposeToAsk([record('AI_DATA_PROCESSING', 'DECLINED')], egress)).toBeNull();
    expect(purposeToAsk([record('AI_DATA_PROCESSING', 'WITHDRAWN')], egress)).toBeNull();
    expect(purposeToAsk([record('AI_DATA_PROCESSING', 'GRANTED')], egress)).toBeNull();
  });

  it('does not ask when the deployment has nowhere to send anything', () => {
    expect(purposeToAsk([], [])).toBeNull();
    expect(purposeToAsk([], [route({ requiresConsent: false })])).toBeNull();
  });

  it('treats a missing record as NOT_ASKED rather than as permission', () => {
    // Absence of consent is never permission (docs/08 §6.6) — and the state must be *reportable*, which
    // is why NOT_ASKED is a value rather than a missing row.
    expect(stateOf([], 'AI_DATA_PROCESSING')).toBe('NOT_ASKED');
    expect(stateOf([record('AI_DATA_PROCESSING', 'GRANTED')], 'CLOUD_OCR')).toBe('NOT_ASKED');
  });

  it('lets only an OWNER change a decision', () => {
    expect(canChangeConsent('OWNER')).toBe(true);
    for (const role of ['ADMIN', 'MEMBER', 'VIEWER', null]) expect(canChangeConsent(role)).toBe(false);
  });

  it('pins the copy revision this build renders', () => {
    // docs/08 §6.6 makes a material change to the copy force re-consent, which only works if the version
    // stored is the one of the text the person read. The API pins the same literal, so a drift between the
    // two is a failing test rather than a record against copy nobody saw.
    expect(AI_CONSENT_POLICY_VERSION).toBe('2026-09-ai-egress-1');
    expect(CONSENT_KINDS).toEqual(['AI_DATA_PROCESSING', 'CLOUD_OCR', 'EVAL_DATASET']);
  });
});
