import { useEffect } from 'react';
import { moduleTitles } from '../../modules/registry';
import type { SessionPlan } from '../../engine/planner';

export interface PlaceholderProps {
  title: string;
  /** The plan the session screen was opened with. */
  plan?: SessionPlan;
  onBack: () => void;
}

/** Stands in for the screens of Tasks 15-16 (session, free training, progress). */
export default function Placeholder({ title, plan, onBack }: PlaceholderProps) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onBack]);

  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      <p>Этот экран ещё не реализован.</p>
      {plan !== undefined && (
        <ol>
          {plan.segments.map((s, i) => (
            <li key={i}>
              {moduleTitles[s.module]} — {s.budgetMs / 60_000} мин
            </li>
          ))}
        </ol>
      )}
      <button type="button" onClick={onBack}>
        Назад
      </button>
    </section>
  );
}
