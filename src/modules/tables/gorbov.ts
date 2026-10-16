import type { Rng } from '../../engine/rng';

export interface TableCell {
  value: number;
  color: 'red' | 'black';
}

export type TableTaskId = 'black_up' | 'red_down' | 'alternate' | 'schulte';

export interface TableParams {
  timeLimitMs: number;
  /** Cells are reshuffled after this many correct clicks; null = never. */
  reshuffleEvery: number | null;
  /** Grid side: 7 for Gorbov. */
  size: number;
}

const GORBOV_SIZE = 7;
const BLACK_COUNT = 24;
const RED_COUNT = 25;
const GORBOV_TASKS = ['black_up', 'red_down', 'alternate'] as const;

/** Positive-integer guard shared by the table modules. */
export function assertPositiveInt(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`${what} must be a positive integer, got ${String(n)}`);
  }
}

export function gorbovParams(L: number, task: TableTaskId): TableParams {
  if (task === 'schulte') throw new RangeError('gorbovParams: schulte is not a Gorbov task');
  const multiplier = task === 'alternate' ? 1.6 : 1;
  return {
    timeLimitMs: Math.round(Math.max(15000, 120000 * 0.92 ** L) * multiplier),
    reshuffleEvery: L < 15 ? null : Math.max(1, 10 - Math.floor((L - 15) / 2)),
    size: GORBOV_SIZE,
  };
}

/** The 49 cells of a Gorbov table (red 1..25, black 1..24), shuffled; shown as 7×7. */
export function generateGorbovTable(rng: Rng): TableCell[] {
  const cells: TableCell[] = [];
  for (let v = 1; v <= RED_COUNT; v++) cells.push({ value: v, color: 'red' });
  for (let v = 1; v <= BLACK_COUNT; v++) cells.push({ value: v, color: 'black' });
  return rng.shuffle(cells);
}

/** The cells in the order they have to be clicked. `schulte` needs the grid side. */
export function taskSequence(task: TableTaskId, size?: number): TableCell[] {
  switch (task) {
    case 'black_up':
      return Array.from({ length: BLACK_COUNT }, (_, i) => ({ value: i + 1, color: 'black' }));
    case 'red_down':
      return Array.from({ length: RED_COUNT }, (_, i) => ({ value: RED_COUNT - i, color: 'red' }));
    case 'alternate': {
      const seq: TableCell[] = [];
      for (let i = 1; i <= BLACK_COUNT; i++) {
        seq.push({ value: i, color: 'black' }, { value: RED_COUNT + 1 - i, color: 'red' });
      }
      seq.push({ value: 1, color: 'red' });
      return seq;
    }
    case 'schulte': {
      if (size === undefined) throw new RangeError('taskSequence: schulte requires a size');
      assertPositiveInt(size, 'schulte size');
      return Array.from({ length: size * size }, (_, i) => ({ value: i + 1, color: 'black' }));
    }
  }
}

/** Gorbov runs cycle black_up → red_down → alternate. */
export function gorbovTaskForRun(runIndex: number): TableTaskId {
  if (!Number.isInteger(runIndex) || runIndex < 0) {
    throw new RangeError(`run index must be a non-negative integer, got ${String(runIndex)}`);
  }
  return GORBOV_TASKS[runIndex % GORBOV_TASKS.length] as TableTaskId;
}

/** Gorbov attention metrics from the three run times in seconds. */
export function gorbovMetrics(t1: number, t2: number, t3: number): { V: number; P: number; Pi: number } {
  return { V: (t1 + t2) / 2, P: t3, Pi: t3 - (t1 + t2) };
}

/** Added to the instruction of tasks 2–3 of a Горбов series, which play the table of task 1 (F10). */
export const SAME_TABLE_NOTE = ' Таблица та же, что в прошлом задании.';

export function tableInstruction(task: TableTaskId, size?: number): string {
  switch (task) {
    case 'black_up':
      return 'Находи и нажимай чёрные числа по порядку от 1 до 24.';
    case 'red_down':
      return 'Находи и нажимай красные числа от 25 до 1.';
    case 'alternate':
      return 'Чередуй: чёрное по возрастанию, красное по убыванию — 1 чёрное, 25 красное, 2 чёрное, 24 красное…';
    case 'schulte': {
      if (size === undefined) throw new RangeError('tableInstruction: schulte requires a size');
      assertPositiveInt(size, 'schulte size');
      return `Нажимай числа по порядку от 1 до ${String(size * size)}.`;
    }
  }
}
