import { isCountedSession } from '../engine/derive';
import type { NormId } from '../engine/norms';
import { COND_PAIRS } from '../engine/reaction/conditions';
import type { BlockFlag, ModuleId, SessionKind } from '../engine/types';
import type { BlockRow } from '../data/rows';
import { MEMORY_TRIALS } from '../modules/memory/params';
import { szmr } from '../modules/reaction/szmr';
import { displayedCost, round1, whole } from './steps';

/**
 * The history of a block variant (assessment spec §2.3, Справочник «История»): one key metric per stored block,
 * rounded as shown, plus the norms that apply to it. Stored rows may be old or imported (their JSON is only
 * checked to be a string), so every read is defensive: an unreadable row has no variant or no number and is
 * left out, never thrown on.
 */

/** 'pzmr', 'gorbov:alternate', 'schulte:6', 'memory:digits'. */
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
/** A training memory block gives a span only with this many exact rows out of MEMORY_TRIALS. */
const MEMORY_SPAN_MIN_EXACT = 4;
const MS_PER_DAY = 86_400_000;

const GORBOV_TASKS = ['black_up', 'red_down', 'alternate'] as const;
const SCHULTE_PREFIX = 'schulte:';
const MEMORY_MODES = ['digits', 'letters', 'positions', 'card'] as const;

type Json = Readonly<Record<string, unknown>>;

/** A JSON object (not an array); anything else, unparsable text included, is null. */
function parseObject(text: string): Json | null {
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

export type GorbovTask = (typeof GORBOV_TASKS)[number];

/** The Горбов task: from the summary, else from the params. */
function gorbovTask(summary: Json | null, paramsJson: string): GorbovTask | null {
  return oneOf(summary, 'task', GORBOV_TASKS) ?? oneOf(parseObject(paramsJson), 'task', GORBOV_TASKS);
}

/** The task of a Горбов block, as its variant names it; null: unreadable. */
export function gorbovTaskOf(row: Pick<BlockRow, 'paramsJson' | 'summaryJson'>): GorbovTask | null {
  return gorbovTask(parseObject(row.summaryJson), row.paramsJson);
}

/** A finished table's time in seconds, rounded to 0,1 and above 0; null: not finished (or unreadable). */
function tableSeconds(summary: Json | null): number | null {
  return shown(summary, 'timeMs', (ms) => round1(ms / 1000), false);
}

function variantFrom(module: ModuleId, summary: Json | null, paramsJson: string): VariantKey | null {
  switch (module) {
    case 'gorbov': {
      const task = gorbovTask(summary, paramsJson);
      return task === null ? null : `gorbov:${task}`;
    }
    case 'schulte': {
      const size = num(parseObject(paramsJson), 'size');
      return size !== null && Number.isInteger(size) && size >= 1 ? `${SCHULTE_PREFIX}${String(size)}` : null;
    }
    case 'memory': {
      const mode = oneOf(summary, 'mode', MEMORY_MODES);
      return mode === null ? null : `memory:${mode}`;
    }
    default:
      return module;
  }
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
      const answers = summary?.['answers'];
      return Array.isArray(answers) ? percent(num(summary, 'exact'), answers.length) : null;
    }
    case 'numseries':
      return percent(num(summary, 'correct'), num(summary, 'total'));
    default:
      // An imported row is checked only as text: a module this version does not know has no number.
      return null;
  }
}

/** Memory: the span protocol's span; a training block's row length in digits with all 6 answers and ≥ 4 exact. */
function memoryNorms(summary: Json | null): NormSample[] {
  if (summary?.['protocol'] === 'span') {
    const span = wholeFromZero(summary, 'span');
    return span === null ? [] : [{ id: 'memorySpan', value: span }];
  }
  const answers = summary?.['answers'];
  const exact = num(summary, 'exact');
  const length = positiveWhole(summary, 'length');
  const full = Array.isArray(answers) && answers.length === MEMORY_TRIALS;
  if (oneOf(summary, 'mode', MEMORY_MODES) !== 'digits' || !full || exact === null || exact < MEMORY_SPAN_MIN_EXACT || exact > MEMORY_TRIALS) {
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
 * Training and free sessions: the response window cuts the slow answers off, so the mean of the hits grades too well
 * unless every trial was answered in time. ПЗМР and СЗМР get their norms only from a block without misses and late
 * answers that is not an overload block (FW2); the diagnostic window is wide, so its blocks always do.
 */
function rtGradable(row: NormRow, summary: Json | null, kind: SessionKind): boolean {
  if (!isCountedSession(kind)) return true;
  const counts = objectField(summary, 'counts');
  return !row.flags.includes('overload') && num(counts, 'miss') === 0 && num(counts, 'late') === 0;
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
      const task = gorbovTask(summary, paramsJson);
      const seconds = tableSeconds(summary);
      if (task === null || seconds === null) return [];
      return [{ id: task === 'alternate' ? 'gorbovAlternate' : 'gorbovSimple', value: seconds }];
    }
    case 'memory':
      return memoryNorms(summary);
    default:
      return [];
  }
}

export function variantOf(row: Pick<BlockRow, 'module' | 'paramsJson' | 'summaryJson'>): VariantKey | null {
  return variantFrom(row.module, parseObject(row.summaryJson), row.paramsJson);
}

/** Rounded as shown (Справочник «История»); null: no number. */
export function keyMetric(row: Pick<BlockRow, 'module' | 'summaryJson'>): number | null {
  return metricFrom(row.module, parseObject(row.summaryJson));
}

/** The norms that apply to the block of a `kind` session, key metric first (Справочник «Нормы», «Когда применять»). */
export function normSamples(row: NormRow & Pick<BlockRow, 'summaryJson'>, kind: SessionKind): NormSample[] {
  return normsFrom(row, parseObject(row.summaryJson), kind);
}

/** Training and free blocks without overload or timing_unreliable (fatigued and calibration count). */
export function entersHistory(flags: readonly BlockFlag[], kind: SessionKind): boolean {
  return isCountedSession(kind) && !flags.includes('overload') && !flags.includes('timing_unreliable');
}

/** The entry and its variant from one parse of the summary; null: no variant or no number. */
function keyedEntry(row: HistoryRow): { variant: VariantKey; entry: HistoryEntry } | null {
  const summary = parseObject(row.summaryJson);
  const variant = variantFrom(row.module, summary, row.paramsJson);
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

const MAIN_VARIANTS: Partial<Record<ModuleId, VariantKey>> = { gorbov: 'gorbov:alternate', memory: 'memory:digits' };

/** The grid size N of a Шульте variant «schulte:N»; null for any other variant. */
export function schulteSize(variant: VariantKey): number | null {
  if (!variant.startsWith(SCHULTE_PREFIX)) return null;
  const size = Number(variant.slice(SCHULTE_PREFIX.length));
  return Number.isInteger(size) && size >= 1 ? size : null;
}

/** The variant «Прогресс» shows: Шульте — the largest grid with entries (none: null); otherwise fixed. */
export function mainVariant(module: ModuleId, history: BlockHistory): VariantKey | null {
  if (module !== 'schulte') return MAIN_VARIANTS[module] ?? module;
  let largest: number | null = null;
  for (const [key, entries] of history) {
    const size = schulteSize(key);
    if (size !== null && entries.length > 0 && (largest === null || size > largest)) largest = size;
  }
  return largest === null ? null : `${SCHULTE_PREFIX}${String(largest)}`;
}
