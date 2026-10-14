import type { DiagnosticResults } from '../../engine/diagnostic';
import type { ModuleId } from '../../engine/types';
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

const ms = (x: number | null): string => (x === null ? NO_DATA : `${String(Math.round(x))} мс`);
const seconds = (x: number): string => `${decimal(x).replace('-', '−')} с`;

function seriesText(correct: number | null, total: number | null): string {
  if (correct === null) return NO_DATA;
  return total === null ? String(correct) : `${String(correct)} из ${String(total)}`;
}

function diagnosticRows(d: DiagnosticResults, seriesTotal: number | null): Array<[string, string]> {
  const g = d.gorbov;
  return [
    [`${moduleTitles.pzmr} — медиана времени реакции`, ms(d.pzmrMedianRt)],
    [`${moduleTitles.szmr} — медиана времени реакции`, ms(d.szmrMedianRt)],
    [`${moduleTitles.gonogo} — верные ответы`, d.gonogoScore === null ? NO_DATA : `${String(Math.round(d.gonogoScore))} %`],
    [`${moduleTitles.rdo} — средняя ошибка`, ms(d.rdoMeanAbsErrorMs)],
    ['Горбов — V, среднее время 1-й и 2-й таблиц', g === null ? NO_DATA : seconds(g.V)],
    ['Горбов — P, время 3-й таблицы', g === null ? NO_DATA : seconds(g.P)],
    ['Горбов — Π, переключение внимания', g === null ? NO_DATA : seconds(g.Pi)],
    [`${moduleTitles.numseries} — решено верно`, seriesText(d.numseriesCorrect, seriesTotal)],
  ];
}

/** «ПЗМР: блоков 3, уровень 4,0 → 5,5» per module, in the order the modules were played. */
function moduleLines(summaries: readonly BlockSummaryView[]): string[] {
  const byModule = new Map<ModuleId, BlockSummaryView[]>();
  for (const s of summaries) byModule.set(s.module, [...(byModule.get(s.module) ?? []), s]);
  return [...byModule.values()].map((list) => {
    const first = list[0] as BlockSummaryView;
    const last = list[list.length - 1] as BlockSummaryView;
    const head = `${first.title}: блоков ${String(list.length)}`;
    return first.module === 'numseries' ? head : `${head}, уровень ${decimal(first.lBefore)} → ${decimal(last.lAfter)}`;
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
