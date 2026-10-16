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

/** Some parts of the latest diagnostic are their own baseline and are left out until the next one (W2-R31). */
export const DEFERRED_NOTE = 'Новые показатели войдут в индекс со следующей диагностики.';

function abilityText(value: number | null): string {
  return value === null ? 'нет данных' : String(Math.round(value));
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
                <dd>{abilityText(readiness.abilities[id])}</dd>
              </div>
            ))}
          </dl>
          <p>Общий индекс: {readiness.overall === null ? 'нет данных' : Math.round(readiness.overall)}</p>
          {readiness.deferred && <p className="muted">{DEFERRED_NOTE}</p>}
          {readiness.unreliable.length > 0 && (
            <p className="muted">
              В последней диагностике замер ненадёжен: {readiness.unreliable.map((m) => moduleTitles[m]).join(', ')}. Индекс учитывает
              эти значения.
            </p>
          )}
          <p className="muted">
            Для большинства показателей 60 — уровень первой диагностики; время первых двух заданий Горбова (V) оценивается по бумажной шкале,
            это ориентир.
          </p>
        </>
      )}
    </section>
  );
}
