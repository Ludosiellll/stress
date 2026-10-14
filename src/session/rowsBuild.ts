import { v4 as uuidv4 } from 'uuid';
import type { BlockRow, LogicItemRow, LogRow, SessionRow, TrialRow, WellbeingRow } from '../data/rows';
import type { BlockTimeline, TrialResult, TrialSpec } from '../engine/reaction/types';
import type { BlockFlag, ModuleId, SessionKind } from '../engine/types';
import type { SeriesOutcome } from './blocks';

/** Repository rows of a session, built from what the controller knows. New ids are UUID v4. */

const PHASE = 'w1';

/** Local calendar date YYYY-MM-DD. */
export function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function sessionRow(id: string, startedAt: string, kind: SessionKind, appVersion: string): SessionRow {
  return { id, startedAt, endedAt: null, kind, phase: PHASE, appVersion };
}

export function blockRow(
  id: string,
  sessionId: string,
  b: { module: ModuleId; lBefore: number; lAfter: number; score: number; flags: BlockFlag[] },
  started: { startedAt: string; paramsJson: string },
  summaryJson: string,
): BlockRow {
  return {
    id,
    sessionId,
    module: b.module,
    lBefore: b.lBefore,
    lAfter: b.lAfter,
    paramsJson: started.paramsJson,
    score: b.score,
    flags: b.flags,
    startedAt: started.startedAt,
    summaryJson,
  };
}

/** One row per trial, practice included: the spec as stimulusJson, the response and outcome as responseJson. */
export function trialRows(
  blockId: string,
  specs: readonly TrialSpec[],
  tl: BlockTimeline,
  results: readonly TrialResult[],
): TrialRow[] {
  return results.map((r) => {
    const onset = tl.onsets[r.idx] ?? null;
    return {
      id: uuidv4(),
      blockId,
      idx: r.idx,
      stimulusJson: JSON.stringify(specs[r.idx] ?? null),
      responseJson: JSON.stringify({
        key: r.key,
        rtMs: r.rtMs,
        errorMs: r.errorMs,
        outcome: r.outcome,
        practice: r.practice,
        kind: r.kind,
      }),
      onsetTs: onset,
      responseTs: onset !== null && r.rtMs !== null ? onset + r.rtMs : null,
      rtMs: r.rtMs,
      outcome: r.outcome,
      frameDropped: r.frameDropped,
    };
  });
}

/** All items of a block share `at` (submit time); ties keep insertion order, so Elo rebuilds in the same order. */
export function logicItemRows(blockId: string, outcomes: readonly SeriesOutcome[], at: string): LogicItemRow[] {
  return outcomes.map(({ item, answer, correct }) => ({
    id: uuidv4(),
    blockId,
    family: item.family,
    seed: item.seed,
    difficulty: item.difficulty,
    answer: item.answer,
    given: answer.given,
    correct,
    timeMs: answer.timeMs,
    at,
  }));
}

/** Only the known fields of the answers are stored; the date is the local day of `now`. */
export function wellbeingRow(w: Omit<WellbeingRow, 'id' | 'date'>, now: Date): WellbeingRow {
  return { id: uuidv4(), date: localDate(now), sleepH: w.sleepH, caffeine: w.caffeine, mood: w.mood };
}

export function errorLogRow(at: string, message: string, detail: unknown): LogRow {
  return { id: uuidv4(), at, level: 'error', message, detail: JSON.stringify(detail) };
}
