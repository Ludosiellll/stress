import type { Rating } from '../engine/elo';
import type { ModuleState } from '../engine/planner';
import type { FamilyId, ModuleId } from '../engine/types';
import type {
  BlockLevelRow,
  BlockRow,
  DiagnosticRow,
  LogicItemRow,
  LogRow,
  SessionRow,
  Settings,
  TrialRow,
  WellbeingRow,
} from './rows';

/** History tables whose ids a restore compares with the file (merge by id). */
export type HistoryTable = 'sessions' | 'blocks' | 'diagnostics' | 'wellbeing';

/**
 * Local store (§8.1). History rows are append-only: inserting an existing id rejects.
 * Lists are ordered by the documented key, ties in insertion order. Returned values are
 * copies: mutating them never changes what is stored.
 * The single-row inserts (createSession, addDiagnostic, addWellbeing) are batches of one (W2-R13).
 */
export interface Repository {
  /** addSessions([s]). */
  createSession(s: SessionRow): Promise<void>;
  /** One transaction; rejects and writes nothing when an id is already stored or repeats in the batch. */
  addSessions(rows: readonly SessionRow[]): Promise<void>;
  /** Sets endedAt; an unknown id is a no-op. */
  finishSession(id: string, endedAt: string): Promise<void>;
  /**
   * One transaction: the block, its trials and logic items are all stored or none is.
   * Rejects when the session is unknown, an id already exists, or a trial/item belongs to another block.
   */
  addBlock(b: BlockRow, trials: readonly TrialRow[], items: readonly LogicItemRow[]): Promise<void>;
  /** Whether a block with this id is stored (an addBlock retry after a lost reply checks it first, M8). */
  hasBlock(id: string): Promise<boolean>;
  /** addDiagnostics([d]): rejects when the session is unknown. */
  addDiagnostic(d: DiagnosticRow): Promise<void>;
  /** One transaction; rejects and writes nothing when an id is already stored or repeats, or a session is unknown. */
  addDiagnostics(rows: readonly DiagnosticRow[]): Promise<void>;
  /** addWellbeingRows([w]). */
  addWellbeing(w: WellbeingRow): Promise<void>;
  /** One transaction; rejects and writes nothing when an id is already stored or repeats in the batch. */
  addWellbeingRows(rows: readonly WellbeingRow[]): Promise<void>;
  /** Every stored id of a history table. */
  listIds(table: HistoryTable): Promise<Set<string>>;
  /** By startedAt. */
  listSessions(): Promise<SessionRow[]>;
  /** By startedAt. */
  listBlocks(): Promise<BlockRow[]>;
  /** Light rows of one module's blocks for deriveModuleStates (R26), by startedAt (ties: insertion). */
  listBlockLevels(module: ModuleId): Promise<BlockLevelRow[]>;
  /** Trials of one block by idx. */
  listTrials(blockId: string): Promise<TrialRow[]>;
  /** Every trial in one query (export, R20): by their block's startedAt (ties: block insertion), then idx. */
  listAllTrials(): Promise<TrialRow[]>;
  /** By at. */
  listLogicItems(): Promise<LogicItemRow[]>;
  /**
   * By at (ties: insertion), never by number: after a restore a local №1 can be newer than the restored №1…№k,
   * and the baseline, the latest diagnostic and the due date are read from this order (W2-R33).
   */
  listDiagnostics(): Promise<DiagnosticRow[]>;
  /** By date. */
  listWellbeing(): Promise<WellbeingRow[]>;
  /** Cache (rebuildable from history): every module, defaults where nothing was saved. */
  getModuleStates(): Promise<Record<ModuleId, ModuleState>>;
  saveModuleState(s: ModuleState): Promise<void>;
  /** Cache (rebuildable from history): only families that have a saved rating. */
  getRatings(): Promise<Map<FamilyId, Rating>>;
  /** Replaces the whole ratings cache with the given map (families not in it are dropped). */
  saveRatings(r: ReadonlyMap<FamilyId, Rating>): Promise<void>;
  /** Defaults: keyboard, null, null, stress volume 60. */
  getSettings(): Promise<Settings>;
  /** Writes only the given keys. */
  saveSettings(p: Partial<Settings>): Promise<void>;
  /** Settings keys saved at least once (getSettings fills the others with defaults). */
  storedSettingKeys(): Promise<Set<keyof Settings>>;
  /** Keeps the newest LOG_LIMIT entries (by insertion). Rejects an id already in the log. */
  appendLog(e: LogRow): Promise<void>;
  /** Newest first, at most `limit` entries. */
  listLog(limit: number): Promise<LogRow[]>;
}

export const LOG_LIMIT = 500;

export const DEFAULT_SETTINGS: Readonly<Settings> = { layout: 'keyboard', testDate: null, lastSelfCheckJson: null, stressVolume: 60 };

export const SETTINGS_KEYS: readonly (keyof Settings)[] = ['layout', 'testDate', 'lastSelfCheckJson', 'stressVolume'];

function assertFinite(what: string, fields: Record<string, number | null>): void {
  for (const [name, v] of Object.entries(fields)) {
    if (v !== null && !Number.isFinite(v)) throw new Error(`${what}: ${name} is not a finite number (${String(v)})`);
  }
}

/**
 * Trials and logic items must belong to the block they are saved with, and every number must be
 * finite (R23): NaN/Infinity would reach SQLite as JSON null through the Tauri bridge. A per-item
 * time limit must also be positive: rating rebuilds take log2(40000 / limit) of it (R36).
 */
export function assertBlockPayload(b: BlockRow, trials: readonly TrialRow[], items: readonly LogicItemRow[]): void {
  assertFinite(`block ${b.id}`, { score: b.score, lBefore: b.lBefore, lAfter: b.lAfter });
  for (const t of trials) {
    if (t.blockId !== b.id) throw new Error(`trial ${t.id} belongs to block ${t.blockId}, not ${b.id}`);
    assertFinite(`trial ${t.id}`, { idx: t.idx, onsetTs: t.onsetTs, responseTs: t.responseTs, rtMs: t.rtMs });
  }
  for (const i of items) {
    if (i.blockId !== b.id) throw new Error(`logic item ${i.id} belongs to block ${i.blockId}, not ${b.id}`);
    assertFinite(`logic item ${i.id}`, {
      seed: i.seed,
      difficulty: i.difficulty,
      answer: i.answer,
      given: i.given,
      timeMs: i.timeMs,
      timeLimitMs: i.timeLimitMs,
    });
    if (i.timeLimitMs !== null && i.timeLimitMs <= 0) {
      throw new Error(`logic item ${i.id}: timeLimitMs is not positive (${String(i.timeLimitMs)})`);
    }
  }
}
