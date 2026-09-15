import { describe, expect, it } from 'vitest';

import { DEFAULT_CAP_PERCENT, proposeSavings, type SavingsCandidate } from './savings';

/**
 * The savings proposal is a figure a user acts on, so every boundary is asserted rather than the happy
 * path: the cap, the shortfall, the tie-break, and the floor that keeps a fractional para from being
 * invented. All money is minor units.
 */
const rsd = (major: number): bigint => BigInt(major) * 100n;

function candidate(categoryId: string, spentMajor: number): SavingsCandidate {
  return { categoryId, spentMinor: rsd(spentMajor) };
}

describe('proposeSavings', () => {
  it('caps each Category at a fifth of its own spend, biggest first', () => {
    const proposal = proposeSavings({
      targetMinor: rsd(100_000),
      candidates: [candidate('food', 24_600), candidate('fuel', 12_000), candidate('fun', 3_000)],
    });

    // 20 % of 24.600 = 4.920, then 20 % of 12.000 = 2.400 — the target is not reachable from these
    // three, and the plan says so instead of stretching the cap.
    expect(proposal.lines.map((line) => [line.categoryId, line.reductionMinor])).toEqual([
      ['food', rsd(4_920)],
      ['fuel', rsd(2_400)],
      ['fun', rsd(600)],
    ]);
    expect(proposal.proposedMinor).toBe(rsd(7_920));
    expect(proposal.shortfallMinor).toBe(rsd(92_080));
    expect(proposal.meetsTarget).toBe(false);
    expect(proposal.capPercent).toBe(DEFAULT_CAP_PERCENT);
  });

  it('takes only what it needs from the last Category, and reports no shortfall', () => {
    const proposal = proposeSavings({
      targetMinor: rsd(5_000),
      candidates: [candidate('food', 24_600), candidate('fuel', 12_000)],
    });

    expect(proposal.lines.map((line) => line.reductionMinor)).toEqual([rsd(4_920), rsd(80)]);
    expect(proposal.proposedMinor).toBe(rsd(5_000));
    expect(proposal.shortfallMinor).toBe(0n);
    expect(proposal.meetsTarget).toBe(true);
    // The second line's share is 80/12.000, floored to a whole percent.
    expect(proposal.lines[1]?.reductionPercent).toBe(0);
    expect(proposal.lines[0]?.reductionPercent).toBe(20);
  });

  it('names what each Category would fall to, so the plan is a plan and not just a cut', () => {
    const proposal = proposeSavings({
      targetMinor: rsd(1_000),
      candidates: [candidate('food', 24_600)],
    });

    expect(proposal.lines[0]?.proposedSpendMinor).toBe(rsd(23_600));
  });

  it('is deterministic: equal spends are ordered by id, not by input order', () => {
    const first = proposeSavings({
      targetMinor: rsd(10),
      candidates: [candidate('b', 1_000), candidate('a', 1_000)],
    });
    const second = proposeSavings({
      targetMinor: rsd(10),
      candidates: [candidate('a', 1_000), candidate('b', 1_000)],
    });

    // The target is small enough that one Category covers it, so the plan is a single line — and it
    // is the same line whichever order the candidates arrived in. A tie broken by input order would
    // make the plan reshuffle between two identical requests.
    expect(first.lines.map((line) => line.categoryId)).toEqual(['a']);
    expect(second.lines.map((line) => line.categoryId)).toEqual(['a']);
  });

  it('ignores Categories with no spend, and a cap that floors to nothing', () => {
    const proposal = proposeSavings({
      targetMinor: rsd(100),
      candidates: [candidate('rent', 0), candidate('chewing-gum', 0), candidate('food', 1_000)],
    });

    expect(proposal.lines.map((line) => line.categoryId)).toEqual(['food']);
    expect(proposal.basis.candidatesConsidered).toBe(1);
    expect(proposal.basis.spentMinor).toBe(rsd(1_000));
  });

  it('floors in minor units, so a fraction of a para is never invented (ADR-003)', () => {
    // 20 % of 1 minor unit is 0.2 — the whole para it can is 0, so this Category gives nothing up and
    // the target stays uncovered.
    const proposal = proposeSavings({ targetMinor: 10n, candidates: [{ categoryId: 'odd', spentMinor: 1n }] });

    expect(proposal.lines).toEqual([]);
    expect(proposal.proposedMinor).toBe(0n);
    expect(proposal.shortfallMinor).toBe(10n);
  });

  it('spends the whole cap when the target needs all of it', () => {
    const proposal = proposeSavings({
      targetMinor: rsd(10_000),
      candidates: [candidate('food', 24_600), candidate('fuel', 12_000), candidate('fun', 3_000)],
    });

    // 4.920 + 2.400 + 600 = 7.920 is everything the rule can give; the remaining 2.080 is short.
    expect(proposal.proposedMinor).toBe(rsd(7_920));
    expect(proposal.shortfallMinor).toBe(rsd(2_080));
  });

  it('honours a different cap, because the rule is a parameter and not a magic number', () => {
    const proposal = proposeSavings({
      targetMinor: rsd(10_000),
      candidates: [candidate('food', 10_000)],
      capPercent: 50,
    });

    expect(proposal.proposedMinor).toBe(rsd(5_000));
    expect(proposal.capPercent).toBe(50);
  });

  it('refuses a target of zero or less, and a cap outside 1–100', () => {
    expect(() => proposeSavings({ targetMinor: 0n, candidates: [] })).toThrow(/greater than zero/);
    expect(() => proposeSavings({ targetMinor: -1n, candidates: [] })).toThrow(/greater than zero/);
    expect(() => proposeSavings({ targetMinor: 1n, candidates: [], capPercent: 0 })).toThrow(/capPercent/);
    expect(() => proposeSavings({ targetMinor: 1n, candidates: [], capPercent: 101 })).toThrow(/capPercent/);
    expect(() => proposeSavings({ targetMinor: 1n, candidates: [], capPercent: 2.5 })).toThrow(/capPercent/);
  });

  it('reports an empty plan when there is nothing to cut', () => {
    const proposal = proposeSavings({ targetMinor: rsd(1_000), candidates: [] });

    expect(proposal.lines).toEqual([]);
    expect(proposal.proposedMinor).toBe(0n);
    expect(proposal.shortfallMinor).toBe(rsd(1_000));
    expect(proposal.basis).toEqual({ candidatesConsidered: 0, spentMinor: 0n });
  });

  it('echoes the currency, defaulting to the Household ledger currency', () => {
    expect(proposeSavings({ targetMinor: 1n, candidates: [] }).currency).toBe('RSD');
    expect(proposeSavings({ targetMinor: 1n, candidates: [], currency: 'EUR' }).currency).toBe('EUR');
  });
});
