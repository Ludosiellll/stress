import type { InputKey } from '../types';

export type ColorId = 'red' | 'green' | 'yellow' | 'blue' | 'white' | 'purple';
export type ShapeId = 'circle' | 'square' | 'triangle' | 'diamond' | 'hexagon' | 'star';
/** Colours of the Stroop task (W2-R8). */
export type StroopColor = 'red' | 'green' | 'blue' | 'yellow';

export type Stimulus =
  | { kind: 'shape'; shape: ShapeId; color: ColorId; frame?: ColorId }
  | { kind: 'rdo'; startDeg: number; targetDeg: number; periodMs: number }
  /** A colour word (`word`) printed in another or the same colour (`ink`); the answer goes by the ink. */
  | { kind: 'word'; word: StroopColor; ink: StroopColor };

/** Trial condition of modules that compare two kinds of trials (conditionStats, condCost). */
export type TrialCond = 'congruent' | 'incongruent' | 'quiet' | 'noisy' | 'repeat' | 'switch';

export type Expected =
  | { kind: 'press'; key: InputKey }
  | { kind: 'withhold' }
  | { kind: 'timed'; key: InputKey; targetOffsetMs: number; toleranceMs: number };

export interface TrialSpec {
  isiMs: number;
  windowMs: number;
  stimulus: Stimulus;
  expected: Expected;
  practice?: boolean;
  /** Stored with the spec; trials of modules without conditions have none. */
  cond?: TrialCond;
}

export interface Press {
  key: InputKey;
  ts: number;
}

/** What actually happened during a block: stimulus onsets (one per trial) and every key press. */
export interface BlockTimeline {
  onsets: number[];
  /** Per trial: its onset frame came more than 1.5 × `frameMs` after the previous frame. */
  droppedOnset: boolean[];
  presses: Press[];
  /**
   * The block's nominal frame interval (R37): the median of its frame deltas, or the session's measured interval
   * when the block had fewer than 10 of them. Absent on timelines not made by the runner.
   */
  frameMs?: number;
}

export type Outcome =
  | 'hit'
  | 'wrong'
  | 'miss'
  | 'late'
  | 'false_start'
  | 'commission'
  | 'correct_reject'
  | 'early'
  | 'timing_late';

export interface TrialResult {
  idx: number;
  /** Copied from the spec so a summary can tell `press` hits from `timed` hits. */
  kind: Expected['kind'];
  outcome: Outcome;
  success: boolean;
  /** Response time from onset; set whenever the trial got a response (in-window or late). */
  rtMs: number | null;
  /** `timed` trials answered with the expected key, false starts excluded: rtMs − targetOffsetMs (signed). */
  errorMs: number | null;
  key: InputKey | null;
  frameDropped: boolean;
  practice: boolean;
}

export interface ReactionSummary {
  n: number;
  score: number;
  meanRt: number | null;
  medianRt: number | null;
  sdRt: number | null;
  cvRt: number | null;
  counts: Record<Outcome, number>;
  meanAbsErrorMs: number | null;
  meanSignedErrorMs: number | null;
  timingUnreliable: boolean;
}
