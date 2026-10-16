import { isCountedSession, storedBand } from '../engine/derive';
import type { NormId } from '../engine/norms';
import { COND_PAIRS } from '../engine/reaction/conditions';
import { penalizedScore } from '../engine/reaction/summary';
import type { Outcome } from '../engine/reaction/types';
import { isBandModule, type BlockFlag, type ModuleId, type SessionKind } from '../engine/types';
import type { BlockRow } from '../data/rows';
import { MEMORY_TRIALS, STORED_MEMORY_MODES, type StoredMemoryMode } from '../modules/memory/params';
import { RDO_PERIODS } from '../modules/reaction/rdo';
import { szmr } from '../modules/reaction/szmr';
import { displayedCost, round1, whole } from './steps';

/**
 * The history of a block variant (assessment spec §2.3, Справочник «История»): one key metric per stored block,
 * rounded as shown, plus the norms that apply to it. Stored rows may be old or imported (their JSON is only
 * checked to be a string), so every read is defensive: an unreadable row has no variant or no number and is
 * left out, never thrown on.
 */

/** 'pzmr', 'pzmr:b2', 'pzmr:warmup', 'szmr:test', 'rdo:3000', 'gorbov:alternate', 'gorbov:alternate:own', 'schulte:6', 'memory:digits'. */
export type VariantKey = string;

export interface KeyMetric {
  unit: 'мс' | 'с' | '%';
  better: 'lower' | 'higher';
  /** A difference of two medians (shown with its sign). */
  signed: boolean;
}

const MS: KeyMetric = Object.freeze({ unit: 'мс', better: 'lower', signed: false });
const COST: KeyMetric = Object.freeze({ unit: 'мс', better: 'lower', signed: true });
const SECONDS: KeyMetric = Object.freeze({ unit: 'с', better: 'lower', signed: false });
const PERCENT: KeyMetric = Object.freeze({ unit: '%', better: 'higher', signed: false });

export const KEY_METRICS: Readonly<Record<ModuleId, KeyMetric>> = Object.freeze({
  pzmr: MS,
  szmr: MS,
  gonogo: MS,
  rdo: MS,
  gorbov: SECONDS,
  schulte: SECONDS,
  stroop: COST,
  taskswitch: COST,
  pomeh: COST,
  memory: PERCENT,
  numseries: PERCENT,
});

export interface NormSample {
  id: NormId;
  value: number;
}

export interface HistoryEntry {
  /** startedAt of the block. */
  at: string;
  /** The key metric, rounded as shown. */
  value: number;
  /** lBefore: the level the block was played at. */
  L: number;
  /** The row length of a memory block; null for other modules. */
  length: number | null;
  norms: NormSample[];
}

export type BlockHistory = Map<VariantKey, HistoryEntry[]>;

export type HistoryRow = Pick<BlockRow, 'sessionId' | 'module' | 'lBefore' | 'flags' | 'startedAt' | 'paramsJson' | 'summaryJson'>;

/** The СЗМР norm is a choice of 2: it applies to a block of 2 colours on 2 keys only. */
export const isTwoChoice = (p: { nColors: number; nKeys: number }): boolean => p.nColors === 2 && p.nKeys === 2;
/**
 * A training memory block gives a span only with this many exact rows: of the MEMORY_TRIALS (10) rows of F13, 7; a
 * block of 0.2.0 had 6 rows and keeps its rule, 4 of them (T-R21).
 */
const MEMORY_SPAN_MIN_EXACT: ReadonlyMap<number, number> = new Map([
  [MEMORY_TRIALS, 7],
  [6, 4],
]);
const MS_PER_DAY = 86_400_000;

const GORBOV_TASKS = ['black_up', 'red_down', 'alternate'] as const;
const GORBOV_TABLES = ['series', 'own'] as const;
const SCHULTE_PREFIX = 'schulte:';
/** The modes a stored memory block may name: the played ones and the card of 0.2.0 (Р27, T-R21). */
const MEMORY_MODES: readonly StoredMemoryMode[] = STORED_MEMORY_MODES;

type Json = Readonly<Record<string, unknown>>;

/** A JSON object (not an array); anything else, unparsable text included, is null. Shared by the readers of stored rows. */
export function parseObject(text: string): Json | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/** An object field of an object; null otherwise. */
function objectField(o: Json | null, key: string): Json | null {
  const v = o?.[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

/** A finite number field; null otherwise. */
function num(o: Json | null, key: string): number | null {
  const v = o?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * A field rounded as shown, kept only above 0 (from 0 with `zeroOk`): a damaged or imported row with a 0 ms time would
 * otherwise stay «лучший» for ever (A-R16).
 */
function shown(o: Json | null, key: string, round: (x: number) => number, zeroOk: boolean): number | null {
  const v = num(o, key);
  if (v === null) return null;
  const r = round(v);
  return r > 0 || (zeroOk && r === 0) ? r : null;
}

/** A whole number above 0 as shown (a time in ms, a row length). */
const positiveWhole = (o: Json | null, key: string): number | null => shown(o, key, whole, false);
/** A whole number from 0 (an error by modulus, a SD, a span). */
const wholeFromZero = (o: Json | null, key: string): number | null => shown(o, key, whole, true);

/** A string field that is one of `values`; null otherwise. */
function oneOf<T extends string>(o: Json | null, key: string, values: readonly T[]): T | null {
  const v = o?.[key];
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null;
}

/** Every outcome once: a Record, so a new Outcome fails to compile until it is listed here. */
const OUTCOME_SET: Readonly<Record<Outcome, true>> = {
  hit: true,
  wrong: true,
  miss: true,
  late: true,
  false_start: true,
  commission: true,
  correct_reject: true,
  early: true,
  timing_late: true,
};
const OUTCOMES = Object.keys(OUTCOME_SET) as Outcome[];

/**
 * The penalised score of a stored reaction block, recomputed from summaryJson.counts (T-R31): blocks stored before F1
 * keep the plain share of successes as their score, so the stored score cannot be averaged with later ones. Every
 * summary since 0.1.0 stores all nine counts, one per non-practice trial, so n is their sum. null: counts missing,
 * damaged or all zero.
 */
export function scoreFromCounts(summaryJson: string): number | null {
  const raw = objectField(parseObject(summaryJson), 'counts');
  if (raw === null) return null;
  const counts = {} as Record<Outcome, number>;
  for (const o of OUTCOMES) {
    const v = raw[o];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null;
    counts[o] = v;
  }
  const n = OUTCOMES.reduce((sum, o) => sum + counts[o], 0);
  return n === 0 ? null : penalizedScore(counts, n);
}

export type GorbovTask = (typeof GORBOV_TASKS)[number];

/** The Горбов task: from the summary, else from the params. */
function gorbovTask(summary: Json | null, paramsJson: string): GorbovTask | null {
  return oneOf(summary, 'task', GORBOV_TASKS) ?? oneOf(parseObject(paramsJson), 'task', GORBOV_TASKS);
}

/** The mode of a memory block: from the summary, else from the params (a block counted as 0 after Esc has no summary). */
export function memoryModeOf(row: Pick<BlockRow, 'paramsJson' | 'summaryJson'>): StoredMemoryMode | null {
  return oneOf(parseObject(row.summaryJson), 'mode', MEMORY_MODES) ?? oneOf(parseObject(row.paramsJson), 'mode', MEMORY_MODES);
}

/** A Горбов block on a table of its own (F10: block 3 and later of a segment); a series block or one before F10 is not. */
function ownTable(paramsJson: string): boolean {
  return oneOf(parseObject(paramsJson), 'table', GORBOV_TABLES) === 'own';
}

/** The task of a Горбов block, as its variant names it; null: unreadable. */
export function gorbovTaskOf(row: Pick<BlockRow, 'paramsJson' | 'summaryJson'>): GorbovTask | null {
  return gorbovTask(parseObject(row.summaryJson), row.paramsJson);
}

/** A finished table's time in seconds, rounded to 0,1 and above 0; null: not finished (or unreadable). */
function tableSeconds(summary: Json | null): number | null {
  return shown(summary, 'timeMs', (ms) => round1(ms / 1000), false);
}

/** The ПЗМР warm-up is a variant of its own (F5, Р29): its blocks never become «лучший» of the main variant. */
const WARMUP_VARIANT: VariantKey = 'pzmr:warmup';
const BAND_PREFIX = ':b';

/**
 * A band module's variant (Р29): its warm-up's own, else the band the block played (`pzmr:b2`); a block without a band
 * (before 0.3.0) keeps the bare module key (T-R7).
 */
function bandVariant(module: ModuleId, flags: readonly BlockFlag[], paramsJson: string): VariantKey {
  if (flags.includes('warmup')) return WARMUP_VARIANT;
  const band = storedBand(paramsJson);
  return band === null ? module : `${module}${BAND_PREFIX}${String(band)}`;
}

/** A test-format run is a variant of its own (F4, Р29): the frozen diagnostic parameters, not a training band. */
const TEST_SUFFIX = ':test';
const OWN_SUFFIX = ':own';

function variantFrom(module: ModuleId, flags: readonly BlockFlag[], summary: Json | null, paramsJson: string): VariantKey | null {
  if (flags.includes('test_format')) return `${module}${TEST_SUFFIX}`;
  if (isBandModule(module)) return bandVariant(module, flags, paramsJson);
  switch (module) {
    case 'gorbov': {
      // A table of its own is not the test's series (T-R24): `gorbov:{task}:own`.
      const task = gorbovTask(summary, paramsJson);
      return task === null ? null : `gorbov:${task}${ownTable(paramsJson) ? OWN_SUFFIX : ''}`;
    }
    case 'schulte': {
      const size = num(parseObject(paramsJson), 'size');
      return size !== null && Number.isInteger(size) && size >= 1 ? `${SCHULTE_PREFIX}${String(size)}` : null;
    }
    case 'memory': {
      const mode = oneOf(summary, 'mode', MEMORY_MODES);
      return mode === null ? null : `memory:${mode}`;
    }
    case 'rdo':
      return rdoVariant(paramsJson);
    default:
      return module;
  }
}

/**
 * An РДО block is a variant of the speed it played (F14, T-R9): `rdo:1500` … `rdo:4000`. A block from before the speeds
 * (0.2.0 shrank the period with the level: 1679 ms at L 8) or with unreadable parameters keeps the bare key; one at
 * exactly one of the speeds (3000 ms at L 0) did play it.
 */
function rdoVariant(paramsJson: string): VariantKey {
  const periodMs = num(parseObject(paramsJson), 'periodMs');
  return periodMs !== null && (RDO_PERIODS as readonly number[]).includes(periodMs) ? `rdo:${String(periodMs)}` : 'rdo';
}

/** displayedCost of the module's fast and slow condition medians; null when either is unreadable. */
function costOf(module: keyof typeof COND_PAIRS, summary: Json | null): number | null {
  const pair = COND_PAIRS[module];
  const conditions = objectField(summary, 'conditions');
  const fast = positiveWhole(objectField(conditions, pair.fast), 'medianRt');
  const slow = positiveWhole(objectField(conditions, pair.slow), 'medianRt');
  return fast === null || slow === null ? null : displayedCost(fast, slow);
}

/** 100·part/total rounded to a whole percent; null without a positive total or with a part outside [0, total]. */
function percent(part: number | null, total: number | null): number | null {
  return part === null || total === null || total <= 0 || part < 0 || part > total ? null : whole((100 * part) / total);
}

function metricFrom(module: ModuleId, summary: Json | null): number | null {
  switch (module) {
    case 'pzmr':
    case 'szmr':
    case 'gonogo':
      return positiveWhole(summary, 'meanRt');
    case 'rdo':
      return wholeFromZero(summary, 'meanAbsErrorMs');
    case 'gorbov':
    case 'schulte':
      return tableSeconds(summary);
    case 'stroop':
    case 'taskswitch':
    case 'pomeh':
      return costOf(module, summary);
    case 'memory': {
      // The partial score of every row, old ones too (Р27): positions right of all the positions shown.
      const answers = summary?.['answers'];
      const length = num(summary, 'length');
      return Array.isArray(answers) && length !== null ? percent(num(summary, 'positionsCorrect'), length * answers.length) : null;
    }
    case 'numseries':
      return percent(num(summary, 'correct'), num(summary, 'total'));
    default:
      // An imported row is checked only as text: a module this version does not know has no number.
      return null;
  }
}

/**
 * Memory: the span protocol's span; a training block of digits gives its row length with all its rows answered and
 * enough of them exact: 7 of 10, or 4 of the 6 of a 0.2.0 block (MEMORY_SPAN_MIN_EXACT, T-R21).
 */
function memoryNorms(summary: Json | null): NormSample[] {
  if (summary?.['protocol'] === 'span') {
    const span = wholeFromZero(summary, 'span');
    return span === null ? [] : [{ id: 'memorySpan', value: span }];
  }
  const answers = summary?.['answers'];
  const exact = num(summary, 'exact');
  const length = positiveWhole(summary, 'length');
  const rows = Array.isArray(answers) ? answers.length : 0;
  const minExact = MEMORY_SPAN_MIN_EXACT.get(rows);
  if (oneOf(summary, 'mode', MEMORY_MODES) !== 'digits' || minExact === undefined || exact === null || exact < minExact || exact > rows) {
    return [];
  }
  return length === null ? [] : [{ id: 'memorySpan', value: length }];
}

/** Colours and keys the СЗМР block was played with: its stored params, else those of its level (FW8). */
function szmrPlayed(paramsJson: string, lBefore: number): { nColors: number; nKeys: number } {
  const params = parseObject(paramsJson);
  const nColors = num(params, 'nColors');
  const nKeys = num(params, 'nKeys');
  return nColors === null || nKeys === null ? szmr.params(lBefore) : { nColors, nKeys };
}

type NormRow = Pick<BlockRow, 'module' | 'lBefore' | 'flags' | 'paramsJson'>;

/**
 * No figures and no sound in the stored parameters: an absent or null `noise` and `audio` (a block from before the load
 * bands has neither field). A damaged value, or parameters that cannot be read, do not count as quiet.
 */
function playedQuiet(paramsJson: string): boolean {
  const params = parseObject(paramsJson);
  return params !== null && (params['noise'] ?? null) === null && (params['audio'] ?? null) === null;
}

/**
 * Played on the mouse: the stored `layout` is 'mouse' (F9). A row without it (before F9), or with a value of the wrong
 * type, played the keyboard; the remote control (arrows and digits) is a keyboard too.
 */
function playedOnMouse(paramsJson: string): boolean {
  return parseObject(paramsJson)?.['layout'] === 'mouse';
}

/**
 * The RT norms add KEYBOARD_OFFSET_MS for a keyboard: a ПЗМР or СЗМР block played on the mouse is never graded, in a
 * diagnostic either (a user whose own layout is the mouse plays it there), T-R23. Training and free sessions: the
 * response window cuts the slow answers off, so the mean of the hits grades too well unless every trial was answered in
 * time. ПЗМР and СЗМР get their norms only from a block without misses and late answers that is not an overload block
 * (FW2) and played on a quiet screen without sound, as the published norms were measured (T-R23); the diagnostic plays
 * the frozen 0.2.0 parameters with a wide window, so its keyboard blocks always do.
 */
function rtGradable(row: NormRow, summary: Json | null, kind: SessionKind): boolean {
  if (playedOnMouse(row.paramsJson)) return false;
  if (!isCountedSession(kind)) return true;
  const counts = objectField(summary, 'counts');
  return !row.flags.includes('overload') && num(counts, 'miss') === 0 && num(counts, 'late') === 0 && playedQuiet(row.paramsJson);
}

function normsFrom(row: NormRow, summary: Json | null, kind: SessionKind): NormSample[] {
  const { module, lBefore, paramsJson } = row;
  if ((module === 'pzmr' || module === 'szmr') && !rtGradable(row, summary, kind)) return [];
  switch (module) {
    case 'pzmr': {
      const mean = positiveWhole(summary, 'meanRt');
      const sd = wholeFromZero(summary, 'sdRt');
      const samples: NormSample[] = [];
      if (mean !== null) samples.push({ id: 'pzmrMean', value: mean });
      if (sd !== null) samples.push({ id: 'pzmrSd', value: sd });
      return samples;
    }
    case 'szmr': {
      const mean = positiveWhole(summary, 'meanRt');
      return mean !== null && isTwoChoice(szmrPlayed(paramsJson, lBefore)) ? [{ id: 'szmrMean', value: mean }] : [];
    }
    case 'gorbov': {
      // The norms are of the test's series on one table (T-R24).
      const task = gorbovTask(summary, paramsJson);
      const seconds = tableSeconds(summary);
      if (task === null || seconds === null || ownTable(paramsJson)) return [];
      return [{ id: task === 'alternate' ? 'gorbovAlternate' : 'gorbovSimple', value: seconds }];
    }
    case 'memory':
      return memoryNorms(summary);
    default:
      return [];
  }
}

export function variantOf(row: Pick<BlockRow, 'module' | 'flags' | 'paramsJson' | 'summaryJson'>): VariantKey | null {
  return variantFrom(row.module, row.flags, parseObject(row.summaryJson), row.paramsJson);
}

/** Rounded as shown (Справочник «История»); null: no number. */
export function keyMetric(row: Pick<BlockRow, 'module' | 'summaryJson'>): number | null {
  return metricFrom(row.module, parseObject(row.summaryJson));
}

/** The norms that apply to the block of a `kind` session, key metric first (Справочник «Нормы», «Когда применять»). */
export function normSamples(row: NormRow & Pick<BlockRow, 'summaryJson'>, kind: SessionKind): NormSample[] {
  return normsFrom(row, parseObject(row.summaryJson), kind);
}

/** Flags that keep a block out of the history: another load, a timing that measured nothing, a block counted as 0 after Esc (Р29). */
const OUT_OF_HISTORY: readonly BlockFlag[] = ['overload', 'timing_unreliable', 'discarded'];

/** Training and free blocks without overload, timing_unreliable or discarded (fatigued and calibration count). */
export function entersHistory(flags: readonly BlockFlag[], kind: SessionKind): boolean {
  return isCountedSession(kind) && !flags.some((f) => OUT_OF_HISTORY.includes(f));
}

/** The entry and its variant from one parse of the summary; null: no variant or no number. */
function keyedEntry(row: HistoryRow): { variant: VariantKey; entry: HistoryEntry } | null {
  const summary = parseObject(row.summaryJson);
  const variant = variantFrom(row.module, row.flags, summary, row.paramsJson);
  const value = metricFrom(row.module, summary);
  if (variant === null || value === null) return null;
  return {
    variant,
    entry: {
      at: row.startedAt,
      value,
      L: row.lBefore,
      length: row.module === 'memory' ? positiveWhole(summary, 'length') : null,
      // History entries are of training and free blocks only.
      norms: normsFrom(row, summary, 'training'),
    },
  };
}

/** null: no variant or no number. */
export function historyEntry(row: HistoryRow): HistoryEntry | null {
  return keyedEntry(row)?.entry ?? null;
}

/** The one place an entry enters the history: appended to its variant, in the order blocks come. */
export function appendBlock(history: BlockHistory, row: HistoryRow, kind: SessionKind): void {
  if (!entersHistory(row.flags, kind)) return;
  const keyed = keyedEntry(row);
  if (keyed === null) return;
  const entries = history.get(keyed.variant);
  if (entries === undefined) history.set(keyed.variant, [keyed.entry]);
  else entries.push(keyed.entry);
}

/** Blocks in listBlocks order (by startedAt); a block of an unknown session is left out. */
export function buildBlockHistory(blocks: readonly HistoryRow[], sessions: readonly { id: string; kind: SessionKind }[]): BlockHistory {
  const kinds = new Map(sessions.map((s) => [s.id, s.kind]));
  const history: BlockHistory = new Map();
  for (const row of blocks) {
    const kind = kinds.get(row.sessionId);
    if (kind !== undefined) appendBlock(history, row, kind);
  }
  return history;
}

export interface HistoryStats {
  /** The last entry («прошлый раз»). */
  last: HistoryEntry;
  best: number;
  /** Mean over [now − 7 days, now]; null: no entry there. */
  mean7d: number | null;
  /** Best over [now − 30 days, now]; null: no entry there. */
  best30d: number | null;
}

function bestOf(values: readonly number[], better: 'lower' | 'higher'): number {
  return values.reduce((a, b) => (better === 'lower' ? Math.min(a, b) : Math.max(a, b)));
}

/** Values of the entries dated within [now − days, now]; an unreadable `at` is in no window. */
function windowValues(entries: readonly HistoryEntry[], now: Date, days: number): number[] {
  const end = now.getTime();
  const start = end - days * MS_PER_DAY;
  return entries
    .filter((e) => {
      const at = Date.parse(e.at);
      return at >= start && at <= end;
    })
    .map((e) => e.value);
}

export function historyStats(entries: readonly HistoryEntry[], now: Date, better: 'lower' | 'higher'): HistoryStats | null {
  const last = entries.at(-1);
  if (last === undefined) return null;
  const week = windowValues(entries, now, 7);
  const month = windowValues(entries, now, 30);
  return {
    last,
    best: bestOf(entries.map((e) => e.value), better),
    mean7d: week.length === 0 ? null : week.reduce((a, b) => a + b, 0) / week.length,
    best30d: month.length === 0 ? null : bestOf(month, better),
  };
}

/** РДО: the speed of the test (T-R9). */
const MAIN_VARIANTS: Partial<Record<ModuleId, VariantKey>> = { gorbov: 'gorbov:alternate', memory: 'memory:digits', rdo: 'rdo:3000' };

/** The grid size N of a Шульте variant «schulte:N»; null for any other variant. */
export function schulteSize(variant: VariantKey): number | null {
  if (!variant.startsWith(SCHULTE_PREFIX)) return null;
  const size = Number(variant.slice(SCHULTE_PREFIX.length));
  return Number.isInteger(size) && size >= 1 ? size : null;
}

/** When an entry was stored; an unreadable date is the earliest. */
function storedAt(entry: HistoryEntry | undefined): number {
  const at = entry === undefined ? NaN : Date.parse(entry.at);
  return Number.isNaN(at) ? -Infinity : at;
}

/**
 * A band module's main variant (Р29, T-R7): of the bare key (blocks from before the bands) and its band variants, the
 * one whose last entry is the latest; the bare key without any. The variants of the warm-up and of the test-format
 * runs never are.
 */
function latestBandVariant(module: ModuleId, history: BlockHistory): VariantKey {
  const prefix = `${module}${BAND_PREFIX}`;
  let main: VariantKey = module;
  let latest = -Infinity;
  for (const [key, entries] of history) {
    if (key !== module && !key.startsWith(prefix)) continue;
    const at = storedAt(entries.at(-1));
    if (at > latest) {
      main = key;
      latest = at;
    }
  }
  return main;
}

/**
 * The variant «Прогресс» shows: a band module's latest band (latestBandVariant); Шульте — the largest grid with
 * entries (none: null); otherwise fixed.
 */
export function mainVariant(module: ModuleId, history: BlockHistory): VariantKey | null {
  if (isBandModule(module)) return latestBandVariant(module, history);
  if (module !== 'schulte') return MAIN_VARIANTS[module] ?? module;
  let largest: number | null = null;
  for (const [key, entries] of history) {
    const size = schulteSize(key);
    if (size !== null && entries.length > 0 && (largest === null || size > largest)) largest = size;
  }
  return largest === null ? null : `${SCHULTE_PREFIX}${String(largest)}`;
}
