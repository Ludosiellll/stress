import type { Ability } from '../../engine/readiness';
import { moduleTitles } from '../../modules/registry';
import type { HomeModel } from '../homeModel';

const ABILITIES: readonly (readonly [Ability, string])[] = [
  ['reaction', 'Реакция'],
  ['attention', 'Внимание'],
  ['switching', 'Переключение'],
  ['memory', 'Память'],
  ['logic', 'Логика'],
];

function abilityText(ability: Ability, value: number | null): string {
  if (value !== null) return String(Math.round(value));
  return ability === 'memory' ? 'появится позже' : 'нет данных';
}

/** Readiness index by ability; shared by Home and Progress. */
export default function ReadinessBlock({ readiness }: { readiness: HomeModel['readiness'] }) {
  return (
    <section aria-labelledby="readiness-title">
      <h2 id="readiness-title">Индекс готовности</h2>
      {readiness === null ? (
        <p>Пройди диагностику, чтобы увидеть индекс</p>
      ) : (
        <>
          <dl className="readiness">
            {ABILITIES.map(([id, label]) => (
              <div key={id}>
                <dt>{label}</dt>
                <dd>{abilityText(id, readiness.abilities[id])}</dd>
              </div>
            ))}
          </dl>
          <p>Общий индекс: {readiness.overall === null ? 'нет данных' : Math.round(readiness.overall)}</p>
          {readiness.unreliable.length > 0 && (
            <p className="muted">
              В последней диагностике замер ненадёжен: {readiness.unreliable.map((m) => moduleTitles[m]).join(', ')}. Индекс учитывает
              эти значения.
            </p>
          )}
          <p className="muted">60 — уровень твоей первой диагностики. Таблица Горбова оценивается по опубликованным нормам.</p>
        </>
      )}
    </section>
  );
}
