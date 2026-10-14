import { useEffect, useState } from 'react';
import { planFree, type SessionPlan } from '../../engine/planner';
import { hashString } from '../../engine/rng';
import type { ModuleId } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import { useApp } from '../AppContext';
import { localDate } from '../format';
import { useKeyDown } from '../keys';

export interface FreeProps {
  onStart: (plan: SessionPlan) => void;
  onBack: () => void;
}

const MODULES: readonly ModuleId[] = ['pzmr', 'szmr', 'gonogo', 'rdo', 'gorbov', 'schulte', 'numseries'];

/** Free training: one module for 5 minutes. The seed changes with every session started. */
export default function Free({ onStart, onBack }: FreeProps) {
  const { repo } = useApp();
  const [sessions, setSessions] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void repo.listSessions().then((list) => {
      if (live) setSessions(list.length);
    });
    return () => {
      live = false;
    };
  }, [repo]);

  useKeyDown((e) => {
    if (e.key === 'Escape') onBack();
  });

  if (sessions === null) return <p>Загрузка…</p>;

  const start = (module: ModuleId): void => {
    onStart(planFree(module, hashString(`free:${localDate()}:${module}:${String(sessions)}`)));
  };

  return (
    <section aria-label="Свободная тренировка">
      <h2>Свободная тренировка</h2>
      <p className="muted">Выбери модуль. Подход длится 5 минут.</p>
      <ul aria-label="Модули" className="module-list">
        {MODULES.map((m, i) => (
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
