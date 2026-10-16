/**
 * The recall model of the memory simulation, ported from the fixes simulation script `memory.ts` (spec §8.5). Its
 * numbers are expert judgement, labelled where they are used.
 */
import type { MemoryMode } from '../../../src/modules/memory/params';
import type { Rand } from './learner';

/** The practised visual digit span the spec's numbers assume. */
export const DIGIT_SPAN = 7.5;
/** The capacity of a row varies from trial to trial: K ~ N(K of the mode, 0.8). */
const CAPACITY_SD = 0.8;
/** How far letters and positions fall behind digits (spec §8.5: 6.5 and 6.3 for a digit span of 7.5). */
const LETTERS_BEHIND = 1;
const POSITIONS_BEHIND = 1.2;
/** The card: K(T) = (span + 1)·(1 − e^(−T/3.5)), seen whole it holds one digit more; × 0.93 with sound. */
const CARD_GAIN = 1;
const CARD_TIME_S = 3.5;
const CARD_SOUND = 0.93;

/** The mean capacity of a row of `mode` for a player of digit span `span`; the card by its exposure and sound. */
export function capacity(mode: MemoryMode, exposureMs: number | null, sound: boolean, span = DIGIT_SPAN): number {
  switch (mode) {
    case 'digits':
      return span;
    case 'letters':
      return span - LETTERS_BEHIND;
    case 'positions':
      return span - POSITIONS_BEHIND;
    case 'card3x3': {
      if (exposureMs === null) throw new RangeError('a card has an exposure');
      return (span + CARD_GAIN) * (1 - Math.exp(-exposureMs / 1000 / CARD_TIME_S)) * (sound ? CARD_SOUND : 1);
    }
  }
}

/**
 * The positions right in one row of `length` (spec §8.5): the trial's capacity K ~ N(kMean, 0.8); a row within K keeps
 * each position with 0.98; a longer one keeps positions 1…⌊K⌋ with 0.95, the last one with 0.5, the rest with 0.25.
 */
export function recallRow(r: Rand, length: number, kMean: number): number {
  const k = kMean + CAPACITY_SD * r.normal();
  let right = 0;
  for (let i = 1; i <= length; i++) {
    const p = length <= k ? 0.98 : i <= Math.floor(k) ? 0.95 : i === length ? 0.5 : 0.25;
    if (r.next() < p) right++;
  }
  return right;
}
