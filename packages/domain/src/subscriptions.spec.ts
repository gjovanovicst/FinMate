import { describe, expect, it } from 'vitest';

import type { LocalDate } from './dates';
import { detectSubscriptions, type SubscriptionCharge } from './subscriptions';

/**
 * Subscription detection.
 *
 * "Propose, never auto-create" (docs/04 §8.2) is the property these tests protect: the detector
 * produces **candidates with their evidence**, and the two ways it could embarrass the product are a
 * false positive (three groceries called a subscription) and a missed bill (a monthly charge whose
 * amount drifted by a few dinars).
 */

const day = (value: string) => value as LocalDate;

function charge(key: string, amount: bigint, occurredOn: string, label = 'Netflix'): SubscriptionCharge {
  return { key, label, merchantId: key === 'netflix' ? 'm1' : null, description: label, amountMinor: amount, occurredOn: day(occurredOn) };
}

describe('detectSubscriptions', () => {
  const today = day('2026-09-20');

  it('finds a monthly subscription and reports its evidence', () => {
    const proposals = detectSubscriptions(
      [
        charge('netflix', 129_900n, '2026-06-15'),
        charge('netflix', 129_900n, '2026-07-15'),
        charge('netflix', 129_900n, '2026-08-15'),
        charge('netflix', 129_900n, '2026-09-15'),
      ],
      { today },
    );

    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.occurrences).toBe(4);
    expect(proposal.typicalAmountMinor).toBe(129_900n);
    expect(proposal.period.rrule).toBe('RRULE:FREQ=MONTHLY');
    expect(proposal.sameAmount).toBe(true);
    expect(proposal.lastOccurredOn).toBe('2026-09-15');
    // The gaps are 30/31/31 days, so the drift against a 30-day month is what the screen shows.
    expect(proposal.driftDays).toBeLessThanOrEqual(1);
  });

  it('calls two charges a coincidence, not a subscription', () => {
    expect(
      detectSubscriptions([charge('lidl', 200_00n, '2026-09-01'), charge('lidl', 200_00n, '2026-08-01')], {
        today,
      }),
    ).toEqual([]);
  });

  it('refuses a group whose amounts are not the same bill', () => {
    const groceries = [
      charge('market', 200_00n, '2026-06-01'),
      charge('market', 9_500_00n, '2026-07-01'),
      charge('market', 350_00n, '2026-08-01'),
    ];
    expect(detectSubscriptions(groceries, { today })).toEqual([]);
  });

  it('accepts a small price rise and reports it as not-identical', () => {
    const proposals = detectSubscriptions(
      [
        charge('yettel', 200_000n, '2026-06-10'),
        charge('yettel', 200_000n, '2026-07-10'),
        charge('yettel', 202_000n, '2026-08-10'),
        charge('yettel', 202_000n, '2026-09-10'),
      ],
      { today },
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.sameAmount).toBe(false);
    expect(proposals[0]?.typicalAmountMinor).toBe(200_000n);
  });

  it('refuses a run that is not regular', () => {
    const irregular = [
      charge('shop', 500_00n, '2026-06-01'),
      charge('shop', 500_00n, '2026-06-03'),
      charge('shop', 500_00n, '2026-08-20'),
    ];
    expect(detectSubscriptions(irregular, { today })).toEqual([]);
  });

  it('picks the period from the gaps rather than assuming monthly', () => {
    const weekly = detectSubscriptions(
      [
        charge('milk', 120_00n, '2026-08-31'),
        charge('milk', 120_00n, '2026-09-07'),
        charge('milk', 120_00n, '2026-09-14'),
      ],
      { today },
    );
    expect(weekly[0]?.period.kind).toBe('WEEKLY');

    const yearly = detectSubscriptions(
      [
        charge('insurance', 12_000_00n, '2024-09-01'),
        charge('insurance', 12_000_00n, '2025-09-01'),
        charge('insurance', 12_000_00n, '2026-09-01'),
      ],
      { today },
    );
    expect(yearly[0]?.period.kind).toBe('YEARLY');
    expect(yearly[0]?.period.rrule).toBe('RRULE:FREQ=YEARLY');
  });

  it('ignores a subscription that stopped', () => {
    const cancelled = [
      charge('old', 1_000_00n, '2025-09-01'),
      charge('old', 1_000_00n, '2025-10-01'),
      charge('old', 1_000_00n, '2025-11-01'),
    ];
    expect(detectSubscriptions(cancelled, { today })).toEqual([]);
    // …unless the caller widens the recency window knowingly.
    expect(detectSubscriptions(cancelled, { today, recencyDays: 400 })).toHaveLength(1);
  });

  it('orders the strongest evidence first, with a stable tie-break', () => {
    const proposals = detectSubscriptions(
      [
        charge('a', 100_00n, '2026-08-01', 'A'),
        charge('a', 100_00n, '2026-09-01', 'A'),
        charge('a', 100_00n, '2026-07-01', 'A'),
        charge('b', 900_00n, '2026-05-20', 'B'),
        charge('b', 900_00n, '2026-06-20', 'B'),
        charge('b', 900_00n, '2026-07-20', 'B'),
        charge('b', 900_00n, '2026-08-20', 'B'),
      ],
      { today: day('2026-09-05') },
    );

    // Four occurrences beats three; the amounts are irrelevant to the ranking.
    expect(proposals.map((proposal) => proposal.key)).toEqual(['b', 'a']);
  });

  it('keeps a quarterly bill out of the monthly bucket', () => {
    const proposals = detectSubscriptions(
      [
        charge('tax', 3_000_00n, '2025-12-15'),
        charge('tax', 3_000_00n, '2026-03-15'),
        charge('tax', 3_000_00n, '2026-06-15'),
        charge('tax', 3_000_00n, '2026-09-15'),
      ],
      { today },
    );

    expect(proposals[0]?.period.kind).toBe('QUARTERLY');
    expect(proposals[0]?.period.rrule).toBe('RRULE:FREQ=MONTHLY;INTERVAL=3');
  });

  it('is deterministic: the same charges give the same proposals in the same order', () => {
    const charges = [
      charge('a', 100_00n, '2026-07-01', 'A'),
      charge('a', 100_00n, '2026-08-01', 'A'),
      charge('a', 100_00n, '2026-09-01', 'A'),
      charge('b', 100_00n, '2026-07-01', 'B'),
      charge('b', 100_00n, '2026-08-01', 'B'),
      charge('b', 100_00n, '2026-09-01', 'B'),
    ];
    const first = detectSubscriptions(charges, { today });
    const second = detectSubscriptions([...charges].reverse(), { today });

    // Equal evidence, so the key decides — and it decides the same way whichever order the rows arrive
    // in (a group order that followed the input would reshuffle the screen on every re-render).
    expect(first.map((proposal) => proposal.key)).toEqual(['a', 'b']);
    expect(second.map((proposal) => proposal.key)).toEqual(['a', 'b']);
  });
});
