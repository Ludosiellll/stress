/**
 * The personal window floor (F3, spec §3.1.2): a band module's window never gets narrower than 1.2 × P80 of the
 * player's last clean hits on that load band. Pure rules; the band tables live in the modules and session/blocks.ts
 * joins the two.
 */

/** The floor is this many times the P80 of the clean hits (the tail bands of a ladder take less, FloorBand). */
export const FLOOR_FACTOR = 1.2;
/** The floor reads the last this many clean hits of the band. */
export const FLOOR_HITS = 60;
/** Fewer clean hits on a band give it no floor of its own (about one block). */
export const FLOOR_MIN_HITS = 15;

/** How the floor of a band follows from its hits and from the band below it. */
export interface FloorBand {
  /** Without enough hits of its own: the floor of the band below × chain. */
  chain: number;
  /** With them: floorFactor × P80. */
  floorFactor: number;
}

/** P80 by nearest rank: the ⌈0.8·k⌉-th smallest of k values. RangeError for none. */
export function p80(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError('p80: no values');
  const sorted = [...xs].sort((a, b) => a - b);
  // ⌈4k/5⌉ in integers: 0.8·k in floating point can land just above a whole number.
  return sorted[Math.ceil((4 * sorted.length) / 5) - 1] as number;
}

/** factor × P80 of the last FLOOR_HITS clean hits; null below FLOOR_MIN_HITS of them. */
export function floorFromHits(rts: readonly number[], factor: number): number | null {
  if (rts.length < FLOOR_MIN_HITS) return null;
  return factor * p80(rts.slice(-FLOOR_HITS));
}

/**
 * The floor of each band of a ladder, from the clean hits of each band in play order: its own hits when it has
 * FLOOR_MIN_HITS, otherwise the floor of the band below × the band's chain; band 0 without hits has none. Unrounded:
 * the window takes round(floor). RangeError for a band outside the ladder.
 */
export function bandFloors(hitsByBand: ReadonlyMap<number, readonly number[]>, bands: readonly FloorBand[]): (band: number) => number | null {
  const memo = new Map<number, number | null>();
  const floorOf = (band: number): number | null => {
    const known = memo.get(band);
    if (known !== undefined) return known;
    const b = bands[band];
    if (b === undefined) throw new RangeError(`bandFloors: no band ${String(band)} in a ladder of ${String(bands.length)}`);
    let floor = floorFromHits(hitsByBand.get(band) ?? [], b.floorFactor);
    if (floor === null && band > 0) {
      const below = floorOf(band - 1);
      floor = below === null ? null : below * b.chain;
    }
    memo.set(band, floor);
    return floor;
  };
  return floorOf;
}
