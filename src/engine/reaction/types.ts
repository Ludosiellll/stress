import type { InputKey } from '../types';

/**
 * Every colour, in the order the СЗМР colour → key mapping uses. The last, grey, is never a stimulus: the noise takes
 * it only when every other colour is a target (Р13).
 */
export const COLOR_IDS = ['red', 'green', 'yellow', 'blue', 'white', 'purple', 'gray'] as const;
export type ColorId = (typeof COLOR_IDS)[number];
export const SHAPE_IDS = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'star'] as const;
export type ShapeId = (typeof SHAPE_IDS)[number];
/** Colours of the Stroop task (W2-R8). */
export type StroopColor = 'red' | 'green' | 'blue' | 'yellow';
/** The colour words the Stroop stimulus prints (the module's instruction and the canvas share them). */
export const COLOR_WORDS: Readonly<Record<StroopColor, string>> = {
  red: 'КРАСНЫЙ',
  green: 'ЗЕЛЁНЫЙ',
  blue: 'СИНИЙ',
  yellow: 'ЖЁЛТЫЙ',
};
/** Rules of the task-switching module: which feature of the figure the answer goes by. */
export type SwitchRule = 'color' | 'shape' | 'size';
/** The cue word shown above the figure. */
export const RULE_WORDS: Readonly<Record<SwitchRule, string>> = { color: 'ЦВЕТ', shape: 'ФОРМА', size: 'РАЗМЕР' };

export type Stimulus =
  /** `mark`: a white dot in the centre, 20 % of the figure's diameter (the Go/No-Go no-go most like the go, F8). */
  | { kind: 'shape'; shape: ShapeId; color: ColorId; frame?: ColorId; mark?: true }
  | { kind: 'rdo'; startDeg: number; targetDeg: number; periodMs: number }
  /**
   * A colour word (`word`) printed in another or the same colour (`ink`); the answer goes by the ink, or by the word
   * inside a white ring (`frame`, the reverse rule, F3).
   */
  | { kind: 'word'; word: StroopColor; ink: StroopColor; frame?: 'white' }
  /**
   * A figure under the word of its rule; the answer goes by the feature the rule names. `hideRule`: the word is not
   * shown (a run of one rule after its first trial, F3).
   */
  | { kind: 'switch'; rule: SwitchRule; color: 'red' | 'blue'; shape: 'circle' | 'square'; size: 'large' | 'small'; hideRule?: true };

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
  /**
   * The cue (StimulusRenderer.cue) appears this long before the onset and stays with the stimulus; the onset, the
   * window and the press timing do not change. Absent or 0: no cue.
   */
  cueLeadMs?: number;
  /**
   * The trial gets a mark after it when its outcome calls for one: «рано» or «ошибка» (F15). Absent: none (diagnostics,
   * warm-ups, test-format runs, РДО, phases without marks).
   */
  feedback?: boolean;
  /**
   * Where and how large the stimulus (and its cue) is drawn (F9), in shares of the canvas's shorter side: the centre
   * moved by (dx, dy), the size × scale. Absent: centred, as is (diagnostics, warm-ups, test-format runs, РДО).
   */
  jitter?: { dx: number; dy: number; scale: number };
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
  /** Set by ReactionView when the block had sound: whether it actually played (no device, a blocked context or volume 0: false). */
  audioPlayed?: boolean;
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
  /** The share of successes (`hit`, `correct_reject`): «Успешно» and the diagnostic Go/No-Go value. */
  score: number;
  /** s with the error penalty (penalizedScore, F1): the staircase score, stored as `blocks.score`. */
  penalizedScore: number;
  meanRt: number | null;
  medianRt: number | null;
  sdRt: number | null;
  cvRt: number | null;
  counts: Record<Outcome, number>;
  meanAbsErrorMs: number | null;
  meanSignedErrorMs: number | null;
  timingUnreliable: boolean;
}
