import { isPlateau, savedLevel } from './adaptive';
import { R0, updateRating, type Rating } from './elo';
import { itemEffectiveDifficulty, itemLimitMs } from './itemLimit';
import type { ModuleState } from './planner';
import { MODULE_IDS, type BlockFlag, type FamilyId, type ModuleId, type SessionKind } from './types';

export { MODULE_IDS };

/** Caches (§8.1) are pure functions of history; these derive them. */

const COUNTED_KINDS: ReadonlySet<SessionKind> = new Set<SessionKind>(['training', 'free']);

/** Sessions whose blocks and logic items feed the caches (levels, ratings): training and free; diagnostics never (R19). */
export function isCountedSession(kind: SessionKind): boolean {
  return COUNTED_KINDS.has(kind);
}

const UNCLEAN_FLAGS: readonly BlockFlag[] = ['fatigued', 'timing_unreliable', 'overload'];

/** A block that may move L_saved and feeds fatigue detection: without fatigued, timing_unreliable or overload. */
export function isCleanBlock(flags: readonly BlockFlag[]): boolean {
  return !flags.some((f) => UNCLEAN_FLAGS.includes(f));
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
}

/** Modules without a level (number series are rated by Elo): no end levels, lSaved 0, never a plateau (M9). */
const LEVELLESS: ReadonlySet<ModuleId> = new Set<ModuleId>(['numseries']);

/**
 * Module states from training and free sessions only (diagnostics never count).
 * A session's end level is lAfter of its last clean block of the module (by startedAt, isCleanBlock);
 * sessions without such a block add nothing. Ties keep input order.
 * Number series keep the default state except lifetimeBlocks and lastTrainedAt.
 */
export function deriveModuleStates(
  sessions: readonly DeriveSession[],
  blocks: readonly DeriveBlock[],
): Record<ModuleId, ModuleState> {
  const states = Object.fromEntries(MODULE_IDS.map((m) => [m, defaultModuleState(m)])) as Record<ModuleId, ModuleState>;
  const counted = new Set(sessions.filter((s) => isCountedSession(s.kind)).map((s) => s.id));
  const ordered = blocks.filter((b) => counted.has(b.sessionId)).sort((a, b) => compareIso(a.startedAt, b.startedAt));

  // Session id → module → end level; later blocks overwrite earlier ones.
  const endLevels = new Map<string, Map<ModuleId, number>>();
  for (const b of ordered) {
    const st = states[b.module];
    st.lifetimeBlocks++;
    st.lastTrainedAt = b.startedAt;
    if (LEVELLESS.has(b.module) || !isCleanBlock(b.flags)) continue;
    let perModule = endLevels.get(b.sessionId);
    if (!perModule) {
      perModule = new Map();
      endLevels.set(b.sessionId, perModule);
    }
    perModule.set(b.module, b.lAfter);
  }

  const orderedSessions = sessions.filter((s) => counted.has(s.id)).sort((a, b) => compareIso(a.startedAt, b.startedAt));
  for (const s of orderedSessions) {
    for (const [module, level] of endLevels.get(s.id) ?? []) {
      const st = states[module];
      st.sessionEndLevels.push(level);
      st.savedHistory.push(savedLevel(st.sessionEndLevels));
    }
  }
  for (const st of Object.values(states)) {
    st.lSaved = savedLevel(st.sessionEndLevels);
    st.plateau = isPlateau(st.savedHistory);
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
