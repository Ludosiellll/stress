import { useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createRng, deriveSeed } from '../../engine/rng';
import { taskSequence, type TableCell } from '../../modules/tables/gorbov';
import { reshuffle, type TableClick, type TableRun } from '../../modules/tables/score';
import type { StepOf } from '../../session/steps';

export interface TableViewProps {
  step: StepOf<'table_block'>;
  onSubmit: (run: TableRun) => void;
}

/** Paper-form colours: the one light area of the app (spec §4, Gorbov tables). */
const INK: Record<TableCell['color'], string> = { red: '#d64545', black: '#111' };

interface Progress {
  /** Timestamp of the first frame with the grid on screen; clicks before it are ignored. */
  startTs: number | null;
  clicks: TableClick[];
  correct: number;
  reshuffles: number;
  finished: boolean;
}

const same = (a: TableCell, b: TableCell): boolean => a.value === b.value && a.color === b.color;

/**
 * A Schulte or Gorbov table, mouse only. The run starts at the first frame after the grid is drawn; a click
 * on the expected cell advances, any other click is an error. No timer on screen: the run ends with the
 * last correct click or at the deadline. With `reshuffleEvery` the cells are shuffled after every N
 * correct clicks (seeded by the block seed, so a run can be replayed).
 */
export default function TableView({ step, onSubmit }: TableViewProps) {
  const { params, task } = step;
  const sequence = useMemo(() => taskSequence(task, params.size), [task, params.size]);
  const [cells, setCells] = useState(step.cells);
  const progress = useRef<Progress>({ startTs: null, clicks: [], correct: 0, reshuffles: 0, finished: false });
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = (): void => {
    const p = progress.current;
    if (p.finished || p.startTs === null) return;
    p.finished = true;
    if (deadline.current !== null) clearTimeout(deadline.current);
    onSubmit({ task, startTs: p.startTs, timeLimitMs: params.timeLimitMs, total: sequence.length, clicks: [...p.clicks] });
  };
  const onDeadline = useEffectEvent(finish);

  useEffect(() => {
    const frame = requestAnimationFrame((ts) => {
      progress.current.startTs = ts;
      deadline.current = setTimeout(() => {
        onDeadline();
      }, params.timeLimitMs);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (deadline.current !== null) clearTimeout(deadline.current);
    };
  }, [params.timeLimitMs]);

  const onCell = (cell: TableCell, e: MouseEvent): void => {
    e.preventDefault();
    const p = progress.current;
    if (e.button !== 0 || p.startTs === null || p.finished) return;
    p.clicks.push({ cell, ts: e.timeStamp });
    const want = sequence[p.correct];
    if (want === undefined || !same(want, cell)) return;
    p.correct++;
    if (p.correct === sequence.length) {
      finish();
      return;
    }
    const every = params.reshuffleEvery;
    if (every !== null && p.correct % every === 0) {
      p.reshuffles++;
      const seed = deriveSeed(step.seed, 'reshuffle:' + String(p.reshuffles));
      setCells((current) => reshuffle(current, createRng(seed)));
    }
  };

  const style = { '--size': params.size } as CSSProperties;
  return (
    <div className="table-screen">
      <div role="group" aria-label="Таблица" className="table-grid" style={style}>
        {cells.map((cell) => (
          <button
            key={`${cell.color}${String(cell.value)}`}
            type="button"
            tabIndex={-1}
            className="table-cell"
            data-color={cell.color}
            style={{ color: INK[cell.color] }}
            onMouseDown={(e) => {
              onCell(cell, e);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
            }}
          >
            {cell.value}
          </button>
        ))}
      </div>
    </div>
  );
}
