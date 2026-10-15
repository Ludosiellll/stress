import { describe, expect, it } from 'vitest';
import { DAY_FORM_DAYS, DAY_FORM_MIN_DAYS, dayForm, type FormDay } from './dayForm';
import { sdTrimmed } from './stats';

const d = (day: string, rts: number[], band = 1): FormDay => ({ day, band, rts });
const [d14, d12, d01] = [d('2026-10-14', [240, 241, 242]), d('2026-10-12', [238, 241, 244]), d('2026-10-01', [241])];
const past = [d14, d12, d01];

describe('dayForm', () => {
  it('constants', () => {
    expect(DAY_FORM_DAYS).toBe(14);
    expect(DAY_FORM_MIN_DAYS).toBe(3);
  });

  it('today against the median of daily medians and SDs of 14 earlier days on the same band (spec §2.3)', () => {
    expect(dayForm([...past, d('2026-10-15', [230, 236, 240])], '2026-10-15', 1)).toEqual({
      today: { median: 236, sd: sdTrimmed([230, 236, 240]) },
      usual: { median: 241, sd: 1 },
      verdict: 'same',
    });
    expect(dayForm([...past, d('2026-10-15', [225])], '2026-10-15', 1)?.verdict).toBe('better'); // −16 > max(10, 9,64)
    expect(dayForm([...past, d('2026-10-15', [252])], '2026-10-15', 1)?.verdict).toBe('worse');
    expect(
      dayForm([d14, d12, d('2026-09-30', [241]), d('2026-10-13', [241], 2), d('2026-10-15', [236])], '2026-10-15', 1)?.usual,
    ).toBeNull();
    expect(dayForm(past, '2026-10-15', 1)).toBeNull();
  });

  it('today adds up every warm-up of the day; a day of several warm-ups is one day', () => {
    const days = [
      d('2026-10-14', [240]),
      d('2026-10-14', [250, 260]),
      d('2026-10-13', [250]),
      d('2026-10-11', [250]),
      d('2026-10-15', [230, 240]),
      d('2026-10-15', [250]),
    ];
    expect(dayForm(days, '2026-10-15', 1)).toEqual({
      today: { median: 240, sd: sdTrimmed([230, 240, 250]) },
      // 14.10: median 250, SD 10; 13.10 and 11.10: 250, 0.
      usual: { median: 250, sd: 0 },
      verdict: 'same',
    });
    // Two days are not enough even with many warm-ups on them.
    expect(dayForm(days.filter((x) => x.day !== '2026-10-11'), '2026-10-15', 1)?.usual).toBeNull();
  });

  it('the threshold is max(10 ms, 4 %) on the shown (whole) values', () => {
    const usual = [d('2026-10-14', [500]), d('2026-10-13', [500]), d('2026-10-12', [500])];
    // 4 % of 500 is 20.
    expect(dayForm([...usual, d('2026-10-15', [520])], '2026-10-15', 1)?.verdict).toBe('same');
    expect(dayForm([...usual, d('2026-10-15', [521])], '2026-10-15', 1)?.verdict).toBe('worse');
    expect(dayForm([...usual, d('2026-10-15', [480])], '2026-10-15', 1)?.verdict).toBe('same');
    expect(dayForm([...usual, d('2026-10-15', [479])], '2026-10-15', 1)?.verdict).toBe('better');
    const short = [d('2026-10-14', [200]), d('2026-10-13', [200]), d('2026-10-12', [200])];
    // 10.4 is shown as 10: the shown difference is within 10 ms.
    expect(dayForm([...short, d('2026-10-15', [210.4])], '2026-10-15', 1)?.verdict).toBe('same');
    expect(dayForm([...short, d('2026-10-15', [210.6])], '2026-10-15', 1)?.verdict).toBe('worse');
  });

  it('days without RTs, later days and other bands are not usual days', () => {
    const days = [
      d('2026-10-14', []),
      d('2026-10-16', [241]),
      d('2026-10-13', [241], 0),
      d('2026-10-12', [241]),
      d('2026-10-11', [241]),
      d('2026-10-15', [236]),
    ];
    expect(dayForm(days, '2026-10-15', 1)?.usual).toBeNull();
    expect(dayForm([...days, d('2026-10-10', [241])], '2026-10-15', 1)?.usual).toEqual({ median: 241, sd: 0 });
    // A warm-up today without a clean hit has nothing to show.
    expect(dayForm([...past, d('2026-10-15', [])], '2026-10-15', 1)).toBeNull();
  });
});
