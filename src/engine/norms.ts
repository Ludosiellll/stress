/** Published norms as bands (assessment spec §2.2). Pure data plus two helpers. */

/** A keyboard adds about 30 ms over the hardware button the RT norms were taken with. */
export const KEYBOARD_OFFSET_MS = 30;

export type NormId = 'pzmrMean' | 'pzmrSd' | 'szmrMean' | 'gorbovSimple' | 'gorbovAlternate' | 'memorySpan';

export interface NormCut {
  at: number;
  inclusive: boolean;
}

export interface NormTable {
  better: 'lower' | 'higher';
  /** Bands 5, 4, 3, 2 end at these cuts; the rest is band 1 (Справочник «Нормы»). */
  cuts: readonly [NormCut, NormCut, NormCut, NormCut];
  unit: 'мс' | 'с' | '';
  /** «среднее», «разброс (SD)», «объём»; null: the value speaks for itself. */
  metric: string | null;
  rating: 'A' | 'C/B';
  note: string;
}

type Cuts = NormTable['cuts'];

function cut(at: number, inclusive: boolean): NormCut {
  return Object.freeze({ at, inclusive });
}

/** Percentile table P10/P25/P75/P90: the outer bands are strict, the middle one is closed. */
function percentiles(p10: number, p25: number, p75: number, p90: number): Cuts {
  return Object.freeze([cut(p10, false), cut(p25, false), cut(p75, true), cut(p90, true)] as const);
}

/** A whole-number scale with every bound inclusive. */
function inclusive(a: number, b: number, c: number, d: number): Cuts {
  return Object.freeze([cut(a, true), cut(b, true), cut(c, true), cut(d, true)] as const);
}

const k = KEYBOARD_OFFSET_MS;
const GORBOV_NOTE = 'Бумажная методика, источник не указан';

export const NORMS: Readonly<Record<NormId, NormTable>> = Object.freeze({
  pzmrMean: Object.freeze({
    better: 'lower',
    cuts: percentiles(195 + k, 204 + k, 237 + k, 247 + k),
    unit: 'мс',
    metric: 'среднее',
    rating: 'A',
    note: 'Мальцев 2026, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
  }),
  pzmrSd: Object.freeze({
    better: 'lower',
    cuts: percentiles(37, 45, 68, 87),
    unit: 'мс',
    metric: 'разброс (SD)',
    rating: 'A',
    note: 'Мальцев 2026, юноши 18–21, аппаратная кнопка',
  }),
  szmrMean: Object.freeze({
    better: 'lower',
    cuts: percentiles(296 + k, 312 + k, 352 + k, 382 + k),
    unit: 'мс',
    metric: 'среднее',
    rating: 'A',
    note: 'Мальцев 2026, выбор из 2, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
  }),
  gorbovSimple: Object.freeze({
    better: 'lower',
    cuts: inclusive(29, 37, 50, 60),
    unit: 'с',
    metric: null,
    rating: 'C/B',
    note: GORBOV_NOTE,
  }),
  gorbovAlternate: Object.freeze({
    better: 'lower',
    cuts: inclusive(130, 170, 260, 320),
    unit: 'с',
    metric: null,
    rating: 'C/B',
    note: GORBOV_NOTE,
  }),
  memorySpan: Object.freeze({
    better: 'higher',
    cuts: inclusive(9, 8, 7, 6),
    unit: '',
    metric: 'объём',
    rating: 'A',
    note: 'Woods 2011, молодые взрослые, слуховое предъявление',
  }),
});

export const BAND_LABELS = Object.freeze(['низкий', 'ниже среднего', 'средний', 'выше среднего', 'высокий'] as const);

export type Band = 1 | 2 | 3 | 4 | 5;

/** Band 5 has no better band; below it, the next band and its bound (not the distance to it). */
export type Grade =
  | { band: 5; label: string; nextLabel: null; toNext: null }
  | { band: Exclude<Band, 5>; label: string; nextLabel: string; toNext: NormCut };

function passes(value: number, c: NormCut, better: NormTable['better']): boolean {
  if (better === 'lower') return c.inclusive ? value <= c.at : value < c.at;
  return c.inclusive ? value >= c.at : value > c.at;
}

/** The band of `value`; the caller rounds it as shown first. */
export function gradeByBands(value: number, table: NormTable): Grade {
  if (!Number.isFinite(value)) throw new RangeError(`gradeByBands: value ${String(value)} is not a finite number`);
  const passed = table.cuts.findIndex((c) => passes(value, c, table.better));
  const band = (passed === -1 ? 1 : 5 - passed) as Band;
  const label = BAND_LABELS[(band - 1) as 0 | 1 | 2 | 3 | 4];
  if (band === 5) return { band, label, nextLabel: null, toNext: null };
  return { band, label, nextLabel: BAND_LABELS[band], toNext: table.cuts[(4 - band) as 0 | 1 | 2 | 3] };
}

/** «до 37 с», «меньше 234 мс», «от 8», «больше 8». */
export function cutText(c: NormCut, table: NormTable): string {
  const word = table.better === 'lower' ? (c.inclusive ? 'до' : 'меньше') : c.inclusive ? 'от' : 'больше';
  const unit = table.unit === '' ? '' : ` ${table.unit}`;
  return `${word} ${String(c.at).replace('.', ',')}${unit}`;
}

/** One-line hints where there are no bands (Справочник «Нормы», подсказки). */
export const NORM_HINTS: Readonly<{ gonogo: string; stroop: string; taskswitch: string; schulte5: string }> =
  Object.freeze({
    gonogo: 'Ориентир: ошибки на no-go у студентов 7–21 % при 30 % no-go, в зависимости от темпа (Hasegawa 2020).',
    stroop:
      'Ориентир: интерференция у молодых взрослых обычно 60–90 мс; меньше 40 — выше среднего, больше 150 — ниже среднего (Rouder 2023, клавиатура).',
    taskswitch: 'Ориентир: цена переключения при короткой подсказке обычно около 60 ± 70 мс (Stasenko 2017).',
    schulte5: 'Ориентир: для Шульте 5×5 традиционная норма взрослых на бумаге 40–50 с, хороший результат 25–30 с.',
  });
