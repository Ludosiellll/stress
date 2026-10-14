import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeStreak, daysUntil } from './streak';

describe('computeStreak', () => {
  it('counts consecutive days ending yesterday when today is absent', () => {
    expect(computeStreak(['2026-10-12', '2026-10-13'], '2026-10-14')).toBe(2);
  });
  it('includes today when present', () => {
    expect(computeStreak(['2026-10-12', '2026-10-13', '2026-10-14'], '2026-10-14')).toBe(3);
  });
  it('a gap resets the streak', () => {
    expect(computeStreak(['2026-10-10', '2026-10-12', '2026-10-13'], '2026-10-14')).toBe(2);
    expect(computeStreak(['2026-10-10', '2026-10-11'], '2026-10-14')).toBe(0);
    expect(computeStreak(['2026-10-11', '2026-10-13', '2026-10-14'], '2026-10-14')).toBe(2);
  });
  it('is 0 with no dates', () => {
    expect(computeStreak([], '2026-10-14')).toBe(0);
  });
  it('de-duplicates days and ignores order and future days', () => {
    expect(
      computeStreak(['2026-10-13', '2026-10-13', '2026-10-12', '2026-10-20', '2026-10-13'], '2026-10-14'),
    ).toBe(2);
  });
  it('treats datetimes as local days and mixes with date-only', () => {
    const dt = (d: number, h: number): string => new Date(2026, 9, d, h, 30).toISOString();
    expect(computeStreak([dt(12, 6), dt(13, 23), '2026-10-14', dt(14, 1)], '2026-10-14')).toBe(3);
  });
  it('crosses DST boundaries (last Sunday of March)', () => {
    const dates = ['2026-03-28T23:30:00', '2026-03-29T12:00:00', '2026-03-30T08:00:00'];
    expect(computeStreak(dates, '2026-03-30')).toBe(3);
    expect(computeStreak(['2026-03-28', '2026-03-29'], '2026-03-30')).toBe(2);
  });
  it('crosses month and year boundaries', () => {
    expect(computeStreak(['2025-12-30', '2025-12-31', '2026-01-01'], '2026-01-01')).toBe(3);
  });
  it('rejects invalid input', () => {
    expect(() => computeStreak(['bad'], '2026-10-14')).toThrow(RangeError);
  });
  it('property: n consecutive days ending today give n', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), fc.boolean(), (n, includeToday) => {
        const end = Date.UTC(2026, 9, 14);
        const dates: string[] = [];
        const first = includeToday ? 0 : 1;
        for (let i = first; i < first + n; i++) {
          dates.push(new Date(end - i * 86400000).toISOString().slice(0, 10));
        }
        return computeStreak(dates, '2026-10-14') === n;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('daysUntil', () => {
  it('is null for no test date', () => {
    expect(daysUntil(null, '2026-10-14')).toBeNull();
  });
  it('counts days to the test', () => {
    expect(daysUntil('2026-11-14', '2026-10-14')).toBe(31);
    expect(daysUntil('2026-10-14', '2026-10-14')).toBe(0);
  });
  it('a past date clamps to 0', () => {
    expect(daysUntil('2026-10-01', '2026-10-14')).toBe(0);
  });
  it('works across the spring DST change', () => {
    expect(daysUntil('2026-03-30', '2026-03-28')).toBe(2);
  });
});
