import { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import LineChart, { type ChartDomain, type ChartSeries } from '../charts/LineChart';
import { logEvent } from '../errorLog';
import { decimal, noBreakUnits } from '../format';
import { useKeyDown } from '../keys';
import {
  loadProgressModel,
  SESSION_LINES,
  type ChartSpec,
  type OverloadMean,
  type ProgressModel,
  type TestFormatProgress,
  type TrendView,
} from '../progressModel';
import ReadinessBlock from '../views/ReadinessBlock';

export interface ProgressProps {
  onBack: () => void;
}

function ChartCard(props: {
  title: string;
  note: string;
  yLabel: string;
  xLabel?: string;
  lowerIsBetter?: boolean;
  series: ChartSeries[];
  refLine?: { y: number; label: string };
  marker?: { x: string; label: string; refYBefore?: number };
  /** x labels of values measured with dropped frames, listed under the chart. */
  unreliable?: readonly string[];
  /** A line under the chart. */
  footnote?: string;
  domain: ChartDomain;
  whole?: boolean;
  /** The trend of each series (F7): its noise band on the chart, its line under it. */
  trends?: readonly TrendView[];
}) {
  const { title, note, yLabel, xLabel, lowerIsBetter, series, refLine, marker, unreliable = [], footnote, domain, whole = false, trends } = props;
  // Under a chart with values; series that are all short say so once.
  const hasValues = series.some((s) => s.points.some((p) => p.y !== null));
  const trendLines = trends === undefined || !hasValues ? [] : [...new Set(trends.map((t) => t.text))];
  return (
    <figure className="chart-card">
      <figcaption>
        <h3>{title}</h3>
        <span className="muted">{note}</span>
      </figcaption>
      <LineChart
        series={series}
        yLabel={yLabel}
        domain={domain}
        whole={whole}
        {...(xLabel === undefined ? {} : { xLabel })}
        {...(lowerIsBetter === undefined ? {} : { lowerIsBetter })}
        {...(refLine === undefined ? {} : { refLine })}
        {...(marker === undefined ? {} : { marker })}
        {...(trends === undefined ? {} : { bands: trends.map((t) => t.band) })}
      />
      {trendLines.map((line) => (
        <p key={line} className="chart-note chart-trend">
          {noBreakUnits(line)}
        </p>
      ))}
      {unreliable.length > 0 && <p className="muted chart-note">Замер ненадёжен (пропуски кадров): {unreliable.join(', ')}</p>}
      {footnote !== undefined && <p className="muted chart-note">{footnote}</p>}
    </figure>
  );
}

function Assessment({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="assessment-title">
      <h2 id="assessment-title">Оценка по модулям</h2>
      <table className="results" aria-labelledby="assessment-title">
        <thead>
          <tr>
            <th scope="col">Модуль</th>
            <th scope="col">Ступень</th>
            <th scope="col" className="num">
              Последний / лучший за 30 дней
            </th>
            <th scope="col">Ориентир</th>
            <th scope="col">Цель</th>
          </tr>
        </thead>
        <tbody>
          {model.assessment.map((a) => (
            <tr key={a.module}>
              <td>{a.title}</td>
              <td>{noBreakUnits(a.step)}</td>
              <td className="num nowrap">{noBreakUnits(a.lastBest)}</td>
              <td>{noBreakUnits(a.norm)}</td>
              <td>{noBreakUnits(a.goal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Ступень — по сохранённому уровню. Ориентир — опубликованные нормы, ориентировочно; источники — в руководстве.</p>
    </section>
  );
}

function FormOfDay({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="form-of-day-title">
      <h2 id="form-of-day-title">Форма дня</h2>
      <div className="chart-grid">
        <ChartCard
          title="Разминка ПЗМР: медиана по дням, мс"
          note="меньше — лучше"
          yLabel="мс"
          lowerIsBetter
          series={[{ name: 'Разминка ПЗМР', points: model.formOfDay }]}
          domain={{ min: 0 }}
          whole
          trends={[model.formOfDayTrend]}
        />
      </div>
    </section>
  );
}

/** A value of «Лучшие результаты»: whole ms, or a dash. */
const msCell = (v: number | null): string => (v === null ? '—' : noBreakUnits(`${String(Math.round(v))} мс`));

/** The two charts of a format: its mean (РДО: the deviation) and its SD by run, x «дд.мм». */
function TestFormatCharts({ f }: { f: TestFormatProgress }) {
  const charts = [
    { title: f.format === 'rdo' ? `${f.name}: отклонение, мс` : `${f.name}: среднее, мс`, points: f.mean, trend: f.trends.mean },
    { title: `${f.name}: SD, мс`, points: f.sd, trend: f.trends.sd },
  ];
  return (
    <>
      {charts.map((c) => (
        <ChartCard
          key={c.title}
          title={c.title}
          note="меньше — лучше"
          yLabel="мс"
          lowerIsBetter
          series={[{ name: f.name, points: c.points }]}
          domain={{ min: 0 }}
          whole
          trends={[c.trend]}
        />
      ))}
    </>
  );
}

/** «Прогоны в формате теста» (F4): two charts per format with runs, then the best results. */
function TestFormats({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="test-format-title">
      <h2 id="test-format-title">Прогоны в формате теста</h2>
      {model.testFormats.length === 0 ? (
        <p>Прогонов пока не было. Они начнутся с 15-го дня.</p>
      ) : (
        <>
          <div className="chart-grid">
            {model.testFormats.map((f) => (
              <TestFormatCharts key={f.format} f={f} />
            ))}
          </div>
          <h3 id="test-format-best-title">Лучшие результаты</h3>
          <table className="results" aria-labelledby="test-format-best-title">
            <thead>
              <tr>
                <th scope="col">Формат</th>
                <th scope="col" className="num">
                  Среднее
                </th>
                <th scope="col" className="num">
                  SD
                </th>
                <th scope="col" className="num">
                  Ошибки
                </th>
                <th scope="col" className="num">
                  Фальстарты
                </th>
                <th scope="col" className="num">
                  Прогонов
                </th>
              </tr>
            </thead>
            <tbody>
              {model.testFormats.map((f) => (
                <tr key={f.format}>
                  <td>{f.name}</td>
                  <td className="num nowrap">{msCell(f.best.mean)}</td>
                  <td className="num nowrap">{msCell(f.best.sd)}</td>
                  <td className="num">{f.best.errors}</td>
                  <td className="num">{f.best.falseStarts}</td>
                  <td className="num">{f.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {model.testFormats.some((f) => f.format === 'rdo') && <p className="muted">У РДО в колонке «Среднее» — среднее отклонение от отметки.</p>}
        </>
      )}
    </section>
  );
}

function Diagnostics({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title">Контрольные диагностики</h2>
      <p className="muted">По одной точке на диагностику. Если показателя в диагностике не было, на графике пропуск.</p>
      <div className="chart-grid">
        {[model.indexChart, ...model.diagnostics].map((c: ChartSpec) => (
          <ChartCard
            key={c.id}
            title={c.title}
            note={c.lowerIsBetter ? 'меньше — лучше' : 'больше — лучше'}
            yLabel={c.yLabel}
            lowerIsBetter={c.lowerIsBetter}
            series={c.series}
            unreliable={c.unreliable}
            domain={c.domain}
            whole={c.whole}
            trends={c.trends}
          />
        ))}
      </div>
      <p className="muted">V — среднее время первых двух таблиц, P — время третьей, Π — разница между третьей и суммой первых двух.</p>
    </section>
  );
}

const MARKER_LABEL = '0.3.0: уровень — это нагрузка';
const MARKER_NOTE = 'До черты уровень — окно ответа по старым правилам, после — полосы нагрузки';

/** «Средний балл блоков перегрузки за 28 дней: 0,74 (блоков: 2)» (F3). */
function overloadLine(o: OverloadMean | null): string {
  return o === null ? 'Блоков перегрузки за 28 дней не было.' : `Средний балл блоков перегрузки за 28 дней: ${decimal(o.mean, 2)} (блоков: ${String(o.blocks)})`;
}

function Levels({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="levels-title">
      <h2 id="levels-title">Уровни по модулям</h2>
      <p className="muted">Уровень на конец каждой сессии. Пунктир — уровень, при котором модуль примерно соответствует формату теста.</p>
      <p>{overloadLine(model.overload28d)}</p>
      <div className="chart-grid">
        {model.levels.map((l) => (
          <ChartCard
            key={l.module}
            title={l.title}
            note="больше — лучше"
            yLabel="уровень"
            xLabel="сессия с этим модулем"
            lowerIsBetter={false}
            series={l.series}
            domain={{ min: 0 }}
            {...(l.series.some((s) => s.points.length > 0) ? { refLine: { y: l.norm, label: '≈ формат теста' } } : {})}
            {...(l.marker === null ? {} : { marker: { x: l.marker.x, label: MARKER_LABEL, refYBefore: l.marker.normBefore }, footnote: MARKER_NOTE })}
          />
        ))}
      </div>
    </section>
  );
}

function History({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="history-title">
      <h2 id="history-title">История сессий</h2>
      {model.sessions.length === 0 ? (
        <p>Сессий пока нет</p>
      ) : (
        <>
          <table className="results sessions" aria-labelledby="history-title">
            <thead>
              <tr>
                <th scope="col">Дата</th>
                <th scope="col">Тип</th>
                <th scope="col">Длительность</th>
                <th scope="col">Блоков</th>
              </tr>
            </thead>
            <tbody>
              {model.sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.date}</td>
                  <td>{s.type}</td>
                  <td>{s.duration}</td>
                  <td>{s.blocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {model.sessionCount > SESSION_LINES && (
            <p className="muted">
              Показаны последние {SESSION_LINES} из {model.sessionCount}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default function Progress({ onBack }: ProgressProps) {
  const { repo } = useApp();
  const [model, setModel] = useState<ProgressModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useKeyDown((e) => {
    if (e.key === 'Escape') onBack();
  });

  useEffect(() => {
    let live = true;
    loadProgressModel(repo).then(
      (m) => {
        if (!live) return;
        setModel(m);
        setError(null);
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        void logEvent(repo, 'error', `Прогресс: не удалось загрузить данные: ${message}`, e instanceof Error ? (e.stack ?? '') : '');
        if (live) setError(message);
      },
    );
    return () => {
      live = false;
    };
  }, [repo, attempt]);

  return (
    <section aria-label="Прогресс" className="progress">
      <h2>Прогресс</h2>
      <div className="actions">
        <button type="button" onClick={onBack}>
          Назад
        </button>
      </div>
      {error !== null && model === null ? (
        <>
          <p role="alert">Не удалось загрузить данные: {error}</p>
          <div className="actions">
            <button type="button" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>
              Повторить
            </button>
          </div>
        </>
      ) : model === null ? (
        <p>Загрузка…</p>
      ) : (
        <>
          <ReadinessBlock readiness={model.readiness} />
          <Assessment model={model} />
          <FormOfDay model={model} />
          <TestFormats model={model} />
          <Diagnostics model={model} />
          <Levels model={model} />
          <History model={model} />
        </>
      )}
    </section>
  );
}
