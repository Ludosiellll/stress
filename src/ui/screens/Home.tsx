import { useEffect, useState } from 'react';
import { moduleTitles } from '../../modules/registry';
import type { SessionPlan } from '../../engine/planner';
import type { Ability } from '../../engine/readiness';
import { useApp } from '../AppContext';
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
          <p className="muted">
            Баллы от 0 до 100. По реакции и логике 60 баллов — уровень первой диагностики. Таблицы Горбова оцениваются по
            опубликованным нормам, они ориентировочные.
          </p>
        </>
      )}
    </section>
  );
}

export default function Home({ onStart, onFree, onProgress, onSettings }: HomeProps) {
  const { repo } = useApp();
  const [model, setModel] = useState<HomeModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadHomeModel(repo, localDate()).then(
      (m) => {
        if (live) setModel(m);
      },
      (e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [repo]);

  const plan = model?.plan;
  useEffect(() => {
    if (plan === undefined) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.repeat) return;
      // A focused button or field handles Enter itself.
      if (e.target instanceof Element && e.target.closest(INTERACTIVE) !== null) return;
      onStart(plan);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [plan, onStart]);

  if (error !== null) return <p role="alert">Не удалось загрузить данные: {error}</p>;
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
