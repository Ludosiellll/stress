import { useEffect, useState } from 'react';
import { moduleTitles } from '../../modules/registry';
import type { SessionPlan } from '../../engine/planner';
import type { Ability } from '../../engine/readiness';
import { useApp } from '../AppContext';
import { logEvent } from '../errorLog';
import { localDate } from '../format';
import { loadHomeModel, type HomeModel } from '../homeModel';

export interface HomeProps {
  onStart: (plan: SessionPlan) => void;
  onFree: () => void;
  onProgress: () => void;
  onSettings: () => void;
}

const ABILITIES: readonly (readonly [Ability, string])[] = [
  ['reaction', 'Реакция'],
  ['attention', 'Внимание'],
  ['switching', 'Переключение'],
  ['memory', 'Память'],
  ['logic', 'Логика'],
];

const INTERACTIVE = 'button, a, input, select, textarea, [role="radio"]';

function abilityText(ability: Ability, value: number | null): string {
  if (value !== null) return String(Math.round(value));
  return ability === 'memory' ? 'появится позже' : 'нет данных';
}

function Readiness({ model }: { model: HomeModel }) {
  const r = model.readiness;
  return (
    <section aria-labelledby="readiness-title">
      <h2 id="readiness-title">Индекс готовности</h2>
      {r === null ? (
        <p>Пройди диагностику, чтобы увидеть индекс</p>
      ) : (
        <>
          <dl className="readiness">
            {ABILITIES.map(([id, label]) => (
              <div key={id}>
                <dt>{label}</dt>
                <dd>{abilityText(id, r.abilities[id])}</dd>
              </div>
            ))}
          </dl>
          <p>Общий индекс: {r.overall === null ? 'нет данных' : Math.round(r.overall)}</p>
          <p className="muted">60 — уровень твоей первой диагностики. Таблица Горбова оценивается по опубликованным нормам.</p>
        </>
      )}
    </section>
  );
}

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

  return (
    <div className="home">
      <section aria-labelledby="today-title">
        <h2 id="today-title">Сегодня</h2>
        {model.diagnosticDue && (
          <div className="banner">
            <p>Пора пройти контрольную диагностику (раз в 2 недели)</p>
            <button type="button" onClick={() => { onStart(model.diagnosticPlan); }}>
              Пройти диагностику
            </button>
          </div>
        )}
        <ol aria-label="План на сегодня" className="plan">
          {model.plan.segments.map((s, i) => (
            <li key={i}>
              {moduleTitles[s.module]} — {s.budgetMs / 60_000} мин
            </li>
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
      <Readiness model={model} />
      <section aria-label="Серия и дата теста">
        <p>Серия: {model.streak} дн.</p>
        {model.daysToTest !== null && <p>До теста: {model.daysToTest} дн.</p>}
      </section>
    </div>
  );
}
