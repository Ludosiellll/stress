import { isReactionId, type DiagnosticResults } from '../../engine/diagnostic';
import type { LayoutId, ModuleId } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import {
  DIAGNOSTIC_ROW_IDS,
  GORBOV_ROWS,
  diagnosticChange,
  diagnosticComparable,
  diagnosticDetailLines,
  diagnosticNorm,
  diagnosticValue,
  diagnosticValueText,
  type DiagnosticRowId,
} from '../../session/diagnosticCompare';
import { whole, type BlockSummaryView, type DiagnosticComparison } from '../../session/steps';
import { decimal, noBreakUnits } from '../format';
import { ruDate, THREE_TABLES } from '../progressModel';
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
  /** The layout the diagnostic played (the user's own; default the keyboard): on the mouse ПЗМР and СЗМР get no norm (T-R23). */
  layout?: LayoutId;
  onHome: () => void;
}

const NO_DATA = 'нет данных';
/** No change or no reference band. */
const NONE = '—';
/** Added to a value whose block kept dropping frames after its replay (I1). */
const UNRELIABLE = 'замер ненадёжен';
/** The change of a row whose two values were measured differently (Р25): Горбов's tables, the number-series forms. */
const INCOMPARABLE = 'несравнимо: формат изменён в 0.3.0';
/** Under the table of the first diagnostic on one table after one on three (F10). */
const FIRST_ONE_TABLE = 'Горбов: первая диагностика на одной таблице — сравнение с прошлыми условное.';

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

/**
 * The restarts of the row's module: «да» for one with Esc (the task's one restart, Р22), «фокус» for those after a focus
 * loss, which are free («фокус ×2» for more than one, T-R57); «да; фокус» for both, «—» for none.
 */
function restartText(d: DiagnosticResults, id: DiagnosticRowId): string {
  const r = d.restarts[ROW_MODULE[id]];
  const focus = r?.focus ?? 0;
  const focusText = focus === 0 ? null : focus === 1 ? 'фокус' : `фокус ×${String(focus)}`;
  if ((r?.user ?? 0) >= 1) return focusText === null ? 'да' : `да; ${focusText}`;
  return focusText ?? NONE;
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

/**
 * The previous diagnostic's cell (cellText); a Горбов value of three tables says so when this one played one (Р25).
 * The number series of another form has only its change marked.
 */
function previousCellText(d: DiagnosticResults, previous: DiagnosticResults, id: DiagnosticRowId, seriesTotal: number | null): string {
  const text = cellText(previous, id, seriesTotal);
  const threeTables =
    GORBOV_ROWS.has(id) && d.gorbovOneTable && !diagnosticComparable(id, d, previous) && diagnosticValue(previous, id) !== null;
  return threeTables ? `${text} (${THREE_TABLES})` : text;
}

function changeText(id: DiagnosticRowId, d: DiagnosticResults, previous: DiagnosticResults): string {
  const now = diagnosticValue(d, id);
  const before = diagnosticValue(previous, id);
  if (now === null || before === null) return NONE;
  return diagnosticComparable(id, d, previous) ? diagnosticChange(id, now, before) : INCOMPARABLE;
}

/** This diagnostic is the first with Горбов on one table, and the previous one has a Горбов result of three tables (F10). */
function firstOneTable(d: DiagnosticResults, c: DiagnosticComparison | null): boolean {
  const previous = c?.previous?.metrics;
  return previous !== undefined && d.gorbovOneTable && d.gorbov !== null && !previous.gorbovOneTable && previous.gorbov !== null;
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

function ResultsTable({
  d,
  seriesTotal,
  comparison,
  layout,
}: {
  d: DiagnosticResults;
  seriesTotal: number | null;
  comparison: DiagnosticComparison | null;
  layout: LayoutId;
}) {
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
                <td className="num">{noBreakUnits(previousCellText(d, previous.metrics, id, seriesTotal))}</td>
                {/* A change stays on one line; the long «несравнимо…» may wrap. */}
                <td className={diagnosticComparable(id, d, previous.metrics) ? 'nowrap' : undefined}>
                  {noBreakUnits(changeText(id, d, previous.metrics))}
                </td>
              </>
            )}
            <td>{noBreakUnits(diagnosticNorm(d, id, layout) ?? NONE)}</td>
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

export default function Done({
  diagnostic,
  seriesTotal,
  summaries,
  indexDeferred = false,
  comparison = null,
  layout = 'keyboard',
  onHome,
}: DoneProps) {
  const lines = moduleLines(summaries);
  const index = comparison === null ? null : indexLine(comparison);
  return (
    <div className="screen-center done">
      <h2 tabIndex={-1}>Сессия завершена</h2>
      {diagnostic !== null && <ResultsTable d={diagnostic} seriesTotal={seriesTotal} comparison={comparison} layout={layout} />}
      {diagnostic !== null && <DetailLines d={diagnostic} />}
      {diagnostic !== null && firstOneTable(diagnostic, comparison) && <p className="muted">{FIRST_ONE_TABLE}</p>}
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
