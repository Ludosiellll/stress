import type { Rng } from '../../engine/rng';
import { assertPositiveInt, taskSequence, type TableCell, type TableParams, type TableTaskId } from './gorbov';

export interface TableClick {
  cell: TableCell;
  ts: number;
}

export interface TableRun {
  task: TableTaskId;
  startTs: number;
  timeLimitMs: number;
  total: number;
  clicks: TableClick[];
}

export interface TableRunResult {
  score: number;
  /** Last correct click − startTs; null unless the whole sequence was completed. */
  timeMs: number | null;
  errors: number;
  correct: number;
  completed: boolean;
}

function expectedSequence(run: TableRun): TableCell[] {
  assertPositiveInt(run.total, 'total');
  if (run.task === 'schulte') {
    const size = Math.sqrt(run.total);
    if (!Number.isInteger(size)) throw new RangeError(`schulte total must be a perfect square, got ${String(run.total)}`);
    return taskSequence('schulte', size);
  }
  const seq = taskSequence(run.task);
  if (seq.length !== run.total) {
    throw new RangeError(`${run.task} has ${String(seq.length)} steps, run.total is ${String(run.total)}`);
  }
  return seq;
}

/**
 * Walks the clicks in time order. A click on the next expected cell (value and color) is correct and
 * advances; any other click is an error and does not. Clicks after startTs + timeLimitMs are ignored.
 */
export function scoreTableRun(run: TableRun): TableRunResult {
  const seq = expectedSequence(run);
  const deadline = run.startTs + run.timeLimitMs;
  const clicks = run.clicks.filter((c) => c.ts <= deadline).sort((a, b) => a.ts - b.ts);

  let correct = 0;
  let errors = 0;
  let lastCorrectTs = run.startTs;
  for (const click of clicks) {
    const want = seq[correct];
    if (want !== undefined && want.value === click.cell.value && want.color === click.cell.color) {
      correct++;
      lastCorrectTs = click.ts;
    } else {
      errors++;
    }
  }

  const completed = correct === run.total;
  return {
    score: Math.max(0, correct - errors) / run.total,
    timeMs: completed ? lastCorrectTs - run.startTs : null,
    errors,
    correct,
    completed,
  };
}

/** A new random permutation; the input is left untouched. */
export function reshuffle(cells: readonly TableCell[], rng: Rng): TableCell[] {
  return rng.shuffle(cells);
}

export function describeTableParams(p: TableParams): Array<{ label: string; value: string }> {
  return [
    { label: 'Лимит времени', value: `${String(Math.round(p.timeLimitMs / 1000))} с` },
    { label: 'Перемешивание', value: p.reshuffleEvery === null ? 'нет' : `каждые ${String(p.reshuffleEvery)} верных` },
    { label: 'Размер', value: `${String(p.size)}×${String(p.size)}` },
  ];
}
