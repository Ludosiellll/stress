import type { Rng } from '../../engine/rng';
import { assertPositiveInt, type TableCell, type TableParams } from './gorbov';

export function schulteParams(L: number): TableParams {
  const size = Math.min(9, 5 + Math.floor(L / 8));
  const cells = size * size;
  return {
    timeLimitMs: Math.round(Math.max(cells * 400, cells * 2400 * 0.93 ** (L - 8 * (size - 5)))),
    reshuffleEvery: null,
    size,
  };
}

/** Numbers 1..size², all black, in random order. */
export function generateSchulteTable(size: number, rng: Rng): TableCell[] {
  assertPositiveInt(size, 'schulte size');
  const cells: TableCell[] = Array.from({ length: size * size }, (_, i) => ({ value: i + 1, color: 'black' }));
  return rng.shuffle(cells);
}
