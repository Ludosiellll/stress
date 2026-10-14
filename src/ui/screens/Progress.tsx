import { useEffect, useState } from 'react';
import { useApp } from '../AppContext';
import LineChart, { type ChartSeries } from '../charts/LineChart';
import { logEvent } from '../errorLog';
import { useKeyDown } from '../keys';
import { loadProgressModel, SESSION_LINES, type ProgressModel } from '../progressModel';
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
}) {
  const { title, note, yLabel, xLabel, lowerIsBetter, series, refLine } = props;
  return (
    <figure className="chart-card">
      <figcaption>
        <h3>{title}</h3>
        <span className="muted">{note}</span>
      </figcaption>
      <LineChart
        series={series}
        yLabel={yLabel}
        {...(xLabel === undefined ? {} : { xLabel })}
        {...(lowerIsBetter === undefined ? {} : { lowerIsBetter })}
        {...(refLine === undefined ? {} : { refLine })}
      />
    </figure>
  );
}

function Diagnostics({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="diagnostics-title">
      <h2 id="diagnostics-title">Контрольные диагностики</h2>
      <p className="muted">По одной точке на диагностику. Если показателя в диагностике не было, на графике пропуск.</p>
      <div className="chart-grid">
        {model.diagnostics.map((c) => (
          <ChartCard
            key={c.id}
            title={c.title}
            note={c.lowerIsBetter ? 'меньше — лучше' : 'больше — лучше'}
            yLabel={c.yLabel}
            lowerIsBetter={c.lowerIsBetter}
            series={c.series}
          />
        ))}
      </div>
      <p className="muted">V — среднее время первых двух таблиц, P — время третьей, Π — разница между третьей и суммой первых двух.</p>
    </section>
  );
}

function Levels({ model }: { model: ProgressModel }) {
  return (
    <section aria-labelledby="levels-title">
      <h2 id="levels-title">Уровни по модулям</h2>
      <p className="muted">Уровень на конец каждой сессии. Пунктир — уровень, при котором модуль примерно соответствует формату теста.</p>
      <div className="chart-grid">
        {model.levels.map((l) => (
          <ChartCard
            key={l.module}
            title={l.title}
            note="больше — лучше"
            yLabel="уровень"
            xLabel="номер сессии"
            lowerIsBetter={false}
            series={l.series}
            {...(l.series.some((s) => s.points.length > 0) ? { refLine: { y: l.norm, label: '≈ формат теста' } } : {})}
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
          <Diagnostics model={model} />
          <Levels model={model} />
          <History model={model} />
        </>
      )}
    </section>
  );
}
