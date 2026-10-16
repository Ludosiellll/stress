import { isReactionId, type DiagnosticResults } from '../../engine/diagnostic';
import type { ModuleId } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import {
  DIAGNOSTIC_ROW_IDS,
  diagnosticChange,
  diagnosticDetailLines,
  diagnosticNorm,
  diagnosticValue,
  diagnosticValueText,
  type DiagnosticRowId,
} from '../../session/diagnosticCompare';
import { whole, type BlockSummaryView, type DiagnosticComparison } from '../../session/steps';
import { decimal, noBreakUnits } from '../format';
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

/** The module whose restarts a row reports (F11): Горбов's three rows share one. */
const ROW_MODULE: Readonly<Record<DiagnosticRowId, ModuleId>> = {
  pzmr: 'pzmr',
  szmr: 'szmr',
  gonogo: 'gonogo',
  rdo: 'rdo',
  gorbovV: 'gorbov',
  gorbovP: 'gorbov',
  gorbovPi: 'gorbov',
  numseries: 'numseries',
  pomeh: 'pomeh',
  stroop: 'stroop',
  taskswitch: 'taskswitch',
  memory: 'memory',
};

/** «да» when a task of the row's module was restarted with Esc; restarts after a focus loss do not count (Р22). */
function restartText(d: DiagnosticResults, id: DiagnosticRowId): string {
  return (d.restarts[ROW_MODULE[id]]?.user ?? 0) >= 1 ? 'да' : NONE;
}

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

/** A shown value with its unit (diagnosticValueText); number series as «14 из 20». */
function valueText(id: DiagnosticRowId, v: number, seriesTotal: number | null): string {
  return id === 'numseries' && seriesTotal !== null ? `${String(v)} из ${String(seriesTotal)}` : diagnosticValueText(id, v);
}

/** The cell of one diagnostic: «нет данных» without a value, «…, замер ненадёжен» for its unreliable modules. */
function cellText(d: DiagnosticResults, id: DiagnosticRowId, seriesTotal: number | null): string {
  const v = diagnosticValue(d, id);
  if (v === null) return NO_DATA;
  const text = valueText(id, v, seriesTotal);
  return isReactionId(id) && d.unreliable.includes(id) ? `${text}, ${UNRELIABLE}` : text;
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

/** «Подробности диагностики»: spread and errors as lines under the table, which keeps its twelve rows (F7, Р20). */
function DetailLines({ d }: { d: DiagnosticResults }) {
  const lines = diagnosticDetailLines(d);
  if (lines.length === 0) return null;
  return (
    <ul aria-label="Подробности диагностики">
      {lines.map((line) => (
        <li key={line}>{noBreakUnits(line)}</li>
      ))}
    </ul>
  );
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
          <th scope="col">Перезапуск</th>
        </tr>
      </thead>
      <tbody>
        {DIAGNOSTIC_ROW_IDS.map((id) => (
          <tr key={id}>
            <td>{LABELS[id]}</td>
            <td className="num">{noBreakUnits(cellText(d, id, seriesTotal))}</td>
            {previous !== null && (
              <>
                <td className="num">{noBreakUnits(cellText(previous.metrics, id, seriesTotal))}</td>
                <td className="nowrap">{noBreakUnits(changeText(id, d, previous.metrics))}</td>
              </>
            )}
            <td>{noBreakUnits(diagnosticNorm(d, id) ?? NONE)}</td>
            <td>{restartText(d, id)}</td>
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
      {diagnostic !== null && <DetailLines d={diagnostic} />}
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
