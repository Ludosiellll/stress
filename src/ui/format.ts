const two = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date, YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Local date and time for file names, YYYY-MM-DD-HHmm. */
export function localStamp(d: Date = new Date()): string {
  return `${localDate(d)}-${two(d.getHours())}${two(d.getMinutes())}`;
}

/** A whole count with its thousands kept together by no-break spaces: 1234 → «1 234». */
export function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

const NBSP = '\u00a0';

/**
 * A number keeps its unit on its line: the space between a number and «мс», «с» or «%» becomes a no-break space, and
 * so do the spaces around an arrow before a number («39 → 29 с»). For rendering only (A-R22): the strings the
 * session builds keep plain spaces.
 */
export function noBreakUnits(text: string): string {
  return text.replace(/(\d) (?=(?:мс|с|%)(?!\p{L}))/gu, `$1${NBSP}`).replace(/ → (?=[+−]?\d)/g, `${NBSP}→${NBSP}`);
}

/** Number with a decimal comma, as the Russian UI writes it. */
export function decimal(n: number, digits = 1): string {
  return n.toFixed(digits).replace('.', ',');
}

/** A budget in minutes: a whole number, or one decimal with a comma («3,5»). */
export function budgetMinutes(ms: number): string {
  const tenths = Math.round(ms / 6_000);
  return tenths % 10 === 0 ? String(tenths / 10) : decimal(tenths / 10);
}
