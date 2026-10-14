import { defaultModuleState, MODULE_IDS } from '../engine/derive';
import type { Rating } from '../engine/elo';
import type { ModuleState } from '../engine/planner';
import type { FamilyId, ModuleId } from '../engine/types';
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

const copy = <T>(v: T): T => structuredClone(v);

/** Stable sort of copies by a string key (ties keep insertion order), as `ORDER BY key, rowid`. */
function sortedCopies<T>(rows: readonly T[], key: (r: T) => string | number): T[] {
  return rows.map(copy).sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Every id of `rows` is new to `stored` and to the rows before it in the batch. */
function assertAllNew(stored: readonly { id: string }[], rows: readonly { id: string }[], what: string): void {
  const ids = new Set(stored.map((x) => x.id));
  for (const r of rows) {
    if (ids.has(r.id)) throw new Error(`${what} ${r.id} already exists`);
    ids.add(r.id);
  }
}

/** In-memory Repository with the same contract as SqliteRepository (tests, web preview). */
export class MemoryRepository implements Repository {
  private readonly sessions: SessionRow[] = [];
  private readonly blocks: BlockRow[] = [];
  private readonly trials: TrialRow[] = [];
  private readonly items: LogicItemRow[] = [];
  private readonly diagnostics: DiagnosticRow[] = [];
  private readonly wellbeing: WellbeingRow[] = [];
  private readonly moduleStates = new Map<ModuleId, ModuleState>();
  private ratings = new Map<FamilyId, Rating>();
  private readonly settings = new Map<keyof Settings, unknown>();
  private log: LogRow[] = [];

  createSession(s: SessionRow): Promise<void> {
    return this.addSessions([s]);
  }

  addSessions(rows: readonly SessionRow[]): Promise<void> {
    return this.run(() => {
      assertAllNew(this.sessions, rows, 'session');
      this.sessions.push(...rows.map(copy));
    });
  }

  finishSession(id: string, endedAt: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s) s.endedAt = endedAt;
    return Promise.resolve();
  }

  addBlock(b: BlockRow, trials: readonly TrialRow[], items: readonly LogicItemRow[]): Promise<void> {
    return this.run(() => {
      // Validate everything first, then write: all or nothing.
      assertBlockPayload(b, trials, items);
      if (!this.sessions.some((s) => s.id === b.sessionId)) throw new Error(`session ${b.sessionId} not found`);
      assertAllNew(this.blocks, [b], 'block');
      assertAllNew(this.trials, trials, 'trial');
      assertAllNew(this.items, items, 'logic item');
      this.blocks.push(copy(b));
      this.trials.push(...trials.map(copy));
      this.items.push(...items.map(copy));
    });
  }

  hasBlock(id: string): Promise<boolean> {
    return Promise.resolve(this.blocks.some((b) => b.id === id));
  }

  addDiagnostic(d: DiagnosticRow): Promise<void> {
    return this.addDiagnostics([d]);
  }

  addDiagnostics(rows: readonly DiagnosticRow[]): Promise<void> {
    return this.run(() => {
      const sessions = new Set(this.sessions.map((s) => s.id));
      for (const d of rows) {
        if (!sessions.has(d.sessionId)) throw new Error(`session ${d.sessionId} not found`);
      }
      assertAllNew(this.diagnostics, rows, 'diagnostic');
      this.diagnostics.push(...rows.map(copy));
    });
  }

  addWellbeing(w: WellbeingRow): Promise<void> {
    return this.addWellbeingRows([w]);
  }

  addWellbeingRows(rows: readonly WellbeingRow[]): Promise<void> {
    return this.run(() => {
      assertAllNew(this.wellbeing, rows, 'wellbeing');
      this.wellbeing.push(...rows.map(copy));
    });
  }

  listIds(table: HistoryTable): Promise<Set<string>> {
    const rows: Record<HistoryTable, readonly { id: string }[]> = {
      sessions: this.sessions,
      blocks: this.blocks,
      diagnostics: this.diagnostics,
      wellbeing: this.wellbeing,
    };
    return Promise.resolve(new Set(rows[table].map((r) => r.id)));
  }

  listSessions(): Promise<SessionRow[]> {
    return Promise.resolve(sortedCopies(this.sessions, (s) => s.startedAt));
  }

  listBlocks(): Promise<BlockRow[]> {
    return Promise.resolve(sortedCopies(this.blocks, (b) => b.startedAt));
  }

  listBlockLevels(module: ModuleId): Promise<BlockLevelRow[]> {
    return Promise.resolve(
      sortedCopies(
        this.blocks.filter((b) => b.module === module),
        (b) => b.startedAt,
      ).map((b) => ({ id: b.id, sessionId: b.sessionId, module: b.module, lAfter: b.lAfter, flags: b.flags, startedAt: b.startedAt })),
    );
  }

  listTrials(blockId: string): Promise<TrialRow[]> {
    return Promise.resolve(
      sortedCopies(
        this.trials.filter((t) => t.blockId === blockId),
        (t) => t.idx,
      ),
    );
  }

  listAllTrials(): Promise<TrialRow[]> {
    const blockOrder = new Map(sortedCopies(this.blocks, (b) => b.startedAt).map((b, i) => [b.id, i]));
    const position = (t: TrialRow): number => blockOrder.get(t.blockId) ?? Number.MAX_SAFE_INTEGER;
    return Promise.resolve(this.trials.map(copy).sort((a, b) => position(a) - position(b) || a.idx - b.idx));
  }

  listLogicItems(): Promise<LogicItemRow[]> {
    return Promise.resolve(sortedCopies(this.items, (i) => i.at));
  }

  listDiagnostics(): Promise<DiagnosticRow[]> {
    return Promise.resolve(sortedCopies(this.diagnostics, (d) => d.number));
  }

  listWellbeing(): Promise<WellbeingRow[]> {
    return Promise.resolve(sortedCopies(this.wellbeing, (w) => w.date));
  }

  getModuleStates(): Promise<Record<ModuleId, ModuleState>> {
    const entries = MODULE_IDS.map((m) => [m, copy(this.moduleStates.get(m) ?? defaultModuleState(m))] as const);
    return Promise.resolve(Object.fromEntries(entries) as Record<ModuleId, ModuleState>);
  }

  saveModuleState(s: ModuleState): Promise<void> {
    this.moduleStates.set(s.module, copy(s));
    return Promise.resolve();
  }

  getRatings(): Promise<Map<FamilyId, Rating>> {
    return Promise.resolve(copy(this.ratings));
  }

  saveRatings(r: ReadonlyMap<FamilyId, Rating>): Promise<void> {
    this.ratings = new Map([...r].map(([f, rating]) => [f, copy(rating)]));
    return Promise.resolve();
  }

  getSettings(): Promise<Settings> {
    const s: Settings = { ...DEFAULT_SETTINGS };
    for (const [k, v] of this.settings) Object.assign(s, { [k]: copy(v) });
    return Promise.resolve(s);
  }

  saveSettings(p: Partial<Settings>): Promise<void> {
    for (const k of SETTINGS_KEYS) {
      if (k in p && p[k] !== undefined) this.settings.set(k, copy(p[k]));
    }
    return Promise.resolve();
  }

  storedSettingKeys(): Promise<Set<keyof Settings>> {
    return Promise.resolve(new Set(this.settings.keys()));
  }

  appendLog(e: LogRow): Promise<void> {
    return this.run(() => {
      assertAllNew(this.log, [e], 'log entry');
      this.log.push(copy(e));
      if (this.log.length > LOG_LIMIT) this.log = this.log.slice(-LOG_LIMIT);
    });
  }

  listLog(limit: number): Promise<LogRow[]> {
    return Promise.resolve([...this.log].reverse().slice(0, Math.max(0, limit)).map(copy));
  }

  /** Turns a synchronous throw into a rejection, like a failed SQL write. */
  private run(write: () => void): Promise<void> {
    try {
      write();
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
