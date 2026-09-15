/**
 * Confidence calibration — docs/04 §6.4, docs/10 §5.7, ADR-009.
 *
 * These tests are deliberately arithmetic-heavy. The gate decides whether a suggestion is applied to
 * the Household's money without asking, so a mapping that is wrong by a few hundredths, or that is
 * non-monotone, moves rows between the auto-apply and ask lanes — a failure a 70 % line-coverage
 * floor would happily hide.
 *
 * @module @finmate/ai
 */

import { describe, expect, it } from 'vitest';

import {
  AUTO_APPLY_MIN,
  CALIBRATION_MAP_VERSION,
  DEFAULT_LANE_THRESHOLDS,
  MIN_CALIBRATION_SAMPLES,
  SHRINK_FACTOR,
  VERIFY_MIN,
  applyCalibrationMap,
  asRawConfidence,
  buildCalibrationTable,
  calibrate,
  calibratedConfidenceFromStorage,
  calibrationKeyFromPrompt,
  calibrationKeyId,
  fitCalibrationMap,
  isValidCalibrationMap,
  laneFor,
  needsReview,
  parseCalibrationMap,
  shrinkCalibrationMap,
  type CalibratedConfidence,
  type CalibrationKey,
  type CalibrationMap,
  type CalibrationSample,
  type RawConfidence,
} from './calibration';

const KEY: CalibrationKey = {
  task: 'CLASSIFY',
  model: 'deepseek-chat',
  promptVersion: 'classify.serbian-household@3',
};

/** `accepted` samples at `raw`, then `rejected` ones — the shape the nightly job reads from the DB. */
function samplesOf(raw: number, accepted: number, rejected: number): CalibrationSample[] {
  return [
    ...Array.from({ length: accepted }, () => ({ raw, accepted: true })),
    ...Array.from({ length: rejected }, () => ({ raw, accepted: false })),
  ];
}

/** A deterministic LCG: the property test must fail reproducibly, not flakily. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("the spec's constants", () => {
  it('uses the documented numbers, not tunable ones', () => {
    expect(MIN_CALIBRATION_SAMPLES).toBe(200);
    expect(SHRINK_FACTOR).toBe(0.85);
    expect(AUTO_APPLY_MIN).toBe(0.9);
    expect(VERIFY_MIN).toBe(0.6);
    expect(CALIBRATION_MAP_VERSION).toBe(1);
    expect(DEFAULT_LANE_THRESHOLDS).toEqual({ autoApplyMin: 0.9, verifyMin: 0.6 });
  });
});

describe('the conservative shrink (docs/04 §6.4)', () => {
  it('turns a raw 0.95 that would auto-apply into a 0.8075 that must be verified', () => {
    const map = fitCalibrationMap(KEY, []);
    expect(map.strategy).toBe('shrink');

    // The arithmetic §6.4 specifies, written out:
    //   raw 0.95 × 0.85 = 0.8075, which is below the 0.90 auto-apply threshold.
    expect(0.95 * SHRINK_FACTOR).toBe(0.8075);
    expect(0.95).toBeGreaterThanOrEqual(AUTO_APPLY_MIN);

    const calibrated = applyCalibrationMap(asRawConfidence(0.95), map);
    expect(calibrated).toBe(0.8075);
    expect(calibrated).toBeLessThan(AUTO_APPLY_MIN);
    expect(calibrated).toBeGreaterThanOrEqual(VERIFY_MIN);
    expect(laneFor(calibrated)).toBe('VERIFY');
  });

  it('shrinks a raw 0.65 all the way into the ask lane', () => {
    // 0.65 × 0.85 = 0.5525 < 0.60, so an uncalibrated model that sounds nearly confident is asked.
    const calibrated = calibrate(asRawConfidence(0.65), KEY);
    expect(calibrated).toBe(0.5525);
    expect(calibrated).toBeLessThan(VERIFY_MIN);
    expect(laneFor(calibrated)).toBe('ASK');
    expect(needsReview(calibrated)).toBe(true);
  });

  it('falls back to the shrink for a key the table has never seen, without the caller asking', () => {
    const table = buildCalibrationTable([fitCalibrationMap(KEY, samplesOf(0.5, 200, 0))]);
    const unseen: CalibrationKey = { task: 'CLASSIFY', model: 'gpt-4o', promptVersion: 'v9' };
    expect(calibrate(asRawConfidence(0.9), unseen, table)).toBe(0.9 * SHRINK_FACTOR);
  });
});

describe('the 200-sample boundary', () => {
  // 100 accepted and 100 rejected at raw 0.90. At 199 samples the fit is refused and the shrink
  // applies (0.90 × 0.85 = 0.765); at 200 the isotonic fit runs and pools the bucket to 100/200.
  const at199 = samplesOf(0.9, 100, 99);
  const at200 = samplesOf(0.9, 100, 100);
  const raw = asRawConfidence(0.9);

  it('does not use the fit one sample below the threshold', () => {
    expect(at199).toHaveLength(199);
    const map = fitCalibrationMap(KEY, at199);
    expect(map.strategy).toBe('shrink');
    expect(map.sampleCount).toBe(199);
    expect(map.points).toEqual([]);
    expect(applyCalibrationMap(raw, map)).toBe(0.765);
  });

  it('switches to the fitted map exactly at 200', () => {
    expect(at200).toHaveLength(200);
    const map = fitCalibrationMap(KEY, at200);
    expect(map.strategy).toBe('isotonic');
    expect(map.sampleCount).toBe(200);
    expect(map.acceptedCount).toBe(100);
    // One bucket of ties: every sample has raw 0.90, so PAVA pools it to 100/200 = 0.50.
    expect(map.points).toEqual([{ raw: 0.9, calibrated: 0.5 }]);
    expect(applyCalibrationMap(raw, map)).toBe(0.5);
  });

  it('produces a materially different gate decision on the two sides of the boundary', () => {
    const shrunk = applyCalibrationMap(raw, fitCalibrationMap(KEY, at199));
    const fitted = applyCalibrationMap(raw, fitCalibrationMap(KEY, at200));
    expect(shrunk).not.toBe(fitted);
    expect(laneFor(shrunk)).toBe('VERIFY');
    expect(laneFor(fitted)).toBe('ASK');
  });
});

describe('PAVA on hand-computed examples', () => {
  it('pools a cascade of violators into one block (weighted, ties aggregated)', () => {
    // Buckets, in ascending raw order (each raw value repeats, so ties are aggregated first):
    //
    //   raw 0.10: 40 accepted, 10 rejected → 40/50  = 0.80, weight 50
    //   raw 0.20: 10 accepted, 40 rejected → 10/50  = 0.20, weight 50
    //   raw 0.30: 20 accepted, 80 rejected → 20/100 = 0.20, weight 100
    //
    // PAVA trace:
    //   push (0.10, 0.80, w50)
    //   push (0.20, 0.20, w50): 0.80 > 0.20 → pool
    //        (40 + 10) / (50 + 50) = 50 / 100 = 0.50          block [0.10, 0.20]
    //   push (0.30, 0.20, w100): 0.50 > 0.20 → pool, and the cascade carries on leftwards
    //        (40 + 10 + 20) / (50 + 50 + 100) = 70 / 200 = 0.35 block [0.10, 0.30]
    //
    // One block remains, so the mapping is constant 0.35 across the whole observed range.
    const samples = [
      ...samplesOf(0.1, 40, 10),
      ...samplesOf(0.2, 10, 40),
      ...samplesOf(0.3, 20, 80),
    ];
    expect(samples).toHaveLength(200);

    const map = fitCalibrationMap(KEY, samples);
    expect(map.strategy).toBe('isotonic');
    expect(map.acceptedCount).toBe(70);
    expect(map.points).toEqual([{ raw: 0.1, calibrated: 0.35 }]);

    for (const probe of [0, 0.05, 0.1, 0.25, 0.3, 0.99, 1]) {
      expect(applyCalibrationMap(asRawConfidence(probe), map)).toBe(0.35);
    }
  });

  it('keeps two blocks when the violation is local, and looks a raw value up as a step', () => {
    //   raw 0.20: 50 accepted,  0 rejected → 50/50  = 1.00, weight 50
    //   raw 0.40:  0 accepted, 50 rejected →  0/50  = 0.00, weight 50
    //   raw 0.60: 50 accepted,  0 rejected → 50/50  = 1.00, weight 50
    //   raw 0.80: 50 accepted,  0 rejected → 50/50  = 1.00, weight 50
    //
    // PAVA trace:
    //   push (0.20, 1.00, w50)
    //   push (0.40, 0.00, w50): 1.00 > 0.00 → pool (50 + 0) / 100 = 0.50   block [0.20, 0.40]
    //   push (0.60, 1.00, w50): 0.50 ≤ 1.00 → keep                         block [0.60]
    //   push (0.80, 1.00, w50): 1.00 ≤ 1.00 → keep                         block [0.80]
    //
    // → [{ raw: 0.20, calibrated: 0.50 }, { raw: 0.60, calibrated: 1.00 }, { raw: 0.80, ... }]
    const samples = [
      ...samplesOf(0.2, 50, 0),
      ...samplesOf(0.4, 0, 50),
      ...samplesOf(0.6, 50, 0),
      ...samplesOf(0.8, 50, 0),
    ];
    const map = fitCalibrationMap(KEY, samples);
    expect(map.points).toEqual([
      { raw: 0.2, calibrated: 0.5 },
      { raw: 0.6, calibrated: 1 },
      { raw: 0.8, calibrated: 1 },
    ]);

    // The step holds the lower block's value through the gap to the next observed raw.
    const expected: readonly (readonly [number, number])[] = [
      [0, 0.5],
      [0.2, 0.5],
      [0.3, 0.5],
      [0.4, 0.5],
      [0.5, 0.5],
      [0.6, 1],
      [0.7, 1],
      [0.8, 1],
      [1, 1],
    ];
    for (const [probe, value] of expected) {
      expect(applyCalibrationMap(asRawConfidence(probe), map)).toBe(value);
    }
  });
});

describe('degenerate fits', () => {
  it('returns the shrink for zero samples', () => {
    const map = fitCalibrationMap(KEY, []);
    expect(map).toEqual(shrinkCalibrationMap(KEY));
    expect(map.sampleCount).toBe(0);
    expect(map.acceptedCount).toBe(0);
  });

  it('returns the shrink for a single sample', () => {
    const map = fitCalibrationMap(KEY, samplesOf(0.9, 1, 0));
    expect(map.strategy).toBe('shrink');
    expect(map.sampleCount).toBe(1);
    expect(map.acceptedCount).toBe(1);
    // One observation is not evidence, so the conservative shrink still applies.
    expect(applyCalibrationMap(asRawConfidence(0.9), map)).toBe(0.765);
  });

  it('fits acceptance 1 when every observation was accepted', () => {
    const map = fitCalibrationMap(KEY, [
      ...samplesOf(0.3, 120, 0),
      ...samplesOf(0.9, 80, 0),
    ]);
    expect(map.acceptedCount).toBe(200);
    // Equal adjacent means are not a violation, so they are not pooled — but the mapping is a
    // constant 1 either way.
    expect(map.points).toEqual([
      { raw: 0.3, calibrated: 1 },
      { raw: 0.9, calibrated: 1 },
    ]);
    expect(applyCalibrationMap(asRawConfidence(0.05), map)).toBe(1);
  });

  it('fits a constant 0 when none was accepted, which is the ask lane', () => {
    const map = fitCalibrationMap(KEY, samplesOf(0.99, 0, 200));
    expect(map.points).toEqual([{ raw: 0.99, calibrated: 0 }]);
    expect(laneFor(applyCalibrationMap(asRawConfidence(1), map))).toBe('ASK');
  });

  it('is insensitive to the arrival order of ties', () => {
    // The same 200 observations, interleaved rather than grouped. Aggregating by raw first is what
    // makes the fit a function of the sample *multiset* rather than of arrival order.
    const interleaved: CalibrationSample[] = [];
    for (let index = 0; index < 200; index += 1) {
      interleaved.push({ raw: 0.5, accepted: index % 5 < 2 });
    }
    const grouped = samplesOf(0.5, 80, 120);

    const fromInterleaved = fitCalibrationMap(KEY, interleaved);
    const fromGrouped = fitCalibrationMap(KEY, grouped);
    expect(fromInterleaved.points).toEqual([{ raw: 0.5, calibrated: 0.4 }]);
    expect(fromInterleaved).toEqual(fromGrouped);
  });
});

describe('monotonicity is a property of the fit, not of one example', () => {
  it('never maps a higher raw confidence to a lower calibrated one', () => {
    const random = lcg(0x5eed);
    const samples: CalibrationSample[] = [];
    for (let index = 0; index < 600; index += 1) {
      // Two decimal places creates plenty of ties; acceptance rises with raw plus noise, which
      // creates the adjacent violators PAVA exists to pool.
      const raw = Math.round(random() * 100) / 100;
      samples.push({ raw, accepted: random() < raw * 0.7 + 0.1 });
    }

    const map = fitCalibrationMap(KEY, samples);
    expect(map.strategy).toBe('isotonic');
    expect(map.sampleCount).toBe(600);

    // The emitted table is ordered and non-decreasing...
    let previousRaw = -1;
    let previousCalibrated = -1;
    for (const point of map.points) {
      expect(point.raw).toBeGreaterThan(previousRaw);
      expect(point.calibrated).toBeGreaterThanOrEqual(previousCalibrated);
      expect(point.raw).toBeGreaterThanOrEqual(0);
      expect(point.raw).toBeLessThanOrEqual(1);
      expect(point.calibrated).toBeGreaterThanOrEqual(0);
      expect(point.calibrated).toBeLessThanOrEqual(1);
      previousRaw = point.raw;
      previousCalibrated = point.calibrated;
    }

    // ...and so is the applied mapping over a dense sweep of raw values.
    const probes = Array.from({ length: 2001 }, (_value, index) => index / 2000);
    let previous = -1;
    for (const probe of probes) {
      const calibrated = applyCalibrationMap(asRawConfidence(probe), map);
      expect(calibrated).toBeGreaterThanOrEqual(previous);
      expect(calibrated).toBeGreaterThanOrEqual(0);
      expect(calibrated).toBeLessThanOrEqual(1);
      previous = calibrated;
    }
  });
});

describe('the map is keyed by (task, model, prompt_version)', () => {
  const keyA: CalibrationKey = { task: 'CLASSIFY', model: 'model-a', promptVersion: 'p@1' };
  const keyB: CalibrationKey = { task: 'CLASSIFY', model: 'model-b', promptVersion: 'p@1' };
  const keyC: CalibrationKey = { task: 'CLASSIFY', model: 'model-a', promptVersion: 'p@2' };

  it('does not share a mapping between two keys', () => {
    const table = buildCalibrationTable([
      fitCalibrationMap(keyA, samplesOf(0.5, 200, 0)),
      fitCalibrationMap(keyB, samplesOf(0.5, 0, 200)),
    ]);
    const raw = asRawConfidence(0.5);
    expect(calibrate(raw, keyA, table)).toBe(1);
    expect(calibrate(raw, keyB, table)).toBe(0);
    // A prompt change is a different key, so its map starts from the shrink.
    expect(calibrate(raw, keyC, table)).toBe(0.425);
  });

  it('gives different keys different ids', () => {
    expect(calibrationKeyId(keyA)).not.toBe(calibrationKeyId(keyB));
    expect(calibrationKeyId(keyA)).not.toBe(calibrationKeyId(keyC));
    expect(calibrationKeyId(keyB)).not.toBe(calibrationKeyId(keyC));
  });

  it('cannot collide when the parts contain the natural separator characters', () => {
    // A naively joined id ("a|b" + "|" + "c" vs "a" + "|" + "b|c") would collide here and silently
    // share one mapping between two keys.
    const left: CalibrationKey = { task: 'CLASSIFY', model: 'a|b', promptVersion: 'c' };
    const right: CalibrationKey = { task: 'CLASSIFY', model: 'a', promptVersion: 'b|c' };
    expect(calibrationKeyId(left)).not.toBe(calibrationKeyId(right));
  });

  it('composes a key from a PromptRef', () => {
    expect(
      calibrationKeyFromPrompt('CLASSIFY', 'deepseek-chat', {
        templateId: 'classify.serbian-household',
        version: '3',
      }),
    ).toEqual(KEY);
  });

  it('lets a later map for the same key win in the table', () => {
    const first = fitCalibrationMap(keyA, samplesOf(0.5, 200, 0));
    const second = fitCalibrationMap(keyA, samplesOf(0.5, 0, 200));
    const table = buildCalibrationTable([first, second]);
    expect(calibrate(asRawConfidence(0.5), keyA, table)).toBe(0);
  });
});

describe('a stored map applies exactly like a freshly fitted one', () => {
  const samples = [
    ...samplesOf(0.2, 50, 0),
    ...samplesOf(0.4, 0, 50),
    ...samplesOf(0.6, 50, 0),
    ...samplesOf(0.8, 50, 0),
  ];

  function roundTrip(map: CalibrationMap): CalibrationMap {
    const parsed = parseCalibrationMap(JSON.parse(JSON.stringify(map)));
    expect(parsed).not.toBeNull();
    return parsed as CalibrationMap;
  }

  it('round-trips an isotonic map through JSON with identical output', () => {
    const fresh = fitCalibrationMap(KEY, samples);
    const stored = roundTrip(fresh);
    expect(stored).toEqual(fresh);
    for (let index = 0; index <= 100; index += 1) {
      const raw = asRawConfidence(index / 100);
      expect(applyCalibrationMap(raw, stored)).toBe(applyCalibrationMap(raw, fresh));
    }
  });

  it('round-trips a shrink map through JSON with identical output', () => {
    const fresh = fitCalibrationMap(KEY, []);
    const stored = roundTrip(fresh);
    expect(stored).toEqual(fresh);
    expect(stored.strategy).toBe('shrink');
    expect(applyCalibrationMap(asRawConfidence(0.95), stored)).toBe(0.8075);
  });

  it('survives a JSON round-trip as a whole table', () => {
    const table = buildCalibrationTable([
      fitCalibrationMap(KEY, samples),
      fitCalibrationMap({ task: 'CLASSIFY', model: 'other', promptVersion: 'v1' }, []),
    ]);
    const restored = JSON.parse(JSON.stringify(table)) as Record<string, unknown>;
    const rebuiltEntries = Object.values(restored)
      .map((entry) => parseCalibrationMap(entry))
      .filter((entry): entry is CalibrationMap => entry !== null);
    expect(rebuiltEntries).toHaveLength(2);
    const rebuilt = buildCalibrationTable(rebuiltEntries);
    expect(calibrate(asRawConfidence(0.2), KEY, rebuilt)).toBe(
      calibrate(asRawConfidence(0.2), KEY, table),
    );
  });
});

describe('out-of-range values are handled, never propagated', () => {
  it('clamps a raw confidence that the model should never have sent', () => {
    expect(asRawConfidence(1.4)).toBe(1);
    expect(asRawConfidence(-0.2)).toBe(0);
    expect(asRawConfidence(Number.NaN)).toBe(0);
    expect(asRawConfidence(Number.POSITIVE_INFINITY)).toBe(0);
    expect(asRawConfidence('0.9')).toBe(0);
    expect(asRawConfidence(undefined)).toBe(0);
  });

  it('keeps an over-range raw value inside 0..1 all the way through the mapping', () => {
    const map = fitCalibrationMap(KEY, samplesOf(0.5, 200, 0));
    expect(applyCalibrationMap(5 as RawConfidence, map)).toBeLessThanOrEqual(1);
    expect(applyCalibrationMap(-5 as RawConfidence, map)).toBeGreaterThanOrEqual(0);
    expect(applyCalibrationMap(asRawConfidence(2), shrinkCalibrationMap(KEY))).toBe(0.85);
  });

  it('clamps a corrupt map rather than letting it breach 0..1', () => {
    const shrink = shrinkCalibrationMap(KEY);
    const overShrink = { ...shrink, shrinkFactor: 5 } as CalibrationMap;
    const underShrink = { ...shrink, shrinkFactor: -3 } as CalibrationMap;
    expect(applyCalibrationMap(asRawConfidence(0.9), overShrink)).toBe(1);
    expect(applyCalibrationMap(asRawConfidence(0.9), underShrink)).toBe(0);

    const fitted = fitCalibrationMap(KEY, samplesOf(0.5, 200, 0));
    const overPoint = {
      ...fitted,
      points: [{ raw: 0.5, calibrated: 4 }],
    } as CalibrationMap;
    expect(applyCalibrationMap(asRawConfidence(0.9), overPoint)).toBe(1);

    // An "isotonic" map with no table at all is malformed; it falls back to the conservative
    // formula rather than passing the raw value through.
    const noPoints = { ...fitted, points: [] } as CalibrationMap;
    expect(applyCalibrationMap(asRawConfidence(0.9), noPoints)).toBe(0.9 * SHRINK_FACTOR);
  });

  it('clamps a calibrated value read back from storage', () => {
    expect(calibratedConfidenceFromStorage(1.4)).toBe(1);
    expect(calibratedConfidenceFromStorage(-0.1)).toBe(0);
    expect(calibratedConfidenceFromStorage('0.9')).toBe(0);
  });

  it('accepts every value a fit can produce', () => {
    const random = lcg(0xc0ffee);
    const samples: CalibrationSample[] = [];
    for (let index = 0; index < 400; index += 1) {
      samples.push({ raw: Math.round(random() * 20) / 20, accepted: random() < 0.5 });
    }
    const map = fitCalibrationMap(KEY, samples);
    for (let index = 0; index <= 50; index += 1) {
      const calibrated = applyCalibrationMap(asRawConfidence(index / 50), map);
      expect(isValidCalibrationMap(map)).toBe(true);
      expect(calibrated).toBeGreaterThanOrEqual(0);
      expect(calibrated).toBeLessThanOrEqual(1);
    }
  });
});

describe('the 0.90 / 0.60 lane boundaries', () => {
  function calibrated(value: number): CalibratedConfidence {
    return calibratedConfidenceFromStorage(value);
  }

  it('puts the boundary values in the documented lanes', () => {
    expect(laneFor(calibrated(1))).toBe('AUTO_APPLY');
    expect(laneFor(calibrated(0.9))).toBe('AUTO_APPLY');
    expect(laneFor(calibrated(0.899999))).toBe('VERIFY');
    expect(laneFor(calibrated(0.6))).toBe('VERIFY');
    expect(laneFor(calibrated(0.599999))).toBe('ASK');
    expect(laneFor(calibrated(0))).toBe('ASK');
  });

  it('counts only the ask lane as needs_review (I-8)', () => {
    expect(needsReview(calibrated(0.59))).toBe(true);
    expect(needsReview(calibrated(0.6))).toBe(false);
    expect(needsReview(calibrated(0.95))).toBe(false);
  });

  it('honours per-Household thresholds from docs/04 §7', () => {
    expect(laneFor(calibrated(0.55), { autoApplyMin: 0.5, verifyMin: 0.2 })).toBe('AUTO_APPLY');
    expect(laneFor(calibrated(0.55), { autoApplyMin: 0.8, verifyMin: 0.7 })).toBe('ASK');
  });
});

describe('a stored map is validated before it is trusted', () => {
  const fitted = fitCalibrationMap(KEY, samplesOf(0.5, 200, 0));

  it('accepts what the fit produced', () => {
    expect(isValidCalibrationMap(fitted)).toBe(true);
    expect(parseCalibrationMap(JSON.parse(JSON.stringify(fitted)))).toEqual(fitted);
  });

  it('refuses non-objects and a foreign version', () => {
    for (const value of [null, undefined, 'x', 7, [], {}]) {
      expect(parseCalibrationMap(value)).toBeNull();
    }
    expect(parseCalibrationMap({ ...fitted, version: CALIBRATION_MAP_VERSION + 1 })).toBeNull();
  });

  it('refuses an unknown task or a malformed key', () => {
    expect(parseCalibrationMap({ ...fitted, key: { ...KEY, task: 'SUMMARISE' } })).toBeNull();
    expect(parseCalibrationMap({ ...fitted, key: { ...KEY, model: '' } })).toBeNull();
    expect(parseCalibrationMap({ ...fitted, key: { ...KEY, promptVersion: '' } })).toBeNull();
  });

  it('refuses an isotonic map fitted on fewer than 200 samples', () => {
    expect(parseCalibrationMap({ ...fitted, sampleCount: 10 })).toBeNull();
  });

  it('refuses a non-monotone, unsorted, duplicated or out-of-range point list', () => {
    const base = { ...fitted, strategy: 'isotonic', sampleCount: 200, acceptedCount: 100 };
    expect(
      parseCalibrationMap({
        ...base,
        points: [
          { raw: 0.2, calibrated: 0.8 },
          { raw: 0.4, calibrated: 0.2 },
        ],
      }),
    ).toBeNull();
    expect(
      parseCalibrationMap({
        ...base,
        points: [
          { raw: 0.4, calibrated: 0.2 },
          { raw: 0.2, calibrated: 0.8 },
        ],
      }),
    ).toBeNull();
    expect(
      parseCalibrationMap({
        ...base,
        points: [
          { raw: 0.2, calibrated: 0.2 },
          { raw: 0.2, calibrated: 0.8 },
        ],
      }),
    ).toBeNull();
    expect(parseCalibrationMap({ ...base, points: [{ raw: 0.2, calibrated: 1.4 }] })).toBeNull();
    expect(parseCalibrationMap({ ...base, points: [{ raw: 1.4, calibrated: 0.5 }] })).toBeNull();
    expect(parseCalibrationMap({ ...base, points: [] })).toBeNull();
  });

  it('refuses a shrink map carrying a lookup table, and a bad factor or count', () => {
    const shrink = shrinkCalibrationMap(KEY, 5, 1);
    expect(parseCalibrationMap({ ...shrink, points: [{ raw: 0.2, calibrated: 0.2 }] })).toBeNull();
    expect(parseCalibrationMap({ ...shrink, shrinkFactor: 1.4 })).toBeNull();
    expect(parseCalibrationMap({ ...shrink, sampleCount: -1 })).toBeNull();
    expect(parseCalibrationMap({ ...shrink, acceptedCount: 6 })).toBeNull();
    expect(parseCalibrationMap(shrink)).toEqual(shrink);
  });
});
