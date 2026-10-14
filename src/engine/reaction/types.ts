import type { InputKey } from '../types';

export type ColorId = 'red' | 'green' | 'yellow' | 'blue' | 'white' | 'purple';
export type ShapeId = 'circle' | 'square' | 'triangle' | 'diamond' | 'hexagon' | 'star';

export type Stimulus =
  | { kind: 'shape'; shape: ShapeId; color: ColorId; frame?: ColorId }
  | { kind: 'rdo'; startDeg: number; targetDeg: number; periodMs: number };

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
}

export interface Press {
  key: InputKey;
  ts: number;
}

/** What actually happened during a block: stimulus onsets (one per trial) and every key press. */
export interface BlockTimeline {
  onsets: number[];
  droppedOnset: boolean[];
  presses: Press[];
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
  /** `timed` trials answered with the expected key: rtMs − targetOffsetMs (signed). */
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
