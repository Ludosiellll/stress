import { defaultModuleState, MODULE_IDS } from '../engine/derive';
import type { Rating } from '../engine/elo';
import type { ModuleState } from '../engine/planner';
import type { BlockFlag, FamilyId, ModuleId, SessionKind } from '../engine/types';
import { assertBlockPayload, DEFAULT_SETTINGS, LOG_LIMIT, SETTINGS_KEYS, type HistoryTable, type Repository } from './repository';
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
import type { SqlExecutor, SqlStatement } from './sqlExecutor';

// Raw rows as SELECT returns them (column names from src-tauri/migrations/*.sql).
interface SessionDb {
  id: string;
  started_at: string;
  ended_at: string | null;
  kind: string;
  phase: string;
  app_version: string;
}
interface BlockDb {
  id: string;
  session_id: string;
  module: string;
  l_before: number;
  l_after: number;
  params_json: string;
  score: number;
  flags_json: string;
  started_at: string;
  summary_json: string;
}
interface TrialDb {
  id: string;
  block_id: string;
  idx: number;
  stimulus_json: string;
  response_json: string;
  onset_ts: number | null;
  response_ts: number | null;
  rt_ms: number | null;
  outcome: string;
  frame_dropped: number;
}
interface LogicItemDb {
  id: string;
  block_id: string;
  family: string;
  seed: number;
  difficulty: number;
  answer: number;
  given: number | null;
  correct: number;
  time_ms: number;
  /** 0002; NULL in rows stored before 0.2.0. */
  time_limit_ms: number | null;
  at: string;
}
interface DiagnosticDb {
  id: string;
  session_id: string;
  number: number;
  at: string;
  results_json: string;
}
interface WellbeingDb {
  id: string;
  date: string;
  sleep_h: number;
  caffeine: number;
  mood: number;
}
interface ModuleStateDb {
  module: string;
  l_saved: number;
  session_end_levels_json: string;
  saved_history_json: string;
  plateau: number;
  last_trained_at: string | null;
  lifetime_blocks: number;
}
interface RatingDb {
  family: string;
  rating: number;
  n: number;
}
interface SettingDb {
  key: string;
  value: string;
}
interface LogDb {
  id: string;
  at: string;
  level: string;
  message: string;
  detail: string;
}

const bool = (b: boolean): number => (b ? 1 : 0);

function toTrial(r: TrialDb): TrialRow {
  return {
    id: r.id,
    blockId: r.block_id,
    idx: r.idx,
    stimulusJson: r.stimulus_json,
    responseJson: r.response_json,
    onsetTs: r.onset_ts,
    responseTs: r.response_ts,
    rtMs: r.rt_ms,
    outcome: r.outcome,
    frameDropped: r.frame_dropped !== 0,
  };
}

const INSERT_SESSION = 'INSERT INTO sessions (id, started_at, ended_at, kind, phase, app_version) VALUES (?, ?, ?, ?, ?, ?)';
const INSERT_DIAGNOSTIC = 'INSERT INTO diagnostics (id, session_id, number, at, results_json) VALUES (?, ?, ?, ?, ?)';
const INSERT_WELLBEING = 'INSERT INTO wellbeing (id, date, sleep_h, caffeine, mood) VALUES (?, ?, ?, ?, ?)';
const SELECT_IDS: Readonly<Record<HistoryTable, string>> = {
  sessions: 'SELECT id FROM sessions',
  blocks: 'SELECT id FROM blocks',
  diagnostics: 'SELECT id FROM diagnostics',
  wellbeing: 'SELECT id FROM wellbeing',
};
const INSERT_BLOCK = `INSERT INTO blocks (id, session_id, module, l_before, l_after, params_json, score, flags_json, started_at, summary_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_TRIAL = `INSERT INTO trials (id, block_id, idx, stimulus_json, response_json, onset_ts, response_ts, rt_ms, outcome, frame_dropped)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ITEM = `INSERT INTO logic_items (id, block_id, family, seed, difficulty, answer, given, correct, time_ms, time_limit_ms, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Repository over SQLite (tauri-plugin-sql in the app, sql.js in tests). Ties are ordered by rowid = insertion. */
export class SqliteRepository implements Repository {
  constructor(private readonly db: SqlExecutor) {}

  async createSession(s: SessionRow): Promise<void> {
    await this.addSessions([s]);
  }

  async addSessions(rows: readonly SessionRow[]): Promise<void> {
    await this.insertAll(rows, (s) => ({ sql: INSERT_SESSION, params: [s.id, s.startedAt, s.endedAt, s.kind, s.phase, s.appVersion] }));
  }

  async finishSession(id: string, endedAt: string): Promise<void> {
    await this.db.execute('UPDATE sessions SET ended_at = ? WHERE id = ?', [endedAt, id]);
  }

  async addBlock(b: BlockRow, trials: readonly TrialRow[], items: readonly LogicItemRow[]): Promise<void> {
    assertBlockPayload(b, trials, items);
    await this.db.transaction(async (tx) => {
      await tx.execute(INSERT_BLOCK, [
        b.id,
        b.sessionId,
        b.module,
        b.lBefore,
        b.lAfter,
        b.paramsJson,
        b.score,
        JSON.stringify(b.flags),
        b.startedAt,
        b.summaryJson,
      ]);
      for (const t of trials) {
        await tx.execute(INSERT_TRIAL, [
          t.id,
          t.blockId,
          t.idx,
          t.stimulusJson,
          t.responseJson,
          t.onsetTs,
          t.responseTs,
          t.rtMs,
          t.outcome,
          bool(t.frameDropped),
        ]);
      }
      for (const i of items) {
        await tx.execute(INSERT_ITEM, [
          i.id,
          i.blockId,
          i.family,
          i.seed,
          i.difficulty,
          i.answer,
          i.given,
          bool(i.correct),
          i.timeMs,
          i.timeLimitMs,
          i.at,
        ]);
      }
    });
  }

  async hasBlock(id: string): Promise<boolean> {
    const rows = await this.db.select<{ one: number }>('SELECT 1 AS one FROM blocks WHERE id = ? LIMIT 1', [id]);
    return rows.length > 0;
  }

  async addDiagnostic(d: DiagnosticRow): Promise<void> {
    await this.addDiagnostics([d]);
  }

  /** An unknown session fails the foreign key of diagnostics.session_id. */
  async addDiagnostics(rows: readonly DiagnosticRow[]): Promise<void> {
    await this.insertAll(rows, (d) => ({ sql: INSERT_DIAGNOSTIC, params: [d.id, d.sessionId, d.number, d.at, d.resultsJson] }));
  }

  async addWellbeing(w: WellbeingRow): Promise<void> {
    await this.addWellbeingRows([w]);
  }

  async addWellbeingRows(rows: readonly WellbeingRow[]): Promise<void> {
    await this.insertAll(rows, (w) => ({ sql: INSERT_WELLBEING, params: [w.id, w.date, w.sleepH, bool(w.caffeine), w.mood] }));
  }

  async listIds(table: HistoryTable): Promise<Set<string>> {
    const rows = await this.db.select<{ id: string }>(SELECT_IDS[table]);
    return new Set(rows.map((r) => r.id));
  }

  /** One transaction with an INSERT per row (a primary-key or foreign-key failure rolls back the batch); none for no rows. */
  private async insertAll<T>(rows: readonly T[], insert: (row: T) => SqlStatement): Promise<void> {
    if (rows.length === 0) return;
    const statements = rows.map(insert);
    await this.db.transaction(async (tx) => {
      for (const { sql, params } of statements) await tx.execute(sql, params);
    });
  }

  async listSessions(): Promise<SessionRow[]> {
    const rows = await this.db.select<SessionDb>('SELECT * FROM sessions ORDER BY started_at, rowid');
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      kind: r.kind as SessionKind,
      phase: r.phase,
      appVersion: r.app_version,
    }));
  }

  async listBlocks(): Promise<BlockRow[]> {
    const rows = await this.db.select<BlockDb>('SELECT * FROM blocks ORDER BY started_at, rowid');
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      module: r.module as ModuleId,
      lBefore: r.l_before,
      lAfter: r.l_after,
      paramsJson: r.params_json,
      score: r.score,
      flags: JSON.parse(r.flags_json) as BlockFlag[],
      startedAt: r.started_at,
      summaryJson: r.summary_json,
    }));
  }

  async listBlockLevels(module: ModuleId): Promise<BlockLevelRow[]> {
    const rows = await this.db.select<Pick<BlockDb, 'id' | 'session_id' | 'module' | 'l_after' | 'flags_json' | 'started_at' | 'params_json'>>(
      'SELECT id, session_id, module, l_after, flags_json, started_at, params_json FROM blocks WHERE module = ? ORDER BY started_at, rowid',
      [module],
    );
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      module: r.module as ModuleId,
      lAfter: r.l_after,
      flags: JSON.parse(r.flags_json) as BlockFlag[],
      startedAt: r.started_at,
      paramsJson: r.params_json,
    }));
  }

  async listTrials(blockId: string): Promise<TrialRow[]> {
    const rows = await this.db.select<TrialDb>('SELECT * FROM trials WHERE block_id = ? ORDER BY idx, rowid', [blockId]);
    return rows.map(toTrial);
  }

  async listAllTrials(): Promise<TrialRow[]> {
    const rows = await this.db.select<TrialDb>(
      'SELECT t.* FROM trials t JOIN blocks b ON b.id = t.block_id ORDER BY b.started_at, b.rowid, t.idx, t.rowid',
    );
    return rows.map(toTrial);
  }

  async listLogicItems(): Promise<LogicItemRow[]> {
    const rows = await this.db.select<LogicItemDb>('SELECT * FROM logic_items ORDER BY at, rowid');
    return rows.map((r) => ({
      id: r.id,
      blockId: r.block_id,
      family: r.family as FamilyId,
      seed: r.seed,
      difficulty: r.difficulty,
      answer: r.answer,
      given: r.given,
      correct: r.correct !== 0,
      timeMs: r.time_ms,
      timeLimitMs: r.time_limit_ms,
      at: r.at,
    }));
  }

  async listDiagnostics(): Promise<DiagnosticRow[]> {
    const rows = await this.db.select<DiagnosticDb>('SELECT * FROM diagnostics ORDER BY at, rowid');
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, number: r.number, at: r.at, resultsJson: r.results_json }));
  }

  async listWellbeing(): Promise<WellbeingRow[]> {
    const rows = await this.db.select<WellbeingDb>('SELECT * FROM wellbeing ORDER BY date, rowid');
    return rows.map((r) => ({
      id: r.id,
      date: r.date,
      sleepH: r.sleep_h,
      caffeine: r.caffeine !== 0,
      mood: r.mood as WellbeingRow['mood'],
    }));
  }

  async getModuleStates(): Promise<Record<ModuleId, ModuleState>> {
    const rows = await this.db.select<ModuleStateDb>('SELECT * FROM module_state');
    const states = Object.fromEntries(MODULE_IDS.map((m) => [m, defaultModuleState(m)])) as Record<ModuleId, ModuleState>;
    for (const r of rows) {
      const module = r.module as ModuleId;
      if (!MODULE_IDS.includes(module)) continue;
      states[module] = {
        module,
        lSaved: r.l_saved,
        sessionEndLevels: JSON.parse(r.session_end_levels_json) as number[],
        savedHistory: JSON.parse(r.saved_history_json) as number[],
        plateau: r.plateau !== 0,
        lastTrainedAt: r.last_trained_at,
        lifetimeBlocks: r.lifetime_blocks,
      };
    }
    return states;
  }

  async saveModuleState(s: ModuleState): Promise<void> {
    await this.db.execute(
      `INSERT INTO module_state (module, l_saved, session_end_levels_json, saved_history_json, plateau, last_trained_at, lifetime_blocks)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (module) DO UPDATE SET l_saved = excluded.l_saved,
         session_end_levels_json = excluded.session_end_levels_json, saved_history_json = excluded.saved_history_json,
         plateau = excluded.plateau, last_trained_at = excluded.last_trained_at, lifetime_blocks = excluded.lifetime_blocks`,
      [
        s.module,
        s.lSaved,
        JSON.stringify(s.sessionEndLevels),
        JSON.stringify(s.savedHistory),
        bool(s.plateau),
        s.lastTrainedAt,
        s.lifetimeBlocks,
      ],
    );
  }

  async getRatings(): Promise<Map<FamilyId, Rating>> {
    const rows = await this.db.select<RatingDb>('SELECT family, rating, n FROM ratings ORDER BY rowid');
    return new Map(rows.map((r) => [r.family as FamilyId, { rating: r.rating, n: r.n }]));
  }

  async saveRatings(r: ReadonlyMap<FamilyId, Rating>): Promise<void> {
    const updatedAt = new Date().toISOString();
    const entries = [...r];
    await this.db.transaction(async (tx) => {
      await tx.execute('DELETE FROM ratings');
      for (const [family, rating] of entries) {
        await tx.execute('INSERT INTO ratings (family, rating, n, updated_at) VALUES (?, ?, ?, ?)', [
          family,
          rating.rating,
          rating.n,
          updatedAt,
        ]);
      }
    });
  }

  async getSettings(): Promise<Settings> {
    const rows = await this.db.select<SettingDb>('SELECT key, value FROM settings');
    const s: Settings = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      if ((SETTINGS_KEYS as readonly string[]).includes(r.key)) Object.assign(s, { [r.key]: JSON.parse(r.value) as unknown });
    }
    return s;
  }

  async saveSettings(p: Partial<Settings>): Promise<void> {
    const pairs: [string, string][] = [];
    for (const k of SETTINGS_KEYS) {
      if (k in p && p[k] !== undefined) pairs.push([k, JSON.stringify(p[k])]);
    }
    if (pairs.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const [key, value] of pairs) {
        await tx.execute('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
          key,
          value,
        ]);
      }
    });
  }

  async storedSettingKeys(): Promise<Set<keyof Settings>> {
    const rows = await this.db.select<Pick<SettingDb, 'key'>>('SELECT key FROM settings');
    const known: readonly string[] = SETTINGS_KEYS;
    return new Set(rows.flatMap((r) => (known.includes(r.key) ? [r.key as keyof Settings] : [])));
  }

  async appendLog(e: LogRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute('INSERT INTO app_log (id, at, level, message, detail) VALUES (?, ?, ?, ?, ?)', [
        e.id,
        e.at,
        e.level,
        e.message,
        e.detail,
      ]);
      // Everything at or below the (LOG_LIMIT + 1)-th newest rowid goes; NULL (fewer rows) deletes nothing.
      await tx.execute('DELETE FROM app_log WHERE rowid <= (SELECT rowid FROM app_log ORDER BY rowid DESC LIMIT 1 OFFSET ?)', [
        LOG_LIMIT,
      ]);
    });
  }

  async listLog(limit: number): Promise<LogRow[]> {
    // The log never holds more than LOG_LIMIT rows; clamping also keeps Infinity out of LIMIT.
    const n = Math.min(LOG_LIMIT, Math.max(0, Math.floor(limit)));
    const rows = await this.db.select<LogDb>('SELECT * FROM app_log ORDER BY rowid DESC LIMIT ?', [n]);
    return rows.map((r) => ({ id: r.id, at: r.at, level: r.level as LogRow['level'], message: r.message, detail: r.detail }));
  }
}
