import type { MemoryTrial } from './generate';

/** One reproduced row: what was entered, in order, and how long the answer took (from the response screen), ms. */
export interface MemoryAnswer {
  given: string[];
  timeMs: number;
}

/** exact: the whole row in order, nothing more; positionsCorrect: entries that match the item at their position. */
export function scoreMemoryTrial(t: MemoryTrial, a: MemoryAnswer): { exact: boolean; positionsCorrect: number } {
  const positionsCorrect = t.items.filter((x, i) => a.given[i] === x).length;
  return { exact: positionsCorrect === t.items.length && a.given.length === t.items.length, positionsCorrect };
}

function checkAnswered(fn: string, trials: readonly MemoryTrial[], answers: readonly MemoryAnswer[]): void {
  if (answers.length > trials.length) {
    throw new RangeError(`${fn}: ${String(answers.length)} answers for ${String(trials.length)} trials`);
  }
}

/** Span protocol: true when both trials of the last answered length are wrong (stop after this answer). */
export function spanProtocolStops(trials: readonly MemoryTrial[], answers: readonly MemoryAnswer[]): boolean {
  checkAnswered('spanProtocolStops', trials, answers);
  const last = trials[answers.length - 1];
  if (last === undefined) return false;
  const length = last.items.length;
  const sameLength = answers.flatMap((a, i) => {
    const t = trials[i] as MemoryTrial;
    return t.items.length === length ? [scoreMemoryTrial(t, a).exact] : [];
  });
  return sameLength.length >= 2 && sameLength.every((exact) => !exact);
}

/** The longest length with at least one exact trial among the answered ones; 0 if none. */
export function memorySpan(trials: readonly MemoryTrial[], answers: readonly MemoryAnswer[]): number {
  checkAnswered('memorySpan', trials, answers);
  return answers.reduce((span, a, i) => {
    const t = trials[i] as MemoryTrial;
    return scoreMemoryTrial(t, a).exact ? Math.max(span, t.items.length) : span;
  }, 0);
}
