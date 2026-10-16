import type { Rng } from '../../engine/rng';
import { MEMORY_LETTERS, type MemoryMode, type MemoryParams } from './params';

/** One row to remember. */
export interface MemoryTrial {
  mode: MemoryMode;
  /** Digits '0'–'9', letters of MEMORY_LETTERS, or cell indices (row by row from 0) for positions. */
  items: string[];
  /** Side of the grid (positions) or the width of the card (3); 0 for digits and letters. */
  gridSide: number;
  /** Rows on screen: the card's rows of 3, the grid's side for positions; 0 for digits and letters (F13). */
  rows: number;
  itemMs: number;
  gapMs: number;
  /** How long the card stays: its exposure (F13); length·itemMs for the other modes, which do not use it. */
  cardMs: number;
  /** The card plays CARD_AUDIO while it is on screen (F13). */
  sound: boolean;
}

const DIGITS: readonly string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** The card is 3 digits wide, as on the test (F13). */
const CARD_COLUMNS = 3;

/** Span protocol (diagnostics, Task 12): digits at 1000 / 250 ms, lengths 3…12, two trials each. */
const SPAN_ITEM_MS = 1000;
const SPAN_GAP_MS = 250;
const SPAN_MIN_LENGTH: number = 3;
const SPAN_MAX_LENGTH: number = 12;
const SPAN_TRIALS_PER_LENGTH = 2;
/** Trials of the whole span protocol: 2 per length 3…12. */
export const SPAN_PROTOCOL_TRIALS = (SPAN_MAX_LENGTH - SPAN_MIN_LENGTH + 1) * SPAN_TRIALS_PER_LENGTH;
/**
 * The span protocol's timing, with the length of its first rows (its rows grow; the block step carries these). It plays
 * digits: no card, no sound (F13 leaves the protocol as it was).
 */
export const SPAN_PROTOCOL_PARAMS: Readonly<MemoryParams> = Object.freeze({
  length: SPAN_MIN_LENGTH,
  itemMs: SPAN_ITEM_MS,
  gapMs: SPAN_GAP_MS,
  exposureMs: null,
  rows: null,
  sound: false,
});

/** `length` picks from `pool` with no item twice in a row. */
function sequence(pool: readonly string[], length: number, rng: Rng): string[] {
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const prev = out[i - 1];
    out.push(rng.pick(prev === undefined ? pool : pool.filter((x) => x !== prev)));
  }
  return out;
}

/** A row of a sequential mode: one item at a time; positions light distinct cells of a max(3, ⌈√(length + 3)⌉) grid. */
function sequentialTrial(mode: Exclude<MemoryMode, 'card3x3'>, p: MemoryParams, rng: Rng): MemoryTrial {
  const { length, itemMs, gapMs } = p;
  let items: string[];
  let gridSide = 0;
  switch (mode) {
    case 'digits':
      items = sequence(DIGITS, length, rng);
      break;
    case 'letters':
      items = sequence(MEMORY_LETTERS, length, rng);
      break;
    case 'positions': {
      gridSide = Math.max(3, Math.ceil(Math.sqrt(length + 3)));
      // Distinct cells: no cell twice, so none twice in a row either.
      const cells = Array.from({ length: gridSide * gridSide }, (_, i) => String(i));
      items = rng.shuffle(cells).slice(0, length);
      break;
    }
  }
  return { mode, items, gridSide, rows: gridSide, itemMs, gapMs, cardMs: length * itemMs, sound: false };
}

/** The 3×3 card (F13): digits row by row in rows of 3, shown whole for its exposure; repeats, side by side too, allowed. */
function cardTrial(p: MemoryParams, rng: Rng): MemoryTrial {
  if (p.exposureMs === null || p.rows === null) throw new RangeError('a 3×3 card needs its exposure and rows');
  const items = Array.from({ length: p.length }, () => rng.pick(DIGITS));
  return { mode: 'card3x3', items, gridSide: CARD_COLUMNS, rows: p.rows, itemMs: p.itemMs, gapMs: p.gapMs, cardMs: p.exposureMs, sound: p.sound };
}

export function generateMemoryTrials(p: MemoryParams, mode: MemoryMode, count: number, rng: Rng): MemoryTrial[] {
  if (!(Number.isInteger(count) && count >= 0)) {
    throw new RangeError(`generateMemoryTrials: count must be an integer ≥ 0, got ${String(count)}`);
  }
  return Array.from({ length: count }, () => (mode === 'card3x3' ? cardTrial(p, rng) : sequentialTrial(mode, p, rng)));
}

/** The 20 trials of the span protocol in order: lengths 3, 3, 4, 4, …, 12, 12. */
export function spanProtocolTrials(rng: Rng): MemoryTrial[] {
  const trials: MemoryTrial[] = [];
  for (let length = SPAN_MIN_LENGTH; length <= SPAN_MAX_LENGTH; length++) {
    for (let k = 0; k < SPAN_TRIALS_PER_LENGTH; k++) {
      trials.push(sequentialTrial('digits', { ...SPAN_PROTOCOL_PARAMS, length }, rng));
    }
  }
  return trials;
}
