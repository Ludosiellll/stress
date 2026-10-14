import type { Rng } from '../../engine/rng';
import { MEMORY_LETTERS, type MemoryMode, type MemoryParams } from './params';

/** One row to remember. */
export interface MemoryTrial {
  mode: MemoryMode;
  /** Digits '0'–'9', letters of MEMORY_LETTERS, or cell indices (row by row from 0) for positions. */
  items: string[];
  /** Side of the grid (positions) or the card; 0 for digits and letters. */
  gridSide: number;
  itemMs: number;
  gapMs: number;
  /** How long the card stays: length·itemMs (kept for every mode; only the card uses it). */
  cardMs: number;
}

const DIGITS: readonly string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Span protocol (diagnostics, Task 12): digits at 1000 / 250 ms, lengths 3…12, two trials each. */
const SPAN_ITEM_MS = 1000;
const SPAN_GAP_MS = 250;
const SPAN_MIN_LENGTH: number = 3;
const SPAN_MAX_LENGTH: number = 12;
const SPAN_TRIALS_PER_LENGTH = 2;

/** `length` picks from `pool` with no item twice in a row. */
function sequence(pool: readonly string[], length: number, rng: Rng): string[] {
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const prev = out[i - 1];
    out.push(rng.pick(prev === undefined ? pool : pool.filter((x) => x !== prev)));
  }
  return out;
}

function gridSideFor(mode: MemoryMode, length: number): number {
  switch (mode) {
    case 'positions':
      return Math.max(3, Math.ceil(Math.sqrt(length + 3)));
    case 'card':
      return Math.max(3, Math.ceil(Math.sqrt(length)));
    case 'digits':
    case 'letters':
      return 0;
  }
}

function itemsFor(mode: MemoryMode, length: number, gridSide: number, rng: Rng): string[] {
  switch (mode) {
    case 'digits':
      return sequence(DIGITS, length, rng);
    case 'letters':
      return sequence(MEMORY_LETTERS, length, rng);
    case 'positions': {
      // Distinct cells: no cell twice, so none twice in a row either.
      const cells = Array.from({ length: gridSide * gridSide }, (_, i) => String(i));
      return rng.shuffle(cells).slice(0, length);
    }
    case 'card':
      // Shown all at once: repeats, even side by side, are allowed.
      return Array.from({ length }, () => rng.pick(DIGITS));
  }
}

function makeTrial(mode: MemoryMode, length: number, itemMs: number, gapMs: number, rng: Rng): MemoryTrial {
  const gridSide = gridSideFor(mode, length);
  return { mode, items: itemsFor(mode, length, gridSide, rng), gridSide, itemMs, gapMs, cardMs: length * itemMs };
}

export function generateMemoryTrials(p: MemoryParams, mode: MemoryMode, count: number, rng: Rng): MemoryTrial[] {
  if (!(Number.isInteger(count) && count >= 0)) {
    throw new RangeError(`generateMemoryTrials: count must be an integer ≥ 0, got ${String(count)}`);
  }
  return Array.from({ length: count }, () => makeTrial(mode, p.length, p.itemMs, p.gapMs, rng));
}

/** The 20 trials of the span protocol in order: lengths 3, 3, 4, 4, …, 12, 12. */
export function spanProtocolTrials(rng: Rng): MemoryTrial[] {
  const trials: MemoryTrial[] = [];
  for (let length = SPAN_MIN_LENGTH; length <= SPAN_MAX_LENGTH; length++) {
    for (let k = 0; k < SPAN_TRIALS_PER_LENGTH; k++) {
      trials.push(makeTrial('digits', length, SPAN_ITEM_MS, SPAN_GAP_MS, rng));
    }
  }
  return trials;
}
