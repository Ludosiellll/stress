import { useEffect, useState } from 'react';
import type { PhaseInfo } from '../../engine/phases';
import { planFree, type SessionPlan } from '../../engine/planner';
import { hashString } from '../../engine/rng';
import { MODULE_IDS, type ModuleId } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import { useApp } from '../AppContext';
import { phaseOfDay } from '../homeModel';
import { logEvent } from '../errorLog';
import { localDate } from '../format';
import { useKeyDown } from '../keys';

export interface FreeProps {
  onStart: (plan: SessionPlan) => void;
  onBack: () => void;
}

/** What a free plan needs: the number of sessions (its seed) and the phase of the day (its marks, F15). */
interface FreeContext {
  sessions: number;
  phase: PhaseInfo;
}

/**
 * Free training: one module for 5 minutes. The seed changes with every session started; the marks after a trial follow
 * the phase of the day, as Home computes it (F15, Р10).
 */
export default function Free({ onStart, onBack }: FreeProps) {
  const { repo } = useApp();
  const [context, setContext] = useState<FreeContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([repo.getModuleStates(), repo.listSessions(), repo.getSettings()]).then(
      ([states, list, settings]) => {
        const phase = phaseOfDay(states, list, settings, localDate());
        if (live) setContext({ sessions: list.length, phase });
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        void logEvent(repo, 'error', `Свободная тренировка: ${message}`);
        if (live) setError(message);
      },
    );
    return () => {
      live = false;
    };
  }, [repo]);

  useKeyDown((e) => {
    if (e.key === 'Escape') onBack();
  });

  if (error !== null) {
    return (
      <section aria-label="Свободная тренировка">
        <p role="alert">Не удалось загрузить данные: {error}</p>
        <div className="actions">
          <button type="button" autoFocus onClick={onBack}>
            Назад
          </button>
        </div>
      </section>
    );
  }
  if (context === null) return <p>Загрузка…</p>;

  const start = (module: ModuleId): void => {
    onStart(planFree(module, hashString(`free:${localDate()}:${module}:${String(context.sessions)}`), context.phase));
  };

  return (
    <section aria-label="Свободная тренировка">
      <h2>Свободная тренировка</h2>
      <p className="muted">Выбери модуль. Подход длится 5 минут.</p>
      <ul aria-label="Модули" className="module-list">
        {MODULE_IDS.map((m, i) => (
          <li key={m}>
            <button type="button" autoFocus={i === 0} onClick={() => { start(m); }}>
              {moduleTitles[m]}
            </button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" onClick={onBack}>
          Назад
        </button>
      </div>
    </section>
  );
}
