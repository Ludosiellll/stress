import type { BlockFlag, FamilyId, LayoutId, ModuleId, SessionKind } from '../engine/types';

/** History rows are append-only (§8.1); `finishSession` is the only update. IDs are UUID v4, dates ISO strings. */
export interface SessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  kind: SessionKind;
  phase: string;
  appVersion: string;
}

export interface BlockRow {
  id: string;
  sessionId: string;
  module: ModuleId;
  lBefore: number;
  lAfter: number;
  paramsJson: string;
  score: number;
  flags: BlockFlag[];
  startedAt: string;
  summaryJson: string;
}

/** The columns of a block that level derivation and cache rebuilds need (listBlockLevels, R26). */
export interface BlockLevelRow {
  /** The block id (rebuildCaches maps logic items to their session through it, M6). */
  id: string;
  sessionId: string;
  module: ModuleId;
  lAfter: number;
  flags: BlockFlag[];
  startedAt: string;
  /** Read for its band: a band module's block without one is of the old level rule (Р9). */
  paramsJson: string;
}

export interface TrialRow {
  id: string;
  blockId: string;
  idx: number;
  stimulusJson: string;
  responseJson: string;
  onsetTs: number | null;
  responseTs: number | null;
  rtMs: number | null;
  outcome: string;
  frameDropped: boolean;
}

export interface LogicItemRow {
  id: string;
  blockId: string;
  family: FamilyId;
  seed: number;
  difficulty: number;
  answer: number;
  given: number | null;
  correct: boolean;
  timeMs: number;
  /** Per-item limit (R36); null: stored before 0.2.0 (it was 40 000) or a diagnostic item (the block's total limit applies). */
  timeLimitMs: number | null;
  at: string;
}

export interface DiagnosticRow {
  id: string;
  sessionId: string;
  number: number;
  at: string;
  resultsJson: string;
}

export interface WellbeingRow {
  id: string;
  date: string;
  sleepH: number;
  caffeine: boolean;
  mood: 1 | 2 | 3 | 4 | 5;
}

export interface LogRow {
  id: string;
  at: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  detail: string;
}

export interface Settings {
  layout: LayoutId;
  testDate: string | null;
  lastSelfCheckJson: string | null;
  /** Volume of the sound stressors, 0..100 % (default 60). */
  stressVolume: number;
}

/**
 * Tauri command contract (Ruling R21): `invoke<BackupStatus>('backup_status')` returns the
 * outcome of the backup made at startup (src-tauri/src/commands.rs). `ok` with `path: null`
 * means no copy was needed; `at` is Unix seconds. Task 14 writes it to app_log on startup.
 */
export interface BackupStatus {
  ok: boolean;
  path: string | null;
  error: string | null;
  at: number;
}
