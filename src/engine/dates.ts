const MS_PER_DAY = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Local calendar day of an ISO string as a day number (days since the Unix epoch,
 * computed on UTC arithmetic so DST never shifts it).
 * 'YYYY-MM-DD' is a local calendar date and is parsed by hand (`new Date('YYYY-MM-DD')` is UTC);
 * a full datetime is parsed with `Date` and reduced to its local Y/M/D. Anything else: RangeError.
 */
export function localDayNumber(iso: string): number {
  const dateOnly = DATE_ONLY.exec(iso);
  let y: number;
  let m: number;
  let d: number;
  if (dateOnly) {
    y = Number(dateOnly[1]);
    m = Number(dateOnly[2]) - 1;
    d = Number(dateOnly[3]);
    const check = new Date(Date.UTC(y, m, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m || check.getUTCDate() !== d) {
      throw new RangeError(`invalid calendar date: ${iso}`);
    }
  } else {
    const dt = DATETIME.test(iso) ? new Date(iso) : new Date(Number.NaN);
    if (Number.isNaN(dt.getTime())) throw new RangeError(`invalid ISO date: ${iso}`);
    y = dt.getFullYear();
    m = dt.getMonth();
    d = dt.getDate();
  }
  return Date.UTC(y, m, d) / MS_PER_DAY;
}

/** The local calendar day of an ISO string as 'YYYY-MM-DD' (localDayNumber; RangeError as there). */
export function localDayIso(iso: string): string {
  return new Date(localDayNumber(iso) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Signed difference in local calendar days (to − from). */
export function signedDaysBetween(fromIso: string, toIso: string): number {
  return localDayNumber(toIso) - localDayNumber(fromIso);
}

/** Whole local calendar days from `fromIso` to `toIso`; negative gaps clamp to 0. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, signedDaysBetween(fromIso, toIso));
}
