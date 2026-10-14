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
}

const W = 420;
const H = 230;
const TOP = 24;
const RIGHT = 14;
const X_PAD = 10;
const MAX_X_LABELS = 8;
const MAX_SERIES = 3;

/** Axis ticks on 1, 2, 5 × 10^k, at least three of them, covering [min, max]. */
export function niceTicks(min: number, max: number): number[] {
  let lo = min;
  let hi = max;
  if (!(hi > lo)) {
    const pad = Math.max(1, Math.abs(lo) * 0.1);
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const ticks: number[] = [];
  for (let k = first; k <= last; k += 1) ticks.push(Number((k * step).toFixed(10)));
  return ticks;
}

/** Whole numbers as they are, others with one decimal digit and a comma. */
function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : decimal(v, 1);
}

function tickText(v: number, step: number): string {
  if (step >= 1) return String(v);
  return decimal(v, step >= 0.1 ? 1 : 2);
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

export default function LineChart({ series, yLabel, xLabel, lowerIsBetter, refLine }: LineChartProps) {
  const drawn = series.slice(0, MAX_SERIES);
  const values = drawn.flatMap((s) => s.points.flatMap((p) => (p.y === null ? [] : [p.y])));
  if (values.length === 0) return <p className="chart-empty muted">Нет данных</p>;

  const widest = drawn.reduce((a, b) => (b.points.length > a.points.length ? b : a));
  const slots = widest.points.length;
  const xLabels = widest.points.map((p) => p.x);

  const scale = refLine === undefined ? values : [...values, refLine.y];
  const ticks = niceTicks(Math.min(...scale), Math.max(...scale));
  const lo = ticks[0] as number;
  const hi = ticks[ticks.length - 1] as number;
  const step = (ticks[1] as number) - lo;
  const tickStrings = ticks.map((t) => tickText(t, step));

  const left = Math.max(...tickStrings.map((t) => t.length)) * 6.6 + 14;
  const bottom = xLabel === undefined ? 26 : 42;
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
  const refBelow = refLine !== undefined && refY - 6 < TOP + 8;

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
        <text className="axis-label" x={0} y={12}>
          {yLabel}
        </text>
        {ticks.map((t, i) => (
          <g key={t}>
            <line className="grid" x1={left} x2={W - RIGHT} y1={yAt(t)} y2={yAt(t)} />
            <text className="y-tick" x={left - 6} y={yAt(t) + 4} textAnchor="end">
              {tickStrings[i]}
            </text>
          </g>
        ))}
        {xLabels.map((x, i) =>
          (slots - 1 - i) % stride === 0 ? (
            <text key={i} className="x-tick" x={xAt(i)} y={TOP + plotH + 16} textAnchor="middle">
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
            <text className="ref-label" x={W - RIGHT - 2} y={refBelow ? refY + 14 : refY - 6} textAnchor="end">
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
