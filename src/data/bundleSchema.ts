import { localDayNumber } from '../engine/dates';
import { MODULE_IDS, type BlockFlag, type LayoutId, type SessionKind } from '../engine/types';
import { ALL_FAMILIES } from '../modules/numseries/families';
import type { BlockRow, DiagnosticRow, LogicItemRow, SessionRow, TrialRow, WellbeingRow } from './rows';

/**
 * Reading a file written by exportBundle before a restore: the whole file is checked before anything is written.
 * Every row gets the fields and types of rows.ts (extra fields are dropped), ids are unique per table and every
 * reference points into the file. The first problem found becomes a message for the user.
 */

/** The settings a restore may take from a file. */
export type RestoredSetting = 'testDate' | 'layout';

/** What a restore takes from an export file. */
export interface ExportBundle {
  appVersion: string;
  exportedAt: string;
  sessions: SessionRow[];
  blocks: BlockRow[];
  trials: TrialRow[];
  logicItems: LogicItemRow[];
  diagnostics: DiagnosticRow[];
  wellbeing: WellbeingRow[];
  /** Only what a restore may use; a key the file does not have, or has with a bad value, stays absent. */
  settings: { testDate?: string | null; layout?: LayoutId };
  /** Settings the file has with a value that cannot be used: left out, never a reason to refuse the history (W2-R32). */
  settingsSkipped: RestoredSetting[];
}

export type ParseResult = { ok: true; bundle: ExportBundle } | { ok: false; error: string };

const TABLES = ['sessions', 'blocks', 'trials', 'logicItems', 'diagnostics', 'wellbeing'] as const;
type Table = (typeof TABLES)[number];

// Records rather than lists: the compiler checks that each holds every member of its type and nothing else.
const SESSION_KINDS: Readonly<Record<SessionKind, true>> = { training: true, diagnostic: true, free: true };
const BLOCK_FLAGS: Readonly<Record<BlockFlag, true>> = {
  fatigued: true,
  timing_unreliable: true,
  calibration: true,
  overload: true,
  warmup: true,
  test_format: true,
  discarded: true,
};
const LAYOUTS: Readonly<Record<LayoutId, true>> = { keyboard: true, mouse: true, pult: true };
const keysOf = <K extends string>(r: Readonly<Record<K, true>>): K[] => Object.keys(r) as K[];
const RESTORED_SETTINGS: Readonly<Record<RestoredSetting, true>> = { testDate: true, layout: true };

/** Far above any level the staircase reaches, and every generator stays bounded up to it (W2-R32). */
const LEVEL_MAX = 1000;
/** A lone UTF-16 surrogate: JSON.parse accepts it, serde_json on the Tauri bridge refuses it (W2-R32). */
const LONE_SURROGATE = /\p{Cs}/u;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = 'датой и временем ISO, например 2026-10-14T09:00:00.000Z';
const DATE = 'датой в виде ГГГГ-ММ-ДД';

/** A problem in the file; its message is shown to the user as is. */
class BundleError extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Date.parse reads it and so does localDayNumber, the parser Home uses (W2-R29). */
function readsAsDate(v: string): boolean {
  if (Number.isNaN(Date.parse(v))) return false;
  try {
    localDayNumber(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Written exactly as toISOString writes it, as the app always does (W2-R32): history lists sort date-times as
 * text, so another form of the same instant (no milliseconds, an offset, a bare date) would sort out of place.
 */
const isDateTime = (v: unknown): v is string => typeof v === 'string' && readsAsDate(v) && new Date(v).toISOString() === v;

/** A real local calendar date written as YYYY-MM-DD. */
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_ONLY.test(v) && readsAsDate(v);

const isLayout = (v: unknown): v is LayoutId => typeof v === 'string' && Object.hasOwn(LAYOUTS, v);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The fields of one JSON object, read with the type they must have; `where` starts every message. */
class Fields {
  constructor(
    private readonly where: string,
    private readonly row: JsonObject,
  ) {}

  private fail(field: string, expected: string): never {
    throw new BundleError(`${this.where}: поле ${field} должно быть ${expected}.`);
  }

  private read<T>(field: string, valid: (v: unknown) => v is T, expected: string): T {
    const v = this.row[field];
    return valid(v) ? v : this.fail(field, expected);
  }

  has(field: string): boolean {
    return Object.hasOwn(this.row, field);
  }

  string(field: string): string {
    const v = this.read(field, (x): x is string => typeof x === 'string', 'строкой');
    return LONE_SURROGATE.test(v) ? this.fail(field, 'строкой без повреждённых символов') : v;
  }

  number(field: string): number {
    return this.read(field, isFiniteNumber, 'числом');
  }

  /** A module level; fractional steps are normal, the bound keeps a damaged file from becoming L_saved (W2-R32). */
  level(field: string): number {
    return this.read(field, (v): v is number => isFiniteNumber(v) && v >= 0 && v <= LEVEL_MAX, `числом от 0 до ${String(LEVEL_MAX)}`);
  }

  numberOrNull(field: string): number | null {
    return this.read(field, (v): v is number | null => v === null || isFiniteNumber(v), 'числом или null');
  }

  boolean(field: string): boolean {
    return this.read(field, (v): v is boolean => typeof v === 'boolean', 'true или false');
  }

  dateTime(field: string): string {
    return this.read(field, isDateTime, DATE_TIME);
  }

  dateTimeOrNull(field: string): string | null {
    return this.read(field, (v): v is string | null => v === null || isDateTime(v), `${DATE_TIME}, или null`);
  }

  date(field: string): string {
    return this.read(field, isDate, DATE);
  }

  oneOf<T extends string>(field: string, values: readonly T[]): T {
    return this.read(field, (v): v is T => (values as readonly unknown[]).includes(v), `одним из: ${values.join(', ')}`);
  }

  flags(field: string): BlockFlag[] {
    const values = keysOf(BLOCK_FLAGS);
    const list = this.read(
      field,
      (v): v is BlockFlag[] => Array.isArray(v) && v.every((f) => (values as readonly unknown[]).includes(f)),
      `списком из: ${values.join(', ')}`,
    );
    return [...list];
  }

  mood(field: string): WellbeingRow['mood'] {
    return this.read(field, (v): v is WellbeingRow['mood'] => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5, 'целым числом от 1 до 5');
  }

  /** Absent in 0.1.0 files: null. Otherwise null or a positive number (addBlock refuses any other). */
  timeLimit(field: string): number | null {
    if (!this.has(field)) return null;
    return this.read(field, (v): v is number | null => v === null || (isFiniteNumber(v) && v > 0), 'положительным числом или null');
  }
}

const readSession = (f: Fields): SessionRow => ({
  id: f.string('id'),
  startedAt: f.dateTime('startedAt'),
  endedAt: f.dateTimeOrNull('endedAt'),
  kind: f.oneOf('kind', keysOf(SESSION_KINDS)),
  phase: f.string('phase'),
  appVersion: f.string('appVersion'),
});

const readBlock = (f: Fields): BlockRow => ({
  id: f.string('id'),
  sessionId: f.string('sessionId'),
  module: f.oneOf('module', MODULE_IDS),
  lBefore: f.level('lBefore'),
  lAfter: f.level('lAfter'),
  paramsJson: f.string('paramsJson'),
  score: f.number('score'),
  flags: f.flags('flags'),
  startedAt: f.dateTime('startedAt'),
  summaryJson: f.string('summaryJson'),
});

const readTrial = (f: Fields): TrialRow => ({
  id: f.string('id'),
  blockId: f.string('blockId'),
  idx: f.number('idx'),
  stimulusJson: f.string('stimulusJson'),
  responseJson: f.string('responseJson'),
  onsetTs: f.numberOrNull('onsetTs'),
  responseTs: f.numberOrNull('responseTs'),
  rtMs: f.numberOrNull('rtMs'),
  outcome: f.string('outcome'),
  frameDropped: f.boolean('frameDropped'),
});

const readLogicItem = (f: Fields): LogicItemRow => ({
  id: f.string('id'),
  blockId: f.string('blockId'),
  family: f.oneOf('family', ALL_FAMILIES),
  seed: f.number('seed'),
  difficulty: f.number('difficulty'),
  answer: f.number('answer'),
  given: f.numberOrNull('given'),
  correct: f.boolean('correct'),
  timeMs: f.number('timeMs'),
  timeLimitMs: f.timeLimit('timeLimitMs'),
  at: f.dateTime('at'),
});

const readDiagnostic = (f: Fields): DiagnosticRow => ({
  id: f.string('id'),
  sessionId: f.string('sessionId'),
  number: f.number('number'),
  at: f.dateTime('at'),
  resultsJson: f.string('resultsJson'),
});

const readWellbeing = (f: Fields): WellbeingRow => ({
  id: f.string('id'),
  date: f.date('date'),
  sleepH: f.number('sleepH'),
  caffeine: f.boolean('caffeine'),
  mood: f.mood('mood'),
});

/** The rows of `table`, each read by `read`, ids unique; `check` sees each row after it is read. */
function readTable<T extends { id: string }>(
  data: JsonObject,
  table: Table,
  read: (f: Fields) => T,
  check: (row: T, where: string) => void = () => undefined,
): T[] {
  const seen = new Set<string>();
  return (data[table] as unknown[]).map((value, i) => {
    const where = `Запись ${table}[${String(i)}]`;
    if (!isObject(value)) throw new BundleError(`${where} должна быть объектом JSON.`);
    const row = read(new Fields(where, value));
    if (seen.has(row.id)) throw new BundleError(`${where}: id ${row.id} повторяется.`);
    seen.add(row.id);
    check(row, where);
    return row;
  });
}

/** testDate and layout; a bad value (or settings that are not an object) is left out and named, never an error. */
function readSettings(value: unknown): Pick<ExportBundle, 'settings' | 'settingsSkipped'> {
  if (value === undefined) return { settings: {}, settingsSkipped: [] };
  if (!isObject(value)) return { settings: {}, settingsSkipped: keysOf(RESTORED_SETTINGS) };
  const settings: ExportBundle['settings'] = {};
  const settingsSkipped: RestoredSetting[] = [];
  if (Object.hasOwn(value, 'testDate')) {
    const v = value.testDate;
    if (v === null || isDate(v)) settings.testDate = v;
    else settingsSkipped.push('testDate');
  }
  if (Object.hasOwn(value, 'layout')) {
    if (isLayout(value.layout)) settings.layout = value.layout;
    else settingsSkipped.push('layout');
  }
  return { settings, settingsSkipped };
}

function readBundle(data: unknown): ExportBundle {
  const top: JsonObject = isObject(data) ? data : {};
  for (const table of TABLES) {
    if (!Array.isArray(top[table])) throw new BundleError(`Это не файл экспорта тренажёра: нет списка ${table}.`);
  }
  for (const field of ['appVersion', 'exportedAt']) {
    if (typeof top[field] !== 'string') throw new BundleError(`Это не файл экспорта тренажёра: нет поля ${field}.`);
  }
  const exportedAt = new Fields('Файл экспорта', top).dateTime('exportedAt');

  const sessions = readTable(top, 'sessions', readSession);
  const sessionIds = new Set(sessions.map((s) => s.id));
  const inSessions = (row: { sessionId: string }, where: string): void => {
    if (!sessionIds.has(row.sessionId)) throw new BundleError(`${where}: сессия ${row.sessionId} не найдена в файле.`);
  };
  const blocks = readTable(top, 'blocks', readBlock, inSessions);
  const blockIds = new Set(blocks.map((b) => b.id));
  const inBlocks = (row: { blockId: string }, where: string): void => {
    if (!blockIds.has(row.blockId)) throw new BundleError(`${where}: блок ${row.blockId} не найден в файле.`);
  };
  return {
    appVersion: top.appVersion as string,
    exportedAt,
    sessions,
    blocks,
    trials: readTable(top, 'trials', readTrial, inBlocks),
    logicItems: readTable(top, 'logicItems', readLogicItem, inBlocks),
    diagnostics: readTable(top, 'diagnostics', readDiagnostic, inSessions),
    wellbeing: readTable(top, 'wellbeing', readWellbeing),
    ...readSettings(top.settings),
  };
}

/** Checks a whole export file; nothing is written here. The error is the first problem found, for the user. */
export function parseExportBundle(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Файл не читается как JSON.' };
  }
  try {
    return { ok: true, bundle: readBundle(data) };
  } catch (e) {
    if (e instanceof BundleError) return { ok: false, error: e.message };
    throw e;
  }
}
