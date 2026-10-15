import { localDayNumber } from './dates';
import { median, sdTrimmed } from './stats';

/** «Обычно» looks at this many earlier days (today − 14 … today − 1). */
export const DAY_FORM_DAYS = 14;
/** …and needs this many of them with a warm-up on the same band. */
export const DAY_FORM_MIN_DAYS = 3;
/** The medians agree within max(10 ms, 4 % of «обычно»). */
const SAME_MS = 10;
const SAME_SHARE = 0.04;

/** The clean hit RTs of warm-up blocks of one local day on one band (several entries of a day add up). */
export interface FormDay {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** ⌊lBefore / 4⌋ of the warm-up. */
  band: number;
  rts: readonly number[];
}

export interface DayForm {
  /** The median and sdTrimmed of every clean hit of today's warm-ups. */
  today: { median: number; sd: number };
  /** The median of the daily medians and of the daily SDs; null: fewer than DAY_FORM_MIN_DAYS days. */
  usual: { median: number; sd: number } | null;
  /** How today's median compares with the usual one; null without «обычно». */
  verdict: 'same' | 'better' | 'worse' | null;
}

const medianAndSd = (rts: readonly number[]): { median: number; sd: number } => ({ median: median(rts), sd: sdTrimmed(rts) });

/**
 * «Форма дня» (F5, spec §2.3): today's warm-up RTs (all of them, as they add up through the day) against the usual
 * form, the medians of the daily medians and daily SDs of the DAY_FORM_DAYS days before today on the same band.
 * The verdict compares the medians as shown (whole ms): the gap the line shows is the gap judged. null: no RT today.
 */
export function dayForm(days: readonly FormDay[], today: string, band: number): DayForm | null {
  const todayNumber = localDayNumber(today);
  const todayRts: number[] = [];
  const earlier = new Map<number, number[]>();
  for (const d of days) {
    const n = localDayNumber(d.day);
    if (n === todayNumber) {
      todayRts.push(...d.rts);
    } else if (d.band === band && n < todayNumber && n >= todayNumber - DAY_FORM_DAYS && d.rts.length > 0) {
      const rts = earlier.get(n);
      if (rts === undefined) earlier.set(n, [...d.rts]);
      else rts.push(...d.rts);
    }
  }
  if (todayRts.length === 0) return null;
  const now = medianAndSd(todayRts);
  if (earlier.size < DAY_FORM_MIN_DAYS) return { today: now, usual: null, verdict: null };
  const daily = [...earlier.values()].map(medianAndSd);
  const usual = { median: median(daily.map((x) => x.median)), sd: median(daily.map((x) => x.sd)) };
  const shownUsual = Math.round(usual.median);
  const gap = Math.round(now.median) - shownUsual;
  const verdict = Math.abs(gap) <= Math.max(SAME_MS, SAME_SHARE * shownUsual) ? 'same' : gap < 0 ? 'better' : 'worse';
  return { today: now, usual, verdict };
}
