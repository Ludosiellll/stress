import type { DiagnosticResults } from '../../engine/diagnostic';
import { REACTION_MODULE_IDS, type ModuleId, type ReactionModuleId } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import { DIAGNOSTIC_ROW_IDS, diagnosticChange, diagnosticNorm, diagnosticValue, type DiagnosticRowId } from '../../session/diagnosticCompare';
import { signedMs, whole, type BlockSummaryView, type DiagnosticComparison } from '../../session/steps';
import { decimal } from '../format';
import { ruDate } from '../progressModel';
import { DEFERRED_NOTE } from './ReadinessBlock';

export interface DoneProps {
  /** Results of a diagnostic session; null for training and free sessions. */
  diagnostic: DiagnosticResults | null;
  /** Number-series items in the diagnostic, for «14 из 20». */
  seriesTotal: number | null;
  /** Every block summary shown in this session, in order. */
  summaries: readonly BlockSummaryView[];
  /** Parts of this diagnostic count in the readiness index from the next one (W2-R31). */
  indexDeferred?: boolean;
  /** A diagnostic: the previous one and the indexes (§3.3); null: training, free, or the earlier ones unreadable. */
  comparison?: DiagnosticComparison | null;
  onHome: () => void;
}

const NO_DATA = 'нет данных';
/** No change or no reference band. */
const NONE = '—';
/** Added to a value whose block kept dropping frames after its replay (I1). */
const UNRELIABLE = 'замер ненадёжен';

const LABELS: Readonly<Record<DiagnosticRowId, string>> = {
  pzmr: `${moduleTitles.pzmr} — медиана времени реакции`,
  szmr: `${moduleTitles.szmr} — медиана времени реакции`,
  gonogo: `${moduleTitles.gonogo} — верные ответы`,
  rdo: `${moduleTitles.rdo} — средняя ошибка по модулю`,
  gorbovV: 'Горбов — V, среднее время 1-й и 2-й таблиц',
  gorbovP: 'Горбов — P, время 3-й таблицы',
  gorbovPi: 'Горбов — Π, переключение внимания',
  numseries: `${moduleTitles.numseries} — решено верно`,
  pomeh: `${moduleTitles.pomeh} — разница с помехами и без`,
  stroop: `${moduleTitles.stroop} — интерференция`,
  taskswitch: `${moduleTitles.taskswitch} — цена переключения`,
  memory: `${moduleTitles.memory} — объём`,
};

const REACTION_IDS: readonly string[] = REACTION_MODULE_IDS;
const isReactionRow = (id: DiagnosticRowId): id is DiagnosticRowId & ReactionModuleId => REACTION_IDS.includes(id);

/**
 * A shown value (diagnosticValue) with its unit: «251 мс», «93 %», «−12,0 с», «14 из 20», «+35 мс» (a difference of
 * medians as the block summary showed it), «7».
 */
function valueText(id: DiagnosticRowId, v: number, seriesTotal: number | null): string {
  switch (id) {
    case 'gonogo':
      return `${String(v)} %`;
    case 'gorbovV':
    case 'gorbovP':
    case 'gorbovPi':
      return `${decimal(v).replace('-', '−')} с`;
    case 'numseries':
      return seriesTotal === null ? String(v) : `${String(v)} из ${String(seriesTotal)}`;
    case 'pomeh':
    case 'stroop':
    case 'taskswitch':
      return `${signedMs(v)} мс`;
    case 'memory':
      return String(v);
    default:
      return `${String(v)} мс`;
  }
}

/** The cell of one diagnostic: «нет данных» without a value, «…, замер ненадёжен» for its unreliable modules. */
function cellText(d: DiagnosticResults, id: DiagnosticRowId, seriesTotal: number | null): string {
  const v = diagnosticValue(d, id);
  if (v === null) return NO_DATA;
  const text = valueText(id, v, seriesTotal);
  return isReactionRow(id) && d.unreliable.includes(id) ? `${text}, ${UNRELIABLE}` : text;
}

function changeText(id: DiagnosticRowId, d: DiagnosticResults, previous: DiagnosticResults): string {
  const now = diagnosticValue(d, id);
  const before = diagnosticValue(previous, id);
  return now === null || before === null ? NONE : diagnosticChange(id, now, before);
}

/** «Индекс: 72 (прошлый — 65)»; null without an index. */
function indexLine(c: DiagnosticComparison): string | null {
  if (c.readiness === null) return null;
  const previous = c.readinessPrevious === null ? '' : ` (прошлый — ${String(whole(c.readinessPrevious))})`;
  return `Индекс: ${String(whole(c.readiness))}${previous}`;
}

function ResultsTable({ d, seriesTotal, comparison }: { d: DiagnosticResults; seriesTotal: number | null; comparison: DiagnosticComparison | null }) {
  const previous = comparison?.previous ?? null;
  return (
    <table className="results" aria-label="Результаты диагностики">
      <thead>
        <tr>
          <th scope="col">Показатель</th>
          <th scope="col" className="num">
            Результат
          </th>
          {previous !== null && (
            <>
              <th scope="col" className="num">
                {`Прошлая (№${String(previous.number)}, ${ruDate(previous.at)})`}
              </th>
              <th scope="col">Изменение</th>
            </>
          )}
          <th scope="col">Ориентир</th>
        </tr>
      </thead>
      <tbody>
        {DIAGNOSTIC_ROW_IDS.map((id) => (
          <tr key={id}>
            <td>{LABELS[id]}</td>
            <td className="num">{cellText(d, id, seriesTotal)}</td>
            {previous !== null && (
              <>
                <td className="num">{cellText(previous.metrics, id, seriesTotal)}</td>
                <td className="nowrap">{changeText(id, d, previous.metrics)}</td>
              </>
            )}
            <td>{diagnosticNorm(d, id) ?? NONE}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * «ПЗМР: блоков 3, уровень 4,0 → 5,5» per module, in the order the modules were played; no level where none is
 * shown. Overload blocks count as blocks, but the level change is that of the other blocks (none: no level).
 */
function moduleLines(summaries: readonly BlockSummaryView[]): string[] {
  const byModule = new Map<ModuleId, BlockSummaryView[]>();
  for (const s of summaries) byModule.set(s.module, [...(byModule.get(s.module) ?? []), s]);
  return [...byModule.values()].map((list) => {
    const head = `${(list[0] as BlockSummaryView).title}: блоков ${String(list.length)}`;
    const levelled = list.filter((s) => s.showLevel && !s.flags.includes('overload'));
    const first = levelled[0];
    const last = levelled.at(-1);
    return first && last ? `${head}, уровень ${decimal(first.lBefore)} → ${decimal(last.lAfter)}` : head;
  });
}

export default function Done({ diagnostic, seriesTotal, summaries, indexDeferred = false, comparison = null, onHome }: DoneProps) {
  const lines = moduleLines(summaries);
  const index = comparison === null ? null : indexLine(comparison);
  return (
    <div className="screen-center done">
      <h2 tabIndex={-1}>Сессия завершена</h2>
      {diagnostic !== null && <ResultsTable d={diagnostic} seriesTotal={seriesTotal} comparison={comparison} />}
      {diagnostic !== null && comparison !== null && comparison.previous === null && (
        <p>{comparison.earlierUnreadable ? 'Прошлые диагностики не прочитаны — сравнивать не с чем.' : 'Первая диагностика — сравнивать пока не с чем'}</p>
      )}
      {diagnostic !== null && index !== null && <p>{index}</p>}
      {diagnostic !== null && indexDeferred && <p className="muted">{DEFERRED_NOTE}</p>}
      {diagnostic !== null && diagnostic.unreliable.length > 0 && (
        <p className="muted">
          Замер ненадёжен: в блоке были пропуски кадров и после повтора. Значение сохранено и учтено в индексе готовности.
        </p>
      )}
      {lines.length > 0 && (
        <ul aria-label="Итог по модулям">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="primary" autoFocus onClick={onHome}>
          На главную
        </button>
      </div>
    </div>
  );
}
