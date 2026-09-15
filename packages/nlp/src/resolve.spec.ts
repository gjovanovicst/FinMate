import { describe, expect, it } from 'vitest';

import {
  RESOLUTION_LADDER,
  RUNG_CONFIDENCE,
  resolveEntity,
  type EntityCandidate,
} from './resolve';
import {
  TRIGRAM_CONFIDENCE_MAX,
  TRIGRAM_CONFIDENCE_MIN,
  trigramConfidence,
} from './trigram';

function merchant(id: string, name: string, aliases: readonly string[] = []): EntityCandidate {
  return { id, kind: 'MERCHANT', name, aliases };
}

function counterparty(id: string, name: string, aliases: readonly string[] = []): EntityCandidate {
  return { id, kind: 'COUNTERPARTY', name, aliases };
}

describe('the exported constants', () => {
  it('fixes the rung confidences docs/04 §4 specifies', () => {
    expect(RUNG_CONFIDENCE).toEqual({ EXACT: 1.0, NORMALIZED: 0.98, PREFIX: 0.9 });
    expect(Object.isFrozen(RUNG_CONFIDENCE)).toBe(true);
  });

  it('orders the ladder cheapest first', () => {
    expect(RESOLUTION_LADDER).toEqual(['EXACT', 'NORMALIZED', 'PREFIX', 'TRIGRAM']);
  });
});

describe('rung 1 — exact alias match (1.00)', () => {
  it('resolves the canonical name typed exactly', () => {
    const lidl = merchant('m-lidl', 'Lidl', ['lidl']);
    const result = resolveEntity('Lidl', [lidl]);

    expect(result.resolved).toBe(true);
    expect(result.rung).toBe('EXACT');
    expect(result.confidence).toBe(1.0);
    expect(result.entity).toBe(lidl);
    expect(result.matchedOn).toBe('Lidl');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.matchedField).toBe('NAME');
  });

  it('resolves a stored alias typed verbatim', () => {
    const result = resolveEntity('lidl prodavnica', [
      merchant('m-lidl', 'Lidl', ['lidl prodavnica']),
    ]);

    expect(result.rung).toBe('EXACT');
    expect(result.confidence).toBe(1.0);
    expect(result.matchedOn).toBe('lidl prodavnica');
    expect(result.candidates[0]!.matchedField).toBe('ALIAS');
  });

  it('prefers the canonical name when name and alias are both raw-equal', () => {
    const result = resolveEntity('Lidl', [merchant('m-lidl', 'Lidl', ['Lidl'])]);
    expect(result.rung).toBe('EXACT');
    expect(result.candidates[0]!.matchedField).toBe('NAME');
  });

  it('is character-sensitive, so a lowercase typing is rung 2 rather than rung 1', () => {
    const result = resolveEntity('lidl', [merchant('m-lidl', 'Lidl')]);
    expect(result.rung).toBe('NORMALIZED');
    expect(result.confidence).toBe(RUNG_CONFIDENCE.NORMALIZED);
  });
});

describe('rung 2 — normalized exact match (0.98)', () => {
  it('folds case', () => {
    const result = resolveEntity('LIDL', [merchant('m-lidl', 'Lidl')]);
    expect(result.rung).toBe('NORMALIZED');
    expect(result.confidence).toBe(0.98);
    expect(result.matchedOn).toBe('Lidl');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveEntity('  LIDL  ', [merchant('m-lidl', 'Lidl')]).rung).toBe('NORMALIZED');
  });

  it('transliterates Cyrillic to its Latin spelling', () => {
    const result = resolveEntity('Лидл', [merchant('m-lidl', 'Lidl')]);
    expect(result.rung).toBe('NORMALIZED');
    expect(result.confidence).toBe(0.98);
  });

  it('folds Latin diacritics', () => {
    const result = resolveEntity('secer', [merchant('m-secer', 'Šećer', [])]);
    expect(result.rung).toBe('NORMALIZED');
  });

  it('matches a stored alias and reports the name when both fold alike', () => {
    const dejan = counterparty('c-dejan', 'Dejan rođa', ['dejan roda']);
    const result = resolveEntity('DEJAN RODA', [dejan]);

    expect(result.rung).toBe('NORMALIZED');
    expect(result.confidence).toBe(0.98);
    // Both keys fold to `dejan roda`; the canonical name wins by the key tie-break.
    expect(result.matchedOn).toBe('Dejan rođa');
    expect(result.candidates[0]!.matchedField).toBe('NAME');
  });
});

describe('rung 3 — prefix / token match (0.90)', () => {
  it("resolves docs/04 §4's own example: `lidl prodavnica` → `lidl`", () => {
    const result = resolveEntity('lidl prodavnica', [
      merchant('m-lidl', 'Lidl Srbija', ['lidl']),
    ]);

    expect(result.resolved).toBe(true);
    expect(result.rung).toBe('PREFIX');
    expect(result.confidence).toBe(0.9);
    expect(result.matchedOn).toBe('lidl');
    expect(result.candidates[0]!.matchedField).toBe('ALIAS');
  });

  it('is word-order independent', () => {
    const lidl = merchant('m-lidl', 'Lidl Srbija', ['lidl']);
    expect(resolveEntity('prodavnica lidl', [lidl]).rung).toBe('PREFIX');
  });

  it('tokenizes a Cyrillic input the same way', () => {
    const result = resolveEntity('Лидл продавница', [merchant('m-lidl', 'Lidl', ['lidl'])]);
    expect(result.rung).toBe('PREFIX');
    expect(result.confidence).toBe(0.9);
  });

  it('requires every token of a multi-token alias, not just one', () => {
    // `lidl` alone is a token of neither the name (`lidl srbija`) nor the alias (`lidl prodavnica`),
    // and the trigram similarities stay below 0.55 — so this correctly does not resolve.
    const result = resolveEntity('lidl', [merchant('m-lidl', 'Lidl Srbija', ['lidl prodavnica'])]);
    expect(result.resolved).toBe(false);
    expect(result.rung).toBe('UNRESOLVED');
  });

  it('does not treat an abbreviation of a word as a prefix match', () => {
    // `prod` is not a token of `prodavnica`, and 0.90 auto-applies — so an abbreviation must not
    // reach this rung. The trigram similarity is 0.33, below threshold.
    expect(resolveEntity('prod', [merchant('m-prod', 'Prodavnica')]).resolved).toBe(false);
  });
});

describe('rung 4 — trigram similarity (0.55–0.85)', () => {
  it('resolves a near miss and keeps it below the 0.60 verify gate', () => {
    // similarity('dejan roda', 'dejan rota') = 8/14 = 0.5714 > 0.55.
    const result = resolveEntity('dejan roda', [counterparty('c-rota', 'Dejan rota')]);

    expect(result.rung).toBe('TRIGRAM');
    expect(result.candidates[0]!.similarity).toBeCloseTo(8 / 14, 10);
    expect(result.confidence).toBeCloseTo(trigramConfidence(8 / 14), 10);
    expect(result.confidence).toBeGreaterThanOrEqual(TRIGRAM_CONFIDENCE_MIN);
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('resolves a stronger near miss into the verify lane', () => {
    // similarity('dejan roda', 'dejan rod') = 9/12 = 0.75.
    const result = resolveEntity('dejan roda', [counterparty('c-rod', 'Dejan rod')]);

    expect(result.rung).toBe('TRIGRAM');
    expect(result.candidates[0]!.similarity).toBeCloseTo(0.75, 10);
    expect(result.confidence).toBeCloseTo(trigramConfidence(0.75), 10);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.confidence).toBeLessThanOrEqual(TRIGRAM_CONFIDENCE_MAX);
  });

  it('never reaches the 0.90 auto-apply gate', () => {
    const result = resolveEntity('dejan roda', [counterparty('c-rod', 'Dejan rod')]);
    expect(result.confidence!).toBeLessThan(0.9);
  });
});

describe('Dejan rođa — the F-11 canonical case', () => {
  // One alias, and deliberately not the raw `dejan roda`: with that alias stored, rung 1 would fire
  // first (correctly), and the normalized rung the task names would go untested.
  const dejan = counterparty('c-dejan', 'Dejan rođa', ['rođa dejan']);

  it('resolves the canonical spelling exactly', () => {
    const result = resolveEntity('Dejan rođa', [dejan]);
    expect(result.rung).toBe('EXACT');
    expect(result.confidence).toBe(1.0);
    expect(result.entity).toBe(dejan);
  });

  it('resolves `dejan roda` on the normalized rung at 0.98', () => {
    const result = resolveEntity('dejan roda', [dejan]);
    expect(result.rung).toBe('NORMALIZED');
    expect(result.confidence).toBe(0.98);
    expect(result.entity).toBe(dejan);
    expect(result.matchedOn).toBe('Dejan rođa');
  });

  it('resolves the Cyrillic spelling `Дејан рода` on the normalized rung', () => {
    // Transliteration maps д → d, so this folds to `dejan roda` — the same fold as the Latin name.
    const result = resolveEntity('Дејан рода', [dejan]);
    expect(result.rung).toBe('NORMALIZED');
    expect(result.confidence).toBe(0.98);
    expect(result.entity).toBe(dejan);
  });

  it('resolves the orthographic Cyrillic `Дејан рођа` one rung lower', () => {
    // `ђ` transliterates to `dj` (docs/04 §3.1's table) while Latin `đ` folds to `d` (the explicit
    // đ rule in transliterate.ts), so `Дејан рођа` folds to `dejan rodja` — not `dejan roda`. It
    // still reaches the entity, on rung 4: similarity('dejan rodja', 'dejan roda') = 9/14 = 0.6429,
    // confidence ≈ 0.6119 — the verify lane, not an auto-apply. See the task report for the fold
    // asymmetry; resolveEntity must not carry a second fold to paper over it.
    const result = resolveEntity('Дејан рођа', [dejan]);
    expect(result.rung).toBe('TRIGRAM');
    expect(result.entity).toBe(dejan);
    expect(result.candidates[0]!.similarity).toBeCloseTo(9 / 14, 10);
    expect(result.confidence).toBeCloseTo(trigramConfidence(9 / 14), 10);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.matchedOn).toBe('Dejan rođa');
  });

  it('resolves the Cyrillic word order too', () => {
    const result = resolveEntity('РОЂА ДЕЈАН', [dejan]);
    expect(result.rung).toBe('TRIGRAM');
    expect(result.entity).toBe(dejan);
  });
});

describe('the ladder is cheapest-first and stops at the first hit', () => {
  it('prefers rung 1 over every lower rung', () => {
    const result = resolveEntity('Lidl', [merchant('m-lidl', 'Lidl', ['lidl'])]);
    expect(result.rung).toBe('EXACT');
  });

  it('prefers rung 2 over prefix and trigram', () => {
    // `lidl` is also a token of nothing here, but prefix/token would match a containing input; the
    // normalized equality is stronger and wins.
    const result = resolveEntity('lidl', [merchant('m-lidl', 'Lidl', ['lidl prodavnica'])]);
    expect(result.rung).toBe('NORMALIZED');
    expect(result.confidence).toBe(0.98);
  });

  it('prefers rung 3 over trigram when both would hit', () => {
    // `dejan roda beograd` contains the name's tokens (rung 3, 0.90) and has similarity 0.5789 with
    // it (rung 4, ≈0.5693). The ladder must report rung 3.
    const result = resolveEntity('dejan roda beograd', [counterparty('c-roda', 'Dejan Roda')]);
    expect(result.rung).toBe('PREFIX');
    expect(result.confidence).toBe(0.9);
  });

  it('stops at the first rung that produced any hit, across candidates', () => {
    const nearMiss = counterparty('c-rota', 'Dejan rota'); // rung 4 only
    const exactFold = counterparty('c-roda', 'Dejan roda'); // rung 2

    const result = resolveEntity('dejan roda', [nearMiss, exactFold]);

    expect(result.rung).toBe('NORMALIZED');
    expect(result.entity).toBe(exactFold);
    // The rung-4 candidate is never evaluated, so it is not reported as a loser.
    expect(result.candidates).toHaveLength(1);
  });

  it('does not compute trigram similarity when a cheaper rung wins', () => {
    let calls = 0;
    resolveEntity('Lidl', [merchant('m-lidl', 'Lidl', ['lidl'])], {
      similarity: () => {
        calls += 1;
        return 1;
      },
    });
    expect(calls).toBe(0);
  });
});

describe('unresolved is not "the best weak candidate"', () => {
  it('does not resolve a below-threshold similarity', () => {
    // similarity('lidl', 'lidlplus') = 0.4, below the 0.55 threshold.
    const result = resolveEntity('lidl', [merchant('m-plus', 'Lidlplus')]);
    expect(result).toEqual({
      resolved: false,
      rung: 'UNRESOLVED',
      entity: null,
      confidence: null,
      matchedOn: null,
      candidates: [],
    });
  });

  it('does not resolve an unrelated candidate', () => {
    expect(resolveEntity('goran', [merchant('m-lidl', 'Lidl')]).resolved).toBe(false);
  });

  it('does not resolve blank input', () => {
    expect(resolveEntity('', [merchant('m-lidl', 'Lidl')]).rung).toBe('UNRESOLVED');
    expect(resolveEntity('   ', [merchant('m-lidl', 'Lidl')]).rung).toBe('UNRESOLVED');
  });

  it('does not resolve when there are no candidates', () => {
    expect(resolveEntity('lidl', []).resolved).toBe(false);
  });

  it('ignores a candidate whose name and aliases fold to nothing', () => {
    expect(resolveEntity('lidl', [merchant('m-blank', '   ', ['  '])]).rung).toBe('UNRESOLVED');
  });
});

describe('ties are deterministic', () => {
  it('breaks a same-rung, same-confidence tie on entity id ascending', () => {
    const later = merchant('m-b', 'Lidl');
    const earlier = merchant('m-a', 'Lidl');

    const forwards = resolveEntity('lidl prodavnica', [later, earlier]);
    const backwards = resolveEntity('lidl prodavnica', [earlier, later]);

    expect(forwards.rung).toBe('PREFIX');
    expect(forwards.entity).toBe(earlier);
    expect(forwards.candidates.map((match) => match.entity.id)).toEqual(['m-a', 'm-b']);
    expect(backwards.entity).toBe(earlier);
    expect(backwards.candidates.map((match) => match.entity.id)).toEqual(['m-a', 'm-b']);
  });

  it('prefers the longer matched name before falling back to id', () => {
    // On id ascending `m-aaa` would win, but `m-zzz` matched a longer, more specific name.
    const short = merchant('m-aaa', 'Lidl');
    const specific = merchant('m-zzz', 'Lidl prodavnica');

    const result = resolveEntity('lidl prodavnica beograd', [short, specific]);

    expect(result.rung).toBe('PREFIX');
    expect(result.entity).toBe(specific);
    expect(result.candidates.map((match) => match.entity.id)).toEqual(['m-zzz', 'm-aaa']);
  });

  it('orders rung-4 losers by descending similarity', () => {
    const weak = counterparty('c-rota', 'Dejan rota'); // 0.5714
    const strong = counterparty('c-rod', 'Dejan rod'); // 0.75

    const result = resolveEntity('dejan roda', [weak, strong]);

    expect(result.rung).toBe('TRIGRAM');
    expect(result.entity).toBe(strong);
    expect(result.candidates.map((match) => match.entity.id)).toEqual(['c-rod', 'c-rota']);
  });
});

describe('trigram key selection', () => {
  it('keeps the highest-scoring key of a candidate', () => {
    // 'Dejan rota' scores 0.5714; the alias 'Dejan rod' scores 0.75.
    const result = resolveEntity('dejan roda', [
      counterparty('c-multi', 'Dejan rota', ['Dejan rod']),
    ]);

    expect(result.rung).toBe('TRIGRAM');
    expect(result.matchedOn).toBe('Dejan rod');
    expect(result.candidates[0]!.matchedField).toBe('ALIAS');
    expect(result.candidates[0]!.similarity).toBeCloseTo(0.75, 10);
  });

  it('breaks an equal-score key tie on folded text ascending', () => {
    // Both 'gorana' and 'gorans' score 5/8 = 0.625 against 'goran'; 'gorana' is lexicographically
    // first, so the alias is reported even though the name is declared first.
    const result = resolveEntity('goran', [counterparty('c-g', 'Gorans', ['Gorana'])]);

    expect(result.rung).toBe('TRIGRAM');
    expect(result.matchedOn).toBe('Gorana');
    expect(result.candidates[0]!.matchedField).toBe('ALIAS');
    expect(result.candidates[0]!.similarity).toBeCloseTo(0.625, 10);
  });

  it('keeps the earlier key when an equal-scoring later key is not better', () => {
    // The mirror of the test above: 'gorans' is not lexicographically first, so the name stays.
    const result = resolveEntity('goran', [counterparty('c-g', 'Gorana', ['Gorans'])]);

    expect(result.rung).toBe('TRIGRAM');
    expect(result.matchedOn).toBe('Gorana');
    expect(result.candidates[0]!.matchedField).toBe('NAME');
  });

  it('is stable when a candidate repeats an alias', () => {
    // The name cannot be the exact hit, so both alias keys are tested and the key comparator's final
    // equality arm fires.
    const result = resolveEntity('Lidl', [merchant('m-lidl', 'Lidlx', ['Lidl', 'Lidl'])]);
    expect(result.rung).toBe('EXACT');
    expect(result.matchedOn).toBe('Lidl');
    expect(result.candidates[0]!.matchedField).toBe('ALIAS');
    expect(result.candidates).toHaveLength(1);
  });

  it('ignores a name whose tokens are empty but whose fold is not', () => {
    // `---` folds to `---` (non-empty) but tokenizes to nothing, so it can never satisfy rung 3, and
    // it has no trigrams — unresolved, not a phantom prefix hit.
    expect(resolveEntity('--- foo', [merchant('m-dashes', '---')]).rung).toBe('UNRESOLVED');
  });
});

describe('the injected similarity', () => {
  it('changes the rung — an unresolved input resolves with a permissive stub', () => {
    const target = merchant('m-plus', 'Lidlplus');

    expect(resolveEntity('lidl', [target]).rung).toBe('UNRESOLVED');

    const stubbed = resolveEntity('lidl', [target], { similarity: () => 0.9 });
    expect(stubbed.rung).toBe('TRIGRAM');
    expect(stubbed.candidates[0]!.similarity).toBe(0.9);
    expect(stubbed.confidence).toBeCloseTo(trigramConfidence(0.9), 10);
  });

  it('receives already-folded strings, so a SQL similarity() compares like with like', () => {
    const seen: [string, string][] = [];
    resolveEntity('Lidl Plus', [merchant('m-plus', 'Lidlplus')], {
      similarity: (a, b) => {
        seen.push([a, b]);
        return 0.9;
      },
    });

    expect(seen).toEqual([['lidl plus', 'lidlplus']]);
  });

  it('is consulted for every candidate only after the cheaper rungs miss', () => {
    const calls: string[] = [];
    resolveEntity('lidl', [merchant('m-a', 'Lido'), merchant('m-b', 'Lidlplus')], {
      similarity: (a, b) => {
        calls.push(`${a}|${b}`);
        return 0.9;
      },
    });

    expect(calls).toEqual(['lidl|lido', 'lidl|lidlplus']);
  });

  it('honours a below-threshold stub as unresolved', () => {
    expect(resolveEntity('lidl', [merchant('m-plus', 'Lidlplus')], { similarity: () => 0.5 }).rung).toBe(
      'UNRESOLVED',
    );
  });

  it('honours a lower trigramThreshold override', () => {
    const result = resolveEntity('lidl', [merchant('m-plus', 'Lidlplus')], {
      similarity: () => 0.5,
      trigramThreshold: 0.4,
    });
    expect(result.rung).toBe('TRIGRAM');
  });

  it('ignores a non-finite similarity', () => {
    expect(
      resolveEntity('lidl', [merchant('m-plus', 'Lidlplus')], { similarity: () => Number.NaN })
        .rung,
    ).toBe('UNRESOLVED');
    expect(
      resolveEntity('lidl', [merchant('m-plus', 'Lidlplus')], {
        similarity: () => Number.POSITIVE_INFINITY,
      }).rung,
    ).toBe('UNRESOLVED');
  });
});

describe('purity', () => {
  it('returns a deep-equal result for the same inputs, and does not mutate them', () => {
    const candidates = [
      merchant('m-lidl', 'Lidl', ['lidl', 'lidl prodavnica']),
      counterparty('c-rota', 'Dejan rota'),
    ];
    const snapshot = structuredClone(candidates);

    const first = resolveEntity('dejan roda', candidates);
    const second = resolveEntity('dejan roda', candidates);

    expect(first).toEqual(second);
    expect(candidates).toEqual(snapshot);
  });

  it('does not reorder the caller candidate array', () => {
    const candidates = [merchant('m-b', 'Lidl'), merchant('m-a', 'Lidl')];
    resolveEntity('lidl prodavnica', candidates);
    expect(candidates.map((candidate) => candidate.id)).toEqual(['m-b', 'm-a']);
  });
});
