const two = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date, YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Local date and time for file names, YYYY-MM-DD-HHmm. */
export function localStamp(d: Date = new Date()): string {
  return `${localDate(d)}-${two(d.getHours())}${two(d.getMinutes())}`;
}

/** Number with a decimal comma, as the Russian UI writes it. */
export function decimal(n: number, digits = 1): string {
  return n.toFixed(digits).replace('.', ',');
}
