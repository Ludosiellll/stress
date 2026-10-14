import { localDayNumber, signedDaysBetween } from './dates';

/**
 * Consecutive training days ending today (if trained today) or yesterday (if not); 0 otherwise.
 * Days are local calendar days, duplicates and future days are ignored.
 */
export function computeStreak(trainingDatesIso: readonly string[], todayIso: string): number {
  const today = localDayNumber(todayIso);
  const days = new Set(trainingDatesIso.map(localDayNumber));
  let cursor = days.has(today) ? today : today - 1;
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor--;
  }
  return streak;
}

/** Days left until the selection test; null without a date, 0 once it has passed. */
export function daysUntil(testDateIso: string | null, todayIso: string): number | null {
  if (testDateIso === null) return null;
  return Math.max(0, signedDaysBetween(todayIso, testDateIso));
}
