import type { DiagnosticMetrics } from '../engine/diagnostic';
import { NORMS, gradeByBands, type NormId } from '../engine/norms';
import { decimal, round1, shownCost, signedMs, whole } from './steps';

/** One row of the diagnostic results on «Сессия завершена». */
export type DiagnosticRowId =
  | 'pzmr'
  | 'szmr'
  | 'gonogo'
  | 'rdo'
  | 'gorbovV'
  | 'gorbovP'
  | 'gorbovPi'
  | 'numseries'
  | 'pomeh'
  | 'stroop'
  | 'taskswitch'
  | 'memory';

/** Done's order (the 0.1.0 rows first, then the W2 ones). */
export const DIAGNOSTIC_ROW_IDS: readonly DiagnosticRowId[] = Object.freeze([
  'pzmr',
  'szmr',
  'gonogo',
  'rdo',
  'gorbovV',
  'gorbovP',
  'gorbovPi',
  'numseries',
  'pomeh',
  'stroop',
  'taskswitch',
  'memory',
] as const);

const orNull = <T>(x: T | null, f: (v: T) => number): number | null => (x === null ? null : f(x));

/**
 * The value of a row as Done shows it: the medians and the РДО error in whole ms, Go/No-Go in whole percent,
 * V, P and Π in seconds to 0,1, the series and the span whole, the differences as shownCost. null: not measured.
 */
export function diagnosticValue(d: DiagnosticMetrics, id: DiagnosticRowId): number | null {
  switch (id) {
    case 'pzmr':
      return orNull(d.pzmrMedianRt, whole);
    case 'szmr':
      return orNull(d.szmrMedianRt, whole);
    case 'gonogo':
      return orNull(d.gonogoScore, whole);
    case 'rdo':
      return orNull(d.rdoMeanAbsErrorMs, whole);
    case 'gorbovV':
      return orNull(d.gorbov, (g) => round1(g.V));
    case 'gorbovP':
      return orNull(d.gorbov, (g) => round1(g.P));
    case 'gorbovPi':
      return orNull(d.gorbov, (g) => round1(g.Pi));
    case 'numseries':
      return orNull(d.numseriesCorrect, whole);
    case 'pomeh':
      return shownCost(d.pomehQuietRt, d.pomehNoisyRt, d.pomehDeltaMs);
    case 'stroop':
      return shownCost(d.stroopCongruentRt, d.stroopIncongruentRt, d.stroopInterferenceMs);
    case 'taskswitch':
      return shownCost(d.switchRepeatRt, d.switchSwitchRt, d.switchCostMs);
    case 'memory':
      return orNull(d.memorySpan, whole);
  }
}

type Unit = 'мс' | '%' | 'с' | '';

const UNITS: Readonly<Record<DiagnosticRowId, Unit>> = Object.freeze({
  pzmr: 'мс',
  szmr: 'мс',
  gonogo: '%',
  rdo: 'мс',
  gorbovV: 'с',
  gorbovP: 'с',
  gorbovPi: 'с',
  numseries: '',
  pomeh: 'мс',
  stroop: 'мс',
  taskswitch: 'мс',
  memory: '',
});

const HIGHER_IS_BETTER: ReadonlySet<DiagnosticRowId> = new Set(['gonogo', 'numseries', 'memory']);
/** Differences of medians: shown with their sign, as the block summary shows them. */
const SIGNED: ReadonlySet<DiagnosticRowId> = new Set(['pomeh', 'stroop', 'taskswitch']);

/** «41,3», «−3,7», with `plus` «+2,0»: one decimal, the minus sign U+2212. */
function secondsText(x: number, plus: boolean): string {
  const text = decimal(Math.abs(x), 1);
  if (x < 0) return `−${text}`;
  return plus ? `+${text}` : text;
}

const withUnit = (number: string, unit: Unit): string => (unit === '' ? number : `${number} ${unit}`);

/** A shown value (diagnosticValue) with its unit: «251 мс», «93 %», «−12,0 с», «+35 мс» (a difference of medians), «7». */
export function diagnosticValueText(id: DiagnosticRowId, v: number): string {
  const unit = UNITS[id];
  if (unit === 'с') return withUnit(secondsText(v, false), unit);
  return withUnit(SIGNED.has(id) ? signedMs(v) : String(v), unit);
}

/**
 * |Δ| < 2 % of |before| in exact integers (A-R20): seconds compare in tenths, as shown, because 0,02·35 in floating
 * point is above 0,7. Whole-unit rows are integers already.
 */
function underTwoPercent(unit: Unit, delta: number, before: number): boolean {
  const scale = unit === 'с' ? 10 : 1;
  return Math.round(Math.abs(delta) * scale) * 50 < Math.round(Math.abs(before) * scale);
}

/**
 * «−13 мс, лучше», «+2,0 с, хуже», «+1, лучше» or «без изменений» between two shown values (diagnosticValue). No
 * change: the difference rounds to 0 as shown (also from a previous 0, A-R3), is under 2 % of the previous value, or,
 * in milliseconds, under 5 ms (О8).
 */
export function diagnosticChange(id: DiagnosticRowId, now: number, before: number): string {
  const unit = UNITS[id];
  const delta = unit === 'с' ? round1(now - before) : whole(now - before);
  if (delta === 0 || underTwoPercent(unit, delta, before) || (unit === 'мс' && Math.abs(delta) < 5)) return 'без изменений';
  const better = HIGHER_IS_BETTER.has(id) ? delta > 0 : delta < 0;
  const value = withUnit(unit === 'с' ? secondsText(delta, true) : signedMs(delta), unit);
  return `${value}, ${better ? 'лучше' : 'хуже'}`;
}

/** The norm of a row graded by its shown value; ПЗМР and СЗМР by their mean RT instead (О7). */
const ROW_NORMS: Partial<Record<DiagnosticRowId, NormId>> = { gorbovV: 'gorbovSimple', gorbovP: 'gorbovAlternate', memory: 'memorySpan' };

/**
 * The reference band of a row: «по среднему 262 мс: средний» for ПЗМР and СЗМР (the norms are of the mean, О7),
 * the band alone for V, P and the span; null where there is no norm (Π included) or no value.
 */
export function diagnosticNorm(d: DiagnosticMetrics, id: DiagnosticRowId): string | null {
  if (id === 'pzmr' || id === 'szmr') {
    // The СЗМР norm is the 2-choice one: valid because the diagnostic plays СЗМР with 2 colours on 2 keys (isTwoChoice).
    const mean = id === 'pzmr' ? d.pzmrMeanRt : d.szmrMeanRt;
    if (mean === null) return null;
    const shown = whole(mean);
    return `по среднему ${String(shown)} мс: ${gradeByBands(shown, NORMS[id === 'pzmr' ? 'pzmrMean' : 'szmrMean']).label}`;
  }
  const norm = ROW_NORMS[id];
  const value = diagnosticValue(d, id);
  return norm === undefined || value === null ? null : gradeByBands(value, NORMS[norm]).label;
}

/** «−6 мс (раньше отметки)», «+4 мс (позже отметки)», «0 мс»: the РДО bias as shown, below 0 before the mark. */
function biasText(ms: number): string {
  const b = whole(ms);
  if (b === 0) return '0 мс';
  return `${signedMs(b)} мс (${b < 0 ? 'раньше' : 'позже'} отметки)`;
}

/**
 * «Подробности диагностики» under the results table (F7, Р20): the spread and the errors of ПЗМР, СЗМР, Go/No-Go and
 * РДО, ms whole. A module has a line only when every value of it is there: rows stored before F7 have none.
 */
export function diagnosticDetailLines(d: DiagnosticMetrics): string[] {
  const lines: string[] = [];
  const { pzmrSdRt, pzmrIqrRt, pzmrFalseStarts, szmrSdRt, szmrIqrRt, szmrFalseStarts, szmrWrong } = d;
  if (pzmrSdRt !== null && pzmrIqrRt !== null && pzmrFalseStarts !== null) {
    lines.push(`ПЗМР: разброс (SD) ${String(whole(pzmrSdRt))} мс, IQR ${String(whole(pzmrIqrRt))} мс, фальстарты ${String(pzmrFalseStarts)}`);
  }
  if (szmrSdRt !== null && szmrIqrRt !== null && szmrFalseStarts !== null && szmrWrong !== null) {
    lines.push(
      `СЗМР: разброс (SD) ${String(whole(szmrSdRt))} мс, IQR ${String(whole(szmrIqrRt))} мс, фальстарты ${String(szmrFalseStarts)}, неверная клавиша ${String(szmrWrong)}`,
    );
  }
  if (d.gonogoCommissions !== null && d.gonogoOmissions !== null) {
    lines.push(`Go/No-Go: нажатия на no-go ${String(d.gonogoCommissions)}, пропуски ${String(d.gonogoOmissions)}`);
  }
  if (d.rdoEarly !== null && d.rdoLate !== null && d.rdoSignedBiasMs !== null) {
    lines.push(`РДО: рано ${String(d.rdoEarly)}, поздно ${String(d.rdoLate)}, смещение ${biasText(d.rdoSignedBiasMs)}`);
  }
  return lines;
}
