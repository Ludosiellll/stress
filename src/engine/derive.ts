import { isPlateau, savedLevel } from './adaptive';
import { R0, updateRating, type Rating } from './elo';
import { itemEffectiveDifficulty, itemLimitMs } from './itemLimit';
import { L_NORM, type ModuleState } from './planner';
import { isBandModule, MODULE_IDS, type BlockFlag, type FamilyId, type ModuleId, type SessionKind } from './types';

export { MODULE_IDS };

/** Caches (§8.1) are pure functions of history; these derive them. */

const COUNTED_KINDS: ReadonlySet<SessionKind> = new Set<SessionKind>(['training', 'free']);

/** Sessions whose blocks and logic items feed the caches (levels, ratings): training and free; diagnostics never (R19). */
export function isCountedSession(kind: SessionKind): boolean {
  return COUNTED_KINDS.has(kind);
}

/** Flags of blocks played at a level they never move. */
const NOT_MOVING_FLAGS: readonly BlockFlag[] = ['overload', 'warmup', 'test_format'];

/**
 * A block that moves the level: not an overload, a warm-up or a test-format block (T-R38: the one place this rule
 * lives). Only such blocks are calibration blocks, the previous block for g = 2 or a segment's first, and only they
 * make the module look trained (lastTrainedAt). A block counted as 0 after Esc (`discarded`, F11) moves the level as
 * well; the controller keeps it out of fatigue and of the previous score of g = 2 (T-R10).
 */
export function movesLevel(flags: readonly BlockFlag[]): boolean {
  return !flags.some((f) => NOT_MOVING_FLAGS.includes(f));
}

const UNCLEAN_FLAGS: readonly BlockFlag[] = ['fatigued', 'timing_unreliable'];

/**
 * A block that may move L_saved and feeds fatigue detection: movesLevel, without fatigued or timing_unreliable. A
 * `discarded` block is one (s = 0 is its end level, F11), but fatigue leaves it out (T-R10).
 */
export function isCleanBlock(flags: readonly BlockFlag[]): boolean {
  return movesLevel(flags) && !flags.some((f) => UNCLEAN_FLAGS.includes(f));
}

export function defaultModuleState(module: ModuleId): ModuleState {
  return { module, lSaved: 0, sessionEndLevels: [], savedHistory: [], plateau: false, lastTrainedAt: null, lifetimeBlocks: 0 };
}

/** Chronological order of ISO strings by instant; text order if either does not parse. */
function compareIso(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b ? -1 : a > b ? 1 : 0;
  return ta - tb;
}

/** Structural: SessionRow fits. */
export interface DeriveSession {
  id: string;
  startedAt: string;
  kind: SessionKind;
}

/** Structural: BlockRow and the light BlockLevelRow (listBlockLevels) both fit. */
export interface DeriveBlock {
  sessionId: string;
  module: ModuleId;
  lAfter: number;
  flags: readonly BlockFlag[];
  startedAt: string;
  /** Read for `band` only (Р9). */
  paramsJson: string;
}

/** A session's end level of a module as recorded; `loadRule`: its end block has a band (the load-band rules, Р9). */
export interface LevelPoint {
  level: number;
  loadRule: boolean;
}

/** Modules without a level (number series are rated by Elo): no end levels, lSaved 0, never a plateau (M9). */
const LEVELLESS: ReadonlySet<ModuleId> = new Set<ModuleId>(['numseries']);

/**
 * paramsJson.band, a whole number from 0 (F3); null: a block from before the bands, or damaged params. The one reader
 * of the stored band: the old level rule (Р9), the history variants and the window floor all go by it.
 */
export function storedBand(paramsJson: string): number | null {
  let params: unknown;
  try {
    params = JSON.parse(paramsJson);
  } catch {
    return null;
  }
  const band = typeof params === 'object' && params !== null ? (params as { band?: unknown }).band : undefined;
  return typeof band === 'number' && Number.isInteger(band) && band >= 0 ? band : null;
}

/** The counted sessions and their blocks, both by startedAt (ties keep input order). */
function countedInOrder(
  sessions: readonly DeriveSession[],
  blocks: readonly DeriveBlock[],
): { sessions: DeriveSession[]; blocks: DeriveBlock[] } {
  const counted = new Set(sessions.filter((s) => isCountedSession(s.kind)).map((s) => s.id));
  return {
    sessions: sessions.filter((s) => counted.has(s.id)).sort((a, b) => compareIso(a.startedAt, b.startedAt)),
    blocks: blocks.filter((b) => counted.has(b.sessionId)).sort((a, b) => compareIso(a.startedAt, b.startedAt)),
  };
}

/** End points of ordered counted sessions and blocks: the last clean block of each module in each session. */
function endPointsOf(sessions: readonly DeriveSession[], blocks: readonly DeriveBlock[]): Record<ModuleId, LevelPoint[]> {
  // Session id → module → end block; later blocks overwrite earlier ones.
  const ends = new Map<string, Map<ModuleId, DeriveBlock>>();
  for (const b of blocks) {
    if (LEVELLESS.has(b.module) || !isCleanBlock(b.flags)) continue;
    let perModule = ends.get(b.sessionId);
    if (!perModule) {
      perModule = new Map();
      ends.set(b.sessionId, perModule);
    }
    perModule.set(b.module, b);
  }
  const points = Object.fromEntries(MODULE_IDS.map((m) => [m, [] as LevelPoint[]])) as Record<ModuleId, LevelPoint[]>;
  for (const s of sessions) {
    for (const [module, b] of ends.get(s.id) ?? []) points[module].push({ level: b.lAfter, loadRule: storedBand(b.paramsJson) !== null });
  }
  return points;
}

/**
 * Each module's session end levels as recorded, in session order, from training and free sessions only: lAfter of the
 * session's last clean block of the module (by startedAt, isCleanBlock); sessions without such a block add nothing.
 * Ties keep input order. The level charts of «Прогресс» draw these.
 */
export function sessionEndPoints(sessions: readonly DeriveSession[], blocks: readonly DeriveBlock[]): Record<ModuleId, LevelPoint[]> {
  const ordered = countedInOrder(sessions, blocks);
  return endPointsOf(ordered.sessions, ordered.blocks);
}

/**
 * Module states from training and free sessions only (diagnostics never count).
 * The end levels are those of sessionEndPoints, except that in a band module a level of the old rule (an end block
 * without a band: the level was the window, Р9) counts as min(level, L_NORM): history rows never change, the caches
 * rebuilt from them do (spec §3.1.6). The plateau looks at the saved levels after load-rule sessions only, so capped
 * old levels never make a plateau on the day of the upgrade (T-R13); modules without bands look at every session.
 * Every block counts in lifetimeBlocks; lastTrainedAt is the last block that moves the level (movesLevel), so a
 * finisher, the daily ПЗМР warm-up or a test-format run does not make its module look trained and take away its
 * regular slot (W2-R40, F5, F4).
 * Number series keep the default state except lifetimeBlocks and lastTrainedAt.
 */
export function deriveModuleStates(
  sessions: readonly DeriveSession[],
  blocks: readonly DeriveBlock[],
): Record<ModuleId, ModuleState> {
  const states = Object.fromEntries(MODULE_IDS.map((m) => [m, defaultModuleState(m)])) as Record<ModuleId, ModuleState>;
  const ordered = countedInOrder(sessions, blocks);
  for (const b of ordered.blocks) {
    const st = states[b.module];
    st.lifetimeBlocks++;
    if (movesLevel(b.flags)) st.lastTrainedAt = b.startedAt;
  }

  const points = endPointsOf(ordered.sessions, ordered.blocks);
  for (const module of MODULE_IDS) {
    const st = states[module];
    const banded = isBandModule(module);
    const plateauHistory: number[] = [];
    for (const p of points[module]) {
      st.sessionEndLevels.push(banded && !p.loadRule ? Math.min(p.level, L_NORM[module]) : p.level);
      const saved = savedLevel(st.sessionEndLevels);
      st.savedHistory.push(saved);
      if (!banded || p.loadRule) plateauHistory.push(saved);
    }
    st.lSaved = savedLevel(st.sessionEndLevels);
    st.plateau = isPlateau(plateauHistory);
  }
  return states;
}

export interface DeriveItem {
  family: FamilyId;
  difficulty: number;
  correct: boolean;
  timeMs: number;
  /** null: stored before 0.2.0, when every item had 40 s. */
  timeLimitMs: number | null;
}

/**
 * Elo per family over items in chronological order (R36): D_eff from the stored limit, success =
 * correct within it. Rows without a limit get 40 s, so D_eff = difficulty and W1 ratings stay as they were.
 */
export function deriveRatings(items: readonly DeriveItem[]): Map<FamilyId, Rating> {
  const ratings = new Map<FamilyId, Rating>();
  for (const it of items) {
    const current = ratings.get(it.family) ?? { rating: R0, n: 0 };
    ratings.set(it.family, updateRating(current, itemEffectiveDifficulty(it), it.correct && it.timeMs <= itemLimitMs(it)));
  }
  return ratings;
}
