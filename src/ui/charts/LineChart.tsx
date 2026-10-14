import { decimal } from '../format';

export interface ChartPoint {
  x: string;
  /** null = no value at this x: the line breaks there and no point is drawn. */
  y: number | null;
  /** Said after the value in the point's title, e.g. «замер ненадёжен». */
  note?: string;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

export interface LineChartProps {
  /** At most three series (colour slots --series-1..3). Series share one y axis and the x slots of the first series. */
  series: ChartSeries[];
  /** Unit or quantity of the y axis, drawn above the axis. */
  yLabel: string;
  /** Drawn under the x axis when given. */
  xLabel?: string;
  /** Only said in the text alternative; the chart itself does not colour good or bad. */
  lowerIsBetter?: boolean;
  /** Horizontal dashed reference line; the y scale always reaches it. */
  refLine?: { y: number; label: string };
  /** Values the metric can take (e.g. min 0 for times, 0..100 for percent): the axis never goes past them. */
  domain?: ChartDomain;
}

export interface ChartDomain {
  min?: number;
  max?: number;
}

/** viewBox width. Text sizes in theme.css are in these units; theme.test checks they render at ≥ 12 px. */
export const CHART_VIEWBOX_WIDTH = 420;
const W = CHART_VIEWBOX_WIDTH;
const H = 240;
const TOP = 26;
const RIGHT = 14;
const X_PAD = 10;
const MAX_X_LABELS = 8;
const MAX_SERIES = 3;
/** Width of one tick-label character in viewBox units at the chart font size (15). */
const CHAR_W = 9;

/** Axis values are clamped to this magnitude, so ranges, steps and tick indices stay exactly representable. */
const AXIS_LIMIT = 1e9;
/** A tick grid of more cells than this (or with indices beyond 2^50) is not a grid the loop can walk safely. */
const MAX_GRID_CELLS = 50;
const MAX_GRID_INDEX = 2 ** 50;
/** Below this the tick labels could not tell neighbours apart (and toFixed would merge them). */
const MIN_GRID_STEP = 1e-9;

interface Grid {
  step: number;
  digits: number;
  first: number;
  last: number;
}

/** 1, 2, 5 × 10^k grid over [lo, hi], or null when the range is flat, non-finite or too fine for its magnitude. */
function gridFor(lo: number, hi: number): Grid | null {
  const raw = (hi - lo) / 5;
  if (!(raw > 0) || !Number.isFinite(raw)) return null;
  const exponent = Math.floor(Math.log10(raw));
  const mag = 10 ** exponent;
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  // Round to the digits the step has, not to a fixed ten: at 1e6 a fixed ten leaves noise above the data.
  const digits = Math.min(100, Math.max(0, -exponent));
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const sane = Number.isFinite(step) && step >= MIN_GRID_STEP && Math.abs(first) < MAX_GRID_INDEX && Math.abs(last) < MAX_GRID_INDEX;
  return sane && last - first <= MAX_GRID_CELLS ? { step, digits, first, last } : null;
}

/** Ticks of the grid over [lo, hi] inside [floor, ceiling]; a finite bound closes an axis the grid does not reach. */
function gridTicks(lo: number, hi: number, floor: number, ceiling: number): number[] {
  const grid = gridFor(lo, hi);
  if (grid === null) return [];
  const { step, digits, first, last } = grid;
  const ticks: number[] = [];
  for (let k = first; k <= last; k += 1) {
    const t = Number((k * step).toFixed(digits)) + 0; // + 0 turns −0 into 0
    if (t >= floor && t <= ceiling) ticks.push(t);
  }
  // A finite domain bound that is not a multiple of the step closes the axis itself, so the data stay covered.
  // A tick within rounding noise of the data already covers them: the bound would only be infinite or a sliver.
  const tolerance = 1e-9 * step;
  if (Number.isFinite(floor) && (ticks[0] ?? Infinity) - lo > tolerance) ticks.unshift(floor);
  if (Number.isFinite(ceiling) && hi - (ticks.at(-1) ?? -Infinity) > tolerance) ticks.push(ceiling);
  return ticks;
}

function usable(ticks: number[]): boolean {
  return ticks.length >= 2 && ticks.every((t, i) => Number.isFinite(t) && (i === 0 || t > (ticks[i - 1] as number)));
}

/**
 * Axis ticks on 1, 2, 5 × 10^k, at least three of them, covering [min, max]. A flat range is padded, the
 * padding never crossing the domain bounds; ticks stay inside the domain. Total: it terminates and returns at
 * least two finite, strictly increasing ticks for any input. Non-finite values are dropped, swapped bounds are
 * reordered, a domain that is zero-width, inverted or does not contain the data is ignored, and a range too fine
 * for its magnitude is replaced by mid ± 1.
 */
export function niceTicks(min: number, max: number, domain: ChartDomain = {}): number[] {
  const finite = [min, max].filter(Number.isFinite);
  const clamp = (v: number): number => Math.max(-AXIS_LIMIT, Math.min(AXIS_LIMIT, v));
  const dataLo = clamp(finite.length === 0 ? 0 : Math.min(...finite));
  const dataHi = clamp(finite.length === 0 ? 0 : Math.max(...finite));
  let floor = Number.isFinite(domain.min) ? (domain.min as number) : -Infinity;
  let ceiling = Number.isFinite(domain.max) ? (domain.max as number) : Infinity;
  if (!(floor < ceiling) || floor > dataLo || ceiling < dataHi) {
    floor = -Infinity;
    ceiling = Infinity;
  }
  let lo = dataLo;
  let hi = dataHi;
  if (!(hi > lo)) {
    const pad = Math.max(1, Math.abs(lo) * 0.1);
    lo = Math.max(floor, lo - pad);
    hi = Math.min(ceiling, hi + pad);
  }
  const ticks = gridTicks(lo, hi, floor, ceiling);
  if (usable(ticks)) return ticks;
  const mid = (dataLo + dataHi) / 2; // |mid| <= AXIS_LIMIT, so mid ± 1 are distinct finite numbers
  return [mid - 1, mid + 1];
}

/** U+2212 instead of the hyphen, as everywhere else in the UI. */
const minus = (text: string): string => text.replace('-', '−');

/** One decimal digit with a comma, whole numbers without it; never «−0». */
function fmt(v: number): string {
  const n = Number(v.toFixed(1)) + 0;
  return minus(Number.isInteger(n) ? String(n) : decimal(n, 1));
}

function tickText(v: number, step: number): string {
  if (step >= 1) return minus(String(v));
  return minus(decimal(v, step >= 0.1 ? 1 : 2));
}

/** «№2: 300», «№2: 40 (V)», «№2: 300 (замер ненадёжен)». */
function pointTitle(x: string, value: string, series: string | null, note: string | undefined): string {
  const extra = [series, note].filter((t): t is string => t !== null && t !== undefined);
  return extra.length === 0 ? `${x}: ${value}` : `${x}: ${value} (${extra.join(', ')})`;
}

function ends(s: ChartSeries): { first: ChartPoint & { y: number }; last: ChartPoint & { y: number } } | null {
  const real = s.points.filter((p): p is ChartPoint & { y: number } => p.y !== null);
  const first = real[0];
  const last = real[real.length - 1];
  return first === undefined || last === undefined ? null : { first, last };
}

function summary(s: ChartSeries): string | null {
  const e = ends(s);
  if (e === null) return null;
  return e.first === e.last ? `${fmt(e.first.y)} (${e.first.x})` : `${fmt(e.first.y)} (${e.first.x}) → ${fmt(e.last.y)} (${e.last.x})`;
}

export default function LineChart({ series, yLabel, xLabel, lowerIsBetter, refLine, domain }: LineChartProps) {
  const drawn = series.slice(0, MAX_SERIES);
  const values = drawn.flatMap((s) => s.points.flatMap((p) => (p.y === null ? [] : [p.y])));
  if (values.length === 0) return <p className="chart-empty muted">Нет данных</p>;

  const widest = drawn.reduce((a, b) => (b.points.length > a.points.length ? b : a));
  const slots = widest.points.length;
  const xLabels = widest.points.map((p) => p.x);

  const scale = refLine === undefined ? values : [...values, refLine.y];
  const ticks = niceTicks(Math.min(...scale), Math.max(...scale), domain);
  const lo = ticks[0] as number;
  const hi = ticks[ticks.length - 1] as number;
  const step = (ticks[1] as number) - lo;
  const tickStrings = ticks.map((t) => tickText(t, step));

  const left = Math.max(...tickStrings.map((t) => t.length)) * CHAR_W + 14;
  const bottom = xLabel === undefined ? 30 : 50;
  const plotW = W - left - RIGHT;
  const plotH = H - TOP - bottom;
  const xAt = (i: number): number => (slots === 1 ? left + plotW / 2 : left + X_PAD + (i * (plotW - 2 * X_PAD)) / (slots - 1));
  const yAt = (v: number): number => TOP + (1 - (v - lo) / (hi - lo)) * plotH;

  const stride = Math.ceil(slots / MAX_X_LABELS);
  const radius = slots > 40 ? 2.5 : 4;
  const multi = drawn.length > 1;
  const summaries = drawn.map(summary);

  const label = [
    yLabel,
    ...drawn.flatMap((s) => {
      const e = ends(s);
      if (e === null) return [];
      const range = e.first === e.last ? `${e.first.x}: ${fmt(e.first.y)}` : `${e.first.x}: ${fmt(e.first.y)}, ${e.last.x}: ${fmt(e.last.y)}`;
      return [multi ? `${s.name}, ${range}` : range];
    }),
    ...(lowerIsBetter === undefined ? [] : [lowerIsBetter ? 'меньше — лучше' : 'больше — лучше']),
  ].join('. ');

  const refY = refLine === undefined ? 0 : yAt(refLine.y);
  const refBelow = refLine !== undefined && refY - 6 < TOP + 10;

  return (
    <div className="chart">
      {multi && (
        <ul className="chart-legend" aria-hidden="true">
          {drawn.map((s, i) => (
            <li key={s.name}>
              <span className={`swatch s${String(i + 1)}`} />
              {s.name}
              {summaries[i] === null ? '' : `: ${summaries[i] as string}`}
            </li>
          ))}
        </ul>
      )}
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} width="100%" role="img" aria-label={label}>
        <text className="axis-label" x={0} y={15}>
          {yLabel}
        </text>
        {ticks.map((t, i) => (
          <g key={t}>
            <line className="grid" x1={left} x2={W - RIGHT} y1={yAt(t)} y2={yAt(t)} />
            <text className="y-tick" x={left - 6} y={yAt(t) + 5} textAnchor="end">
              {tickStrings[i]}
            </text>
          </g>
        ))}
        {xLabels.map((x, i) =>
          (slots - 1 - i) % stride === 0 ? (
            <text key={i} className="x-tick" x={xAt(i)} y={TOP + plotH + 19} textAnchor="middle">
              {x}
            </text>
          ) : null,
        )}
        {xLabel !== undefined && (
          <text className="axis-label" x={left + plotW / 2} y={H - 4} textAnchor="middle">
            {xLabel}
          </text>
        )}
        {refLine !== undefined && (
          <>
            <line className="chart-ref" x1={left} x2={W - RIGHT} y1={refY} y2={refY} strokeDasharray="6 4" />
            <text className="ref-label" x={W - RIGHT - 2} y={refBelow ? refY + 17 : refY - 6} textAnchor="end">
              {refLine.label}
            </text>
          </>
        )}
        {drawn.map((s, si) => {
          let d = '';
          let open = false;
          s.points.forEach((p, i) => {
            if (p.y === null) {
              open = false;
              return;
            }
            d += `${open ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.y).toFixed(1)}`;
            open = true;
          });
          return (
            <g key={s.name} className={`s${String(si + 1)}`}>
              <path className="chart-line" d={d} fill="none" />
              {s.points.map((p, i) =>
                p.y === null ? null : (
                  <circle key={i} className={slots > 40 ? 'chart-point dense' : 'chart-point'} cx={xAt(i)} cy={yAt(p.y)} r={radius}>
                    <title>{pointTitle(p.x, fmt(p.y), multi ? s.name : null, p.note)}</title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
      </svg>
      {!multi && summaries[0] !== null && (
        <p className="chart-summary" aria-hidden="true">
          {summaries[0]}
        </p>
      )}
    </div>
  );
}
