import { useEffect, useState } from 'react';
import type { SessionPlan } from '../../engine/planner';
import { useApp } from '../AppContext';
import { logEvent } from '../errorLog';
import { localDate, noBreakUnits } from '../format';
import { loadHomeModel, planLine, type HomeModel } from '../homeModel';
import ReadinessBlock from '../views/ReadinessBlock';

export interface HomeProps {
  onStart: (plan: SessionPlan) => void;
  onFree: () => void;
  onProgress: () => void;
  onSettings: () => void;
}

const INTERACTIVE = 'button, a, input, select, textarea, [role="radio"]';
const DIAGNOSTIC_DUE = 'Пора пройти контрольную диагностику (раз в 2 недели)';
const REHEARSAL_DUE = 'Генеральная репетиция: пройди контрольную диагностику (в подводке — 2 раза)';

export default function Home({ onStart, onFree, onProgress, onSettings }: HomeProps) {
  const { repo } = useApp();
  const [model, setModel] = useState<HomeModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState(() => localDate());
  const [attempt, setAttempt] = useState(0);

  // A window left open past midnight must plan for the new day when it is used again.
  useEffect(() => {
    const refresh = (): void => {
      if (!document.hidden) setToday(localDate());
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    let live = true;
    loadHomeModel(repo, today).then(
      (m) => {
        if (!live) return;
        setModel(m);
        setError(null);
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        void logEvent(repo, 'error', `Главная: не удалось загрузить данные: ${message}`, e instanceof Error ? (e.stack ?? '') : '');
        if (live) setError(message);
      },
    );
    return () => {
      live = false;
    };
  }, [repo, today, attempt]);

  const plan = model?.plan;
  useEffect(() => {
    if (plan === undefined) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.repeat || e.defaultPrevented) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // A focused button or field handles Enter itself.
      if (e.target instanceof Element && e.target.closest(INTERACTIVE) !== null) return;
      onStart(plan);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [plan, onStart]);

  if (error !== null && model === null) {
    return (
      <div>
        <p role="alert">Не удалось загрузить данные: {error}</p>
        <div className="actions">
          <button type="button" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>
            Повторить
          </button>
          <button type="button" onClick={onSettings}>
            Настройки
          </button>
        </div>
      </div>
    );
  }
  if (model === null) return <p>Загрузка…</p>;

  // The regular diagnostic comes first: the rehearsal banner shows only when that one is not due.
  const banner = model.diagnosticDue ? DIAGNOSTIC_DUE : model.rehearsalDue ? REHEARSAL_DUE : null;

  return (
    <div className="home">
      <section aria-labelledby="today-title">
        <h2 id="today-title">Сегодня</h2>
        {banner !== null && (
          <div className="banner">
            <p>{banner}</p>
            <button type="button" onClick={() => { onStart(model.diagnosticPlan); }}>
              Пройти диагностику
            </button>
          </div>
        )}
        <div className="phase">
          <p>
            <strong>{model.phaseTitle}</strong>
          </p>
          <p className="muted">{model.phaseWhy}</p>
          {model.hints.length > 0 && (
            <ul aria-label="Напоминания">
              {model.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
        </div>
        {model.layoutLine !== null && <p>{model.layoutLine}</p>}
        <ol aria-label="План на сегодня" className="plan">
          {model.plan.segments.map((s, i) => (
            <li key={i}>{noBreakUnits(planLine(s))}</li>
          ))}
        </ol>
        <div className="actions">
          <button type="button" className="primary" autoFocus onClick={() => { onStart(model.plan); }}>
            Начать тренировку
          </button>
          <button type="button" onClick={() => { onStart(model.diagnosticPlan); }}>
            Контрольная диагностика
          </button>
          <button type="button" onClick={onFree}>
            Свободная тренировка
          </button>
          <button type="button" onClick={onProgress}>
            Прогресс
          </button>
          <button type="button" onClick={onSettings}>
            Настройки
          </button>
        </div>
        <p className="muted">Enter — начать тренировку.</p>
      </section>
      <ReadinessBlock readiness={model.readiness} />
      <section aria-label="Серия и дата теста">
        <p>Серия: {model.streak} дн.</p>
        {model.testLine !== null && <p>{model.testLine}</p>}
      </section>
    </div>
  );
}
