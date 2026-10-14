/** Unicode minus, en dash and em dash all count as a minus sign. */
const MINUS_LIKE = /[−–—]/g;

/**
 * The integer the user typed, or null for anything else.
 * Spaces anywhere are ignored (`\s` covers no-break, thin and narrow no-break spaces);
 * leading zeros are fine; '+5', '4.5' and '1,000' are not.
 */
export function parseAnswer(raw: string): number | null {
  const s = raw.replace(/\s+/g, '').replace(MINUS_LIKE, '-');
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return n === 0 ? 0 : n;
}
