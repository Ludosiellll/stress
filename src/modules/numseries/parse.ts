/** Unicode minus, en dash and em dash all count as a minus sign. */
const MINUS_LIKE = /[\u2212\u2013\u2014]/g;

/**
 * The integer the user typed, or null for anything else (including integers beyond ±(2^53 − 1)).
 * Spaces anywhere are ignored (`\s` covers no-break, thin and narrow no-break spaces);
 * leading zeros are fine; '+5', '4.5' and '1,000' are not.
 */
export function parseAnswer(raw: string): number | null {
  const s = raw.replace(/\s+/g, '').replace(MINUS_LIKE, '-');
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  // Longer digit strings lose precision or become Infinity (R14).
  if (!Number.isSafeInteger(n)) return null;
  return n === 0 ? 0 : n;
}
