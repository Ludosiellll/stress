import type { DiagnosticResults } from '../../engine/diagnostic';
import type { ModuleId, ReactionModuleId } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import type { BlockSummaryView } from '../../session/steps';
import { decimal } from '../format';

export interface DoneProps {
  /** Results of a diagnostic session; null for training and free sessions. */
  diagnostic: DiagnosticResults | null;
  /** Number-series items in the diagnostic, for «14 из 20». */
  seriesTotal: number | null;
  /** Every block summary shown in this session, in order. */
  summaries: readonly BlockSummaryView[];
  onHome: () => void;
}

const NO_DATA = 'нет данных';
/** Added to a value whose block kept dropping frames after its replay (I1). */
const UNRELIABLE = 'замер ненадёжен';

const ms = (x: number | null): string => (x === null ? NO_DATA : `${String(Math.round(x))} мс`);
const seconds = (x: number): string => `${decimal(x).replace('-', '−')} с`;

function seriesText(correct: number | null, total: number | null): string {
  if (correct === null) return NO_DATA;
  return total === null ? String(correct) : `${String(correct)} из ${String(total)}`;
}

function diagnosticRows(d: DiagnosticResults, seriesTotal: number | null): Array<[string, string]> {
  const g = d.gorbov;
  const mark = (module: ReactionModuleId, text: string): string =>
    text !== NO_DATA && d.unreliable.includes(module) ? `${text}, ${UNRELIABLE}` : text;
  return [
    [`${moduleTitles.pzmr} — медиана времени реакции`, mark('pzmr', ms(d.pzmrMedianRt))],
    [`${moduleTitles.szmr} — медиана времени реакции`, mark('szmr', ms(d.szmrMedianRt))],
    [`${moduleTitles.gonogo} — верные ответы`, mark('gonogo', d.gonogoScore === null ? NO_DATA : `${String(Math.round(d.gonogoScore))} %`)],
    [`${moduleTitles.rdo} — средняя ошибка`, mark('rdo', ms(d.rdoMeanAbsErrorMs))],
    ['Горбов — V, среднее время 1-й и 2-й таблиц', g === null ? NO_DATA : seconds(g.V)],
    ['Горбов — P, время 3-й таблицы', g === null ? NO_DATA : seconds(g.P)],
    ['Горбов — Π, переключение внимания', g === null ? NO_DATA : seconds(g.Pi)],
    [`${moduleTitles.numseries} — решено верно`, seriesText(d.numseriesCorrect, seriesTotal)],
  ];
}

/** «ПЗМР: блоков 3, уровень 4,0 → 5,5» per module, in the order the modules were played; no level where none is shown. */
function moduleLines(summaries: readonly BlockSummaryView[]): string[] {
  const byModule = new Map<ModuleId, BlockSummaryView[]>();
  for (const s of summaries) byModule.set(s.module, [...(byModule.get(s.module) ?? []), s]);
  return [...byModule.values()].map((list) => {
    const first = list[0] as BlockSummaryView;
    const last = list[list.length - 1] as BlockSummaryView;
    const head = `${first.title}: блоков ${String(list.length)}`;
    return first.showLevel ? `${head}, уровень ${decimal(first.lBefore)} → ${decimal(last.lAfter)}` : head;
  });
}

export default function Done({ diagnostic, seriesTotal, summaries, onHome }: DoneProps) {
  const lines = moduleLines(summaries);
  return (
    <div className="screen-center done">
      <h2 tabIndex={-1}>Сессия завершена</h2>
      {diagnostic !== null && (
        <table className="results" aria-label="Результаты диагностики">
          <thead>
            <tr>
              <th scope="col">Показатель</th>
              <th scope="col">Результат</th>
            </tr>
          </thead>
          <tbody>
            {diagnosticRows(diagnostic, seriesTotal).map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
