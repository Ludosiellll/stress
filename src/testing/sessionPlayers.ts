import type { BlockTimeline, Press, TrialSpec } from '../engine/reaction/types';
import type { InputKey } from '../engine/types';
import type { MemoryTrial } from '../modules/memory/generate';
import type { MemoryAnswer } from '../modules/memory/score';
import type { TimedSeriesItem } from '../modules/numseries/generate';
import { taskSequence, type TableParams, type TableTaskId } from '../modules/tables/gorbov';
import type { TableRun } from '../modules/tables/score';
import type { SeriesAnswer } from '../session/steps';

/** Synthetic players for controller tests and simulations: no runner, no DOM. */

/** A player's answer to one trial: which key, how long after onset; null = no press. */
export type Respond = (spec: TrialSpec, idx: number) => { key: InputKey; rtMs: number } | null;

/** Presses the expected key: timed trials exactly on target, press trials after 300 ms (inside the window); withholds. */
export const perfectPlayer: Respond = (spec) => {
  const e = spec.expected;
  if (e.kind === 'withhold') return null;
  if (e.kind === 'timed') return { key: e.key, rtMs: e.targetOffsetMs };
  return { key: e.key, rtMs: Math.min(300, spec.windowMs - 1) };
};

/**
 * Timeline as the runner produces it: trial i appears isi_i after the end of trial i − 1 (the first one isi_0
 * after t0); a trial ends at its in-window press, otherwise at onset + windowMs. Late presses are not modelled.
 */
export function playTimeline(
  specs: readonly TrialSpec[],
  respond: Respond,
  o: { t0?: number; dropped?: (idx: number) => boolean } = {},
): BlockTimeline {
  let end = o.t0 ?? 1000;
  const onsets: number[] = [];
  const droppedOnset: boolean[] = [];
  const presses: Press[] = [];
  specs.forEach((spec, idx) => {
    const onset = end + spec.isiMs;
    onsets.push(onset);
    droppedOnset.push(o.dropped?.(idx) ?? false);
    const r = respond(spec, idx);
    if (r !== null && r.rtMs <= spec.windowMs) {
      presses.push({ key: r.key, ts: onset + r.rtMs });
      end = onset + r.rtMs;
    } else {
      end = onset + spec.windowMs;
    }
  });
  return { onsets, droppedOnset, presses };
}

/** Clicks every cell of the task in order, one every `msPerClick`. */
export function perfectTableRun(
  step: { task: TableTaskId; params: TableParams },
  msPerClick = 300,
): TableRun {
  const seq = step.task === 'schulte' ? taskSequence('schulte', step.params.size) : taskSequence(step.task);
  return {
    task: step.task,
    startTs: 0,
    timeLimitMs: step.params.timeLimitMs,
    total: seq.length,
    clicks: seq.map((cell, i) => ({ cell, ts: (i + 1) * msPerClick })),
  };
}

/** Right answer to every item, `timeMs` each (the default 5 s is inside every per-item limit, ≥ 8 s). */
export function perfectSeriesAnswers(items: readonly TimedSeriesItem[], timeMs = 5000): SeriesAnswer[] {
  return items.map((it) => ({ itemId: it.id, given: it.answer, timeMs }));
}

/** Every row reproduced exactly, `timeMs` each. */
export function perfectMemoryAnswers(trials: readonly MemoryTrial[], timeMs = 3000): MemoryAnswer[] {
  return trials.map((t) => ({ given: [...t.items], timeMs }));
}
