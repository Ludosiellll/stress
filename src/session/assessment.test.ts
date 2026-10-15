import { describe, expect, it } from 'vitest';
import { block } from '../data/repository.contract';
import type { BlockRow } from '../data/rows';
import { defaultModuleState } from '../engine/derive';
import { NORM_HINTS } from '../engine/norms';
import type { ModuleState } from '../engine/planner';
import { MODULE_IDS, type ModuleId } from '../engine/types';
import { gorbovParams } from '../modules/tables/gorbov';
import { assessBlock, assessModules, formatMetric, meanFamilyRating, normLine, type AssessContext, type ModuleAssessment } from './assessment';
import { buildBlockHistory, type BlockHistory, type HistoryEntry } from './blockHistory';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
/** ISO string `d` days before NOW. */
const ago = (d: number): string => new Date(NOW.getTime() - d * DAY_MS).toISOString();
const e = (d: number, value: number, L = 10): HistoryEntry => ({ at: ago(d), value, L, length: null, norms: [] });

let nextId = 0;
const row = (over: Partial<BlockRow>): BlockRow => block(`b${String(++nextId)}`, 's', NOW.toISOString(), over);

type GorbovTask = 'black_up' | 'red_down' | 'alternate';

/** A Горбов block from L0 to L1; timeMs null: the table was not finished. */
function gorbovRow(task: GorbovTask, L0: number, L1: number, timeMs: number | null, over: Partial<BlockRow> = {}): BlockRow {
  return row({
    module: 'gorbov',
    lBefore: L0,
    lAfter: L1,
    paramsJson: JSON.stringify({ task, ...gorbovParams(L0, task) }),
    summaryJson: JSON.stringify({ score: 0.5, timeMs, errors: 0, correct: 49, completed: timeMs !== null, task }),
    ...over,
  });
}

const H: BlockHistory = new Map([['gorbov:black_up', [e(20, 41.0, 10), e(6, 42.4, 11), e(1, 48.2, 11)]]]);
const ctx: AssessContext = { kind: 'training', history: H, now: NOW, meanRating: null };
const withHistory = (variant: string, entries: HistoryEntry[]): AssessContext => ({ ...ctx, history: new Map([[variant, entries]]) });

const GORBOV_HISTORY = 'Раньше в этом блоке: прошлый раз 48,2 с (ур. 11) · лучший 41,0 с · в среднем за 7 дней 45,3 с';

describe('assessBlock', () => {
  it('the spec example: Gorbov black_up at level 13,5', () => {
    expect(assessBlock(gorbovRow('black_up', 12, 13.5, 44_000), ctx)).toEqual({
      step: 'Ступень 3 из 5+ — формат теста (уровень 13,5; формат теста — 12)',
      goal: 'До ступени 4 «сверх нормы»: уровень 17 (+3,5). Там: лимит времени: 39 → 29 с; перемешивание: нет → каждые 9 верных',
      norms: ['Норма (ориентир): 44,0 с — средний; выше среднего — до 37 с. Бумажная методика, источник не указан'],
      history: `${GORBOV_HISTORY} — лучше прошлого раза`,
    });
  });

  it('a new best is marked; an equal result in shown rounding is not', () => {
    expect(assessBlock(gorbovRow('black_up', 12, 13.5, 40_000), ctx).history).toMatch(/ — новый лучший результат$/);
    // 41,04 s shows as the best 41,0 s: not a new best, still better than the last 48,2 s.
    expect(assessBlock(gorbovRow('black_up', 12, 13.5, 41_040), ctx).history).toBe(`${GORBOV_HISTORY} — лучше прошлого раза`);
    // Level 10 (limit 52 s), so a finished 48,24 s is within the limit.
    expect(assessBlock(gorbovRow('black_up', 10, 10.5, 48_240), ctx).history).toBe(GORBOV_HISTORY);
  });

  it('an unfinished table: step and history, no mark, no norm', () => {
    const a = assessBlock(gorbovRow('black_up', 13, 13, null), ctx);
    expect(a.norms).toEqual([]);
    expect(a.history).toBe(GORBOV_HISTORY);
    expect(a.step).toBe('Ступень 3 из 5+ — формат теста (уровень 13; формат теста — 12)');
  });

  it('the first block of a variant, and a history that could not be read', () => {
    expect(assessBlock(gorbovRow('red_down', 0, 2, 70_000), ctx).history).toBe('Первый такой блок — будет с чем сравнивать');
    expect(assessBlock(gorbovRow('black_up', 12, 13.5, 44_000), { ...ctx, history: null }).history).toBeNull();
  });

  it('a Gorbov block whose task cannot be read: the goal has no «Там», nothing throws', () => {
    const a = assessBlock(gorbovRow('black_up', 12, 13.5, 44_000, { paramsJson: '{}', summaryJson: '{"timeMs":44000}' }), ctx);
    expect(a.step).toBe('Ступень 3 из 5+ — формат теста (уровень 13,5; формат теста — 12)');
    expect(a.goal).toBe('До ступени 4 «сверх нормы»: уровень 17 (+3,5)');
    expect(a.norms).toEqual([]);
    expect(a.history).toBeNull();
  });

  it('overload: played level, no goal, no mark', () => {
    const a = assessBlock(
      gorbovRow('alternate', 17, 17, 40_000, { flags: ['overload'] }),
      withHistory('gorbov:alternate', [e(1, 140.5, 12)]),
    );
    expect(a).toEqual({
      step: 'Ступень 4 из 5+ — сверх нормы (уровень 17; формат теста — 12; перегрузка)',
      goal: null,
      norms: ['Норма (ориентир): 40,0 с — высокий. Бумажная методика, источник не указан'],
      history: 'Раньше в этом блоке: прошлый раз 140,5 с (ур. 12) · лучший 140,5 с · в среднем за 7 дней 140,5 с',
    });
  });

  it('timing_unreliable gets no mark', () => {
    const a = assessBlock(
      row({ module: 'pzmr', lBefore: 5, lAfter: 5, flags: ['timing_unreliable'], summaryJson: '{"meanRt":250,"sdRt":40}' }),
      withHistory('pzmr', [e(1, 300, 5)]),
    );
    expect(a.history).toMatch(/в среднем за 7 дней 300 мс$/);
  });

  it('no entry in the last 7 days: no 7-day mean', () => {
    const a = assessBlock(
      row({ module: 'pzmr', lBefore: 5, lAfter: 5, summaryJson: '{"meanRt":250,"sdRt":40}' }),
      withHistory('pzmr', [e(10, 300, 5)]),
    );
    expect(a.history).toBe('Раньше в этом блоке: прошлый раз 300 мс (ур. 5) · лучший 300 мс — новый лучший результат');
  });

  it('diagnostic: norms only', () => {
    const a = assessBlock(row({ module: 'pzmr', lBefore: 0, lAfter: 0, summaryJson: '{"meanRt":262.4,"sdRt":50.2}' }), {
      ...ctx,
      kind: 'diagnostic',
    });
    expect(a).toEqual({
      step: null,
      goal: null,
      history: null,
      norms: [
        'Норма (ориентир), среднее: 262 мс — средний; выше среднего — меньше 234 мс. Мальцев 2026, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
        'Норма (ориентир), разброс (SD): 50 мс — средний; выше среднего — меньше 45 мс. Мальцев 2026, юноши 18–21, аппаратная кнопка',
      ],
    });
  });

  it('diagnostic Gorbov run 2', () => {
    expect(assessBlock(gorbovRow('red_down', 0, 0, 52_000), { ...ctx, kind: 'diagnostic' }).norms).toEqual([
      'Норма (ориентир): 52,0 с — ниже среднего; средний — до 50 с. Бумажная методика, источник не указан',
    ]);
  });

  it('СЗМР gets the 2-choice norm only below level 8', () => {
    const szmr = (lBefore: number): BlockRow => row({ module: 'szmr', lBefore, lAfter: lBefore, summaryJson: '{"meanRt":401.6}' });
    expect(assessBlock(szmr(7.5), ctx).norms).toEqual([
      'Норма (ориентир), среднее: 402 мс — ниже среднего; средний — до 382 мс. Мальцев 2026, выбор из 2, юноши 18–21; норма для аппаратной кнопки + 30 мс на клавиатуру',
    ]);
    expect(assessBlock(szmr(8), ctx).norms).toEqual([]);
  });

  it('memory: the span norm from 4 exact of 6; the history shows the row length', () => {
    const memory = row({
      module: 'memory',
      lBefore: 9,
      lAfter: 9.5,
      paramsJson: '{"mode":"digits","length":7}',
      summaryJson: JSON.stringify({ mode: 'digits', length: 7, exact: 5, answers: [1, 2, 3, 4, 5, 6] }),
    });
    const history = withHistory('memory:digits', [{ at: ago(2), value: 67, L: 9, length: 7, norms: [] }]);
    expect(assessBlock(memory, history)).toMatchObject({
      norms: ['Норма (ориентир), объём: 7 — средний; выше среднего — от 8. Woods 2011, молодые взрослые, слуховое предъявление'],
      history: 'Раньше в этом блоке: прошлый раз 67 % (ряд 7, ур. 9) · лучший 67 % · в среднем за 7 дней 67 % — новый лучший результат',
    });
  });

  it('differences are signed', () => {
    const stroop = row({
      module: 'stroop',
      lBefore: 6,
      lAfter: 6,
      summaryJson: JSON.stringify({ conditions: { congruent: { medianRt: 500 }, incongruent: { medianRt: 570 } } }),
    });
    expect(assessBlock(stroop, withHistory('stroop', [e(3, 40, 5), e(1, 85, 6)]))).toMatchObject({
      history: 'Раньше в этом блоке: прошлый раз +85 мс (ур. 6) · лучший +40 мс · в среднем за 7 дней +63 мс — лучше прошлого раза',
      norms: [NORM_HINTS.stroop],
    });
  });

  it('number series: steps by the mean family rating', () => {
    const series = row({ module: 'numseries', lBefore: 0, lAfter: 0, summaryJson: '{"correct":7,"total":10}' });
    expect(assessBlock(series, { kind: 'free', history: new Map(), now: NOW, meanRating: 1180.4 })).toEqual({
      step: 'Ступень 2 из 5+ — на подходе к формату теста (рейтинг 1180; формат теста — 1376)',
      goal: 'До ступени 3 «формат теста»: рейтинг 1376 (+196)',
      norms: [],
      history: 'Первый такой блок — будет с чем сравнивать',
    });
  });

  it('number series without a rating: no step and no goal', () => {
    const series = row({ module: 'numseries', lBefore: 0, lAfter: 0, summaryJson: '{"correct":7,"total":10}' });
    expect(assessBlock(series, { ...ctx, history: withHistory('numseries', [e(1, 60)]).history })).toEqual({
      step: null,
      goal: null,
      norms: [],
      history: 'Раньше в этом блоке: прошлый раз 60 % · лучший 60 % · в среднем за 7 дней 60 % — новый лучший результат',
    });
  });

  it('no ceiling: step 6 of ПЗМР', () => {
    const a = assessBlock(row({ module: 'pzmr', lBefore: 29, lAfter: 30, summaryJson: '{"meanRt":240,"sdRt":30}' }), ctx);
    expect(a.step).toBe('Ступень 6 — далеко сверх нормы (уровень 30; формат теста — 14)');
    expect(a.goal).toBe('До ступени 7 «далеко сверх нормы»: уровень 34 (+4). Там: окно ответа: 168 → 161 мс');
  });

  it('step and distance come from the shown level (A-R7)', () => {
    const a = assessBlock(gorbovRow('black_up', 11, 11.97, 44_000), ctx);
    expect(a.step).toBe('Ступень 3 из 5+ — формат теста (уровень 12; формат теста — 12)');
    expect(a.goal).toMatch(/^До ступени 4 «сверх нормы»: уровень 17 \(\+5\)\. Там: /);
    // 4,5 − 3,3 is 1,2 in shown rounding, not 1,2000000000000002.
    expect(assessBlock(row({ module: 'memory', lBefore: 3, lAfter: 3.3, summaryJson: '{}' }), ctx).goal).toMatch(
      /^До ступени 2 «на подходе к формату теста»: уровень 4,5 \(\+1,2\)\. Там: /,
    );
  });

  it('hints', () => {
    const at = (module: BlockRow['module'], over: Partial<BlockRow> = {}): string[] =>
      assessBlock(row({ module, lBefore: 5, lAfter: 5, summaryJson: '{}', ...over }), ctx).norms;
    expect(at('gonogo')).toEqual([NORM_HINTS.gonogo]);
    expect(at('taskswitch')).toEqual([NORM_HINTS.taskswitch]);
    expect(at('schulte', { paramsJson: '{"size":5}' })).toEqual([NORM_HINTS.schulte5]);
    expect(at('schulte', { paramsJson: '{"size":6}' })).toEqual([]);
    expect(at('rdo')).toEqual([]);
    expect(at('pomeh')).toEqual([]);
    expect(assessBlock(row({ module: 'gonogo', summaryJson: '{}' }), { ...ctx, kind: 'diagnostic' }).norms).toEqual([NORM_HINTS.gonogo]);
  });
});

describe('meanFamilyRating', () => {
  it('averages the 8 families, R0 for a family without a rating', () => {
    expect(meanFamilyRating(new Map())).toBe(1000);
    expect(meanFamilyRating(new Map([['arith', { rating: 1400, n: 30 }]]))).toBe(1050);
  });
});

describe('normLine', () => {
  it('has no next band in band 5', () => {
    expect(normLine({ id: 'memorySpan', value: 9 })).toBe(
      'Норма (ориентир), объём: 9 — высокий. Woods 2011, молодые взрослые, слуховое предъявление',
    );
  });
});

describe('formatMetric', () => {
  it('writes the key metric as shown', () => {
    expect(formatMetric('gorbov', 44)).toBe('44,0 с');
    expect(formatMetric('stroop', 85)).toBe('+85 мс');
    expect(formatMetric('taskswitch', -12)).toBe('−12 мс');
    expect(formatMetric('pomeh', 0)).toBe('0 мс');
    expect(formatMetric('pzmr', 262)).toBe('262 мс');
    expect(formatMetric('memory', 67)).toBe('67 %');
  });
});

describe('assessModules', () => {
  /** A stored block of the training session «t», `d` days before NOW. */
  const stored = (module: ModuleId, d: number, over: Partial<BlockRow> = {}): BlockRow =>
    block(`h${String(++nextId)}`, 't', ago(d), { module, ...over });
  const history = (rows: BlockRow[]): BlockHistory => buildBlockHistory(rows, [{ id: 't', kind: 'training' }]);
  const gorbovBlock = (task: GorbovTask, d: number, timeMs: number): BlockRow =>
    stored('gorbov', d, { paramsJson: JSON.stringify({ task }), summaryJson: JSON.stringify({ timeMs, task }) });
  const schulteBlock = (size: number, d: number, timeMs: number | null): BlockRow =>
    stored('schulte', d, { paramsJson: JSON.stringify({ size }), summaryJson: JSON.stringify({ timeMs }) });
  const states = (over: Partial<Record<ModuleId, Partial<ModuleState>>> = {}): Record<ModuleId, ModuleState> =>
    Object.fromEntries(MODULE_IDS.map((m) => [m, { ...defaultModuleState(m), ...over[m] }])) as Record<ModuleId, ModuleState>;
  const assess = (over: Partial<Record<ModuleId, Partial<ModuleState>>>, rows: BlockRow[], meanRating = 1000): ModuleAssessment[] =>
    assessModules({ states: states(over), meanRating, history: history(rows), now: NOW });
  const rowOf = (rows: ModuleAssessment[], module: ModuleId): ModuleAssessment | undefined => rows.find((r) => r.module === module);

  it('untrained modules: a dash and «ещё не тренировался»', () => {
    const rows = assess({}, []);
    expect(rows.map((r) => r.module)).toEqual([...MODULE_IDS]);
    expect(rows[0]).toEqual({ module: 'pzmr', title: 'ПЗМР', step: '—', lastBest: 'ещё не тренировался', norm: '—', goal: '—' });
    expect(rowOf(rows, 'gorbov')).toEqual({
      module: 'gorbov',
      title: 'Красно-чёрные таблицы Горбова — чередование',
      step: '—',
      lastBest: 'ещё не тренировался',
      norm: '—',
      goal: '—',
    });
    expect(rowOf(rows, 'schulte')?.title).toBe('Таблицы Шульте');
    expect(rowOf(rows, 'memory')?.title).toBe('Память — цифры');
    expect(rowOf(rows, 'numseries')).toEqual({ module: 'numseries', title: 'Числовые ряды', step: '—', lastBest: 'ещё не тренировался', norm: '—', goal: '—' });
  });

  it('Gorbov: alternation is the main variant; best of 30 days', () => {
    const rows = assess({ gorbov: { lSaved: 13.5, lifetimeBlocks: 9 } }, [
      gorbovBlock('alternate', 40, 120_000),
      gorbovBlock('black_up', 20, 30_000),
      gorbovBlock('alternate', 10, 150_240),
      gorbovBlock('alternate', 1, 140_520),
    ]);
    expect(rowOf(rows, 'gorbov')).toEqual({
      module: 'gorbov',
      title: 'Красно-чёрные таблицы Горбова — чередование',
      step: '3 — формат теста (ур. 13,5; формат теста — 12)',
      lastBest: '140,5 с / 140,5 с',
      norm: 'выше среднего',
      goal: 'ур. 17 (+3,5)',
    });
  });

  it('number series by the mean rating', () => {
    const rows = assess({ numseries: { lifetimeBlocks: 3 } }, [stored('numseries', 2, { summaryJson: '{"correct":7,"total":10}' })], 1180.4);
    expect(rowOf(rows, 'numseries')).toEqual({
      module: 'numseries',
      title: 'Числовые ряды',
      step: '2 — на подходе к формату теста (рейтинг 1180; формат теста — 1376)',
      lastBest: '70 % / 70 %',
      norm: '—',
      goal: 'рейтинг 1376 (+196)',
    });
  });

  it('Шульте: the largest finished grid', () => {
    const rows = assess({ schulte: { lSaved: 8, lifetimeBlocks: 4 } }, [
      schulteBlock(5, 3, 31_000),
      schulteBlock(6, 2, 58_000),
      schulteBlock(7, 1, null),
    ]);
    expect(rowOf(rows, 'schulte')).toEqual({
      module: 'schulte',
      title: 'Таблицы Шульте — 6×6',
      step: '3 — формат теста (ур. 8; формат теста — 6)',
      lastBest: '58,0 с / 58,0 с',
      norm: '—',
      goal: 'ур. 11 (+3)',
    });
  });

  it('trained, but no finished block of the main variant', () => {
    const rows = assess({ gorbov: { lifetimeBlocks: 2 } }, [gorbovBlock('black_up', 1, 30_000)]);
    expect(rowOf(rows, 'gorbov')).toEqual({
      module: 'gorbov',
      title: 'Красно-чёрные таблицы Горбова — чередование',
      step: '1 — начальная (ур. 0; формат теста — 12)',
      lastBest: '—',
      norm: '—',
      goal: 'ур. 6 (+6)',
    });
  });

  it('the last result outside 30 days', () => {
    const rows = assess({ pzmr: { lifetimeBlocks: 1 } }, [stored('pzmr', 40, { summaryJson: '{"meanRt":262.4,"sdRt":50}' })]);
    expect(rowOf(rows, 'pzmr')).toEqual({
      module: 'pzmr',
      title: 'ПЗМР',
      step: '1 — начальная (ур. 0; формат теста — 14)',
      lastBest: '262 мс / —',
      norm: 'средний',
      goal: 'ур. 7 (+7)',
    });
  });

  it('the step and the goal come from the shown level (A-R7)', () => {
    // 11,97 shows as 12,0 → step 3 of Горбов, not step 2 with «+0,03».
    const rows = assess({ gorbov: { lSaved: 11.97, lifetimeBlocks: 1 } }, []);
    expect(rowOf(rows, 'gorbov')).toMatchObject({ step: '3 — формат теста (ур. 12; формат теста — 12)', goal: 'ур. 17 (+5)' });
  });

  it('unreadable stored blocks are left out; nothing throws', () => {
    const rows = assess({ pzmr: { lifetimeBlocks: 2 } }, [
      stored('pzmr', 2, { summaryJson: '{"meanRt":230}' }),
      stored('pzmr', 1, { summaryJson: '{not json' }),
    ]);
    expect(rowOf(rows, 'pzmr')).toMatchObject({ lastBest: '230 мс / 230 мс', norm: 'выше среднего' });
  });
});
