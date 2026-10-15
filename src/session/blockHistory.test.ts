import { describe, expect, it } from 'vitest';
import { block, session } from '../data/repository.contract';
import { szmr } from '../modules/reaction/szmr';
import type { BlockRow } from '../data/rows';
import {
  appendBlock,
  buildBlockHistory,
  entersHistory,
  historyEntry,
  historyStats,
  keyMetric,
  KEY_METRICS,
  mainVariant,
  normSamples,
  variantOf,
  type BlockHistory,
  type HistoryEntry,
} from './blockHistory';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
/** ISO string `d` days before NOW. */
const ago = (d: number): string => new Date(NOW.getTime() - d * DAY_MS).toISOString();

let nextId = 0;
const row = (over: Partial<BlockRow>): BlockRow => block(`b${String(++nextId)}`, 't', ago(1), over);

/** A Горбов block; timeMs null: the table was not finished. */
function table(task: string, timeMs: number | null, over: Partial<BlockRow> = {}): BlockRow {
  return row({
    module: 'gorbov',
    paramsJson: JSON.stringify({ task, timeLimitMs: 300_000, reshuffleEvery: 0, size: 7 }),
    summaryJson: JSON.stringify({ score: 0.5, timeMs, errors: 0, correct: 49, completed: timeMs !== null, task }),
    ...over,
  });
}

const memory = (summary: object, over: Partial<BlockRow> = {}): BlockRow =>
  row({ module: 'memory', paramsJson: '{"mode":"digits","length":7}', summaryJson: JSON.stringify(summary), ...over });
const answers = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('variantOf', () => {
  it('names the variant by module, task, grid size or mode', () => {
    expect(variantOf(row({ module: 'pzmr' }))).toBe('pzmr');
    expect(variantOf(table('alternate', 100_000))).toBe('gorbov:alternate');
    expect(variantOf(row({ module: 'gorbov', paramsJson: '{"task":"red_down"}', summaryJson: '{"timeMs":1000}' }))).toBe(
      'gorbov:red_down',
    );
    expect(variantOf(row({ module: 'gorbov', paramsJson: '{}', summaryJson: '{"timeMs":1000}' }))).toBeNull();
    expect(variantOf(row({ module: 'gorbov', paramsJson: '{"task":"xx"}', summaryJson: '{"task":"yy"}' }))).toBeNull();
    expect(variantOf(row({ module: 'schulte', paramsJson: '{"size":6}' }))).toBe('schulte:6');
    expect(variantOf(row({ module: 'schulte', paramsJson: '{"size":"x"}' }))).toBeNull();
    expect(variantOf(row({ module: 'schulte', paramsJson: '{"size":2.5}' }))).toBeNull();
    expect(variantOf(row({ module: 'schulte', paramsJson: '{"size":0}' }))).toBeNull();
    expect(variantOf(memory({ mode: 'digits' }))).toBe('memory:digits');
    expect(variantOf(memory({ mode: 'xx' }))).toBeNull();
    expect(variantOf(row({ module: 'memory', summaryJson: 'not json' }))).toBeNull();
  });
});

describe('keyMetric', () => {
  it('reads the key metric rounded as shown', () => {
    expect(keyMetric({ module: 'pzmr', summaryJson: '{"meanRt":287.6}' })).toBe(288);
    expect(keyMetric({ module: 'rdo', summaryJson: '{"meanAbsErrorMs":18.4}' })).toBe(18);
    expect(keyMetric({ module: 'gorbov', summaryJson: '{"timeMs":48240}' })).toBe(48.2);
    expect(keyMetric({ module: 'gorbov', summaryJson: '{"timeMs":null}' })).toBeNull();
    const cond = (fast: string, slow: string, f: number, s: number): string =>
      JSON.stringify({ conditions: { [fast]: { medianRt: f }, [slow]: { medianRt: s } } });
    expect(keyMetric({ module: 'stroop', summaryJson: cond('congruent', 'incongruent', 520.5, 610) })).toBe(89);
    expect(keyMetric({ module: 'taskswitch', summaryJson: cond('repeat', 'switch', 600, 588) })).toBe(-12);
    expect(keyMetric({ module: 'pomeh', summaryJson: cond('quiet', 'noisy', 300, 335.2) })).toBe(35);
    expect(keyMetric({ module: 'stroop', summaryJson: '{"meanRt":500}' })).toBeNull(); // written before 46fca3b
    expect(
      keyMetric({ module: 'memory', summaryJson: JSON.stringify({ mode: 'digits', length: 7, exact: 4, answers: [1, 2, 3, 4, 5, 6] }) }),
    ).toBe(67);
    expect(keyMetric({ module: 'numseries', summaryJson: '{"correct":7,"total":10}' })).toBe(70);
    for (const bad of ['', 'null', '[]', '{"meanRt":"300"}']) expect(keyMetric({ module: 'pzmr', summaryJson: bad })).toBeNull();
  });

  it('reads every module of the catalogue and never throws on damaged fields', () => {
    expect(keyMetric({ module: 'szmr', summaryJson: '{"meanRt":401.6}' })).toBe(402);
    expect(keyMetric({ module: 'gonogo', summaryJson: '{"meanRt":0.4}' })).toBe(0);
    expect(keyMetric({ module: 'rdo', summaryJson: '{"meanAbsErrorMs":null}' })).toBeNull();
    expect(keyMetric({ module: 'schulte', summaryJson: '{"timeMs":31960}' })).toBe(32);
    expect(keyMetric({ module: 'stroop', summaryJson: '{"conditions":{"congruent":{"medianRt":500}}}' })).toBeNull();
    expect(keyMetric({ module: 'stroop', summaryJson: '{"conditions":{"congruent":5,"incongruent":[]}}' })).toBeNull();
    expect(keyMetric({ module: 'stroop', summaryJson: '{"conditions":{"congruent":{"medianRt":null},"incongruent":{"medianRt":600}}}' })).toBeNull();
    expect(keyMetric({ module: 'memory', summaryJson: '{"exact":4,"answers":[]}' })).toBeNull();
    expect(keyMetric({ module: 'memory', summaryJson: '{"exact":"4","answers":[1]}' })).toBeNull();
    expect(keyMetric({ module: 'memory', summaryJson: '{"exact":4,"answers":"abcdef"}' })).toBeNull();
    expect(keyMetric({ module: 'numseries', summaryJson: '{"correct":7,"total":0}' })).toBeNull();
    expect(keyMetric({ module: 'numseries', summaryJson: '{"correct":7}' })).toBeNull();
    expect(keyMetric({ module: 'gorbov', summaryJson: '{"timeMs":1e999}' })).toBeNull();
  });

  it('has a key metric description for every module', () => {
    expect(KEY_METRICS.gorbov).toEqual({ unit: 'с', better: 'lower', signed: false });
    expect(KEY_METRICS.stroop).toEqual({ unit: 'мс', better: 'lower', signed: true });
    expect(KEY_METRICS.memory).toEqual({ unit: '%', better: 'higher', signed: false });
    expect(KEY_METRICS.numseries).toEqual({ unit: '%', better: 'higher', signed: false });
    expect(KEY_METRICS.pzmr).toEqual({ unit: 'мс', better: 'lower', signed: false });
  });
});

describe('normSamples', () => {
  it('ПЗМР: the mean first, then the SD', () => {
    expect(normSamples(row({ module: 'pzmr', summaryJson: '{"meanRt":262.4,"sdRt":50.2}' }))).toEqual([
      { id: 'pzmrMean', value: 262 },
      { id: 'pzmrSd', value: 50 },
    ]);
    expect(normSamples(row({ module: 'pzmr', summaryJson: '{"meanRt":262.4,"sdRt":null}' }))).toEqual([{ id: 'pzmrMean', value: 262 }]);
    expect(normSamples(row({ module: 'pzmr', summaryJson: 'not json' }))).toEqual([]);
  });

  it('СЗМР: the 2-choice norm only below level 8', () => {
    expect(normSamples(row({ module: 'szmr', lBefore: 7.5, summaryJson: '{"meanRt":401.6}' }))).toEqual([{ id: 'szmrMean', value: 402 }]);
    expect(normSamples(row({ module: 'szmr', lBefore: 8, summaryJson: '{"meanRt":401.6}' }))).toEqual([]);
    expect(normSamples(row({ module: 'szmr', lBefore: 0, summaryJson: '{"meanRt":null}' }))).toEqual([]);
    // Level 8 is where СЗМР adds the third colour.
    expect([szmr.params(7.5).nColors, szmr.params(8).nColors]).toEqual([2, 3]);
  });

  it('Горбов: by task, only a finished table', () => {
    expect(normSamples(table('black_up', 44_000))).toEqual([{ id: 'gorbovSimple', value: 44 }]);
    expect(normSamples(table('red_down', 36_960))).toEqual([{ id: 'gorbovSimple', value: 37 }]);
    expect(normSamples(table('alternate', 150_240))).toEqual([{ id: 'gorbovAlternate', value: 150.2 }]);
    expect(normSamples(table('alternate', null))).toEqual([]);
    expect(normSamples(row({ module: 'gorbov', paramsJson: '{}', summaryJson: '{"timeMs":44000}' }))).toEqual([]);
  });

  it('память: digits, all 6 answers and at least 4 exact give the row length', () => {
    expect(normSamples(memory({ mode: 'digits', length: 7, exact: 4, answers: answers(6) }))).toEqual([{ id: 'memorySpan', value: 7 }]);
    expect(normSamples(memory({ mode: 'digits', length: 7, exact: 3, answers: answers(6) }))).toEqual([]);
    expect(normSamples(memory({ mode: 'letters', length: 7, exact: 6, answers: answers(6) }))).toEqual([]);
    expect(normSamples(memory({ mode: 'digits', length: 7, exact: 3, answers: answers(3) }))).toEqual([]);
    expect(normSamples(memory({ mode: 'digits', length: 'x', exact: 6, answers: answers(6) }))).toEqual([]);
  });

  it('память: the span protocol gives its span', () => {
    expect(normSamples(memory({ protocol: 'span', mode: 'digits', exact: 9, span: 8, answers: answers(14) }))).toEqual([
      { id: 'memorySpan', value: 8 },
    ]);
    expect(normSamples(memory({ protocol: 'span', mode: 'digits', exact: 0, span: null, answers: answers(2) }))).toEqual([]);
  });

  it('РДО and Струп have no norm', () => {
    expect(normSamples(row({ module: 'rdo', summaryJson: '{"meanAbsErrorMs":18.4}' }))).toEqual([]);
    expect(normSamples(row({ module: 'stroop', summaryJson: '{"meanRt":500}' }))).toEqual([]);
  });
});

describe('entersHistory', () => {
  it('takes training and free blocks without overload or timing_unreliable', () => {
    expect(entersHistory([], 'training')).toBe(true);
    expect(entersHistory([], 'free')).toBe(true);
    expect(entersHistory(['fatigued'], 'training')).toBe(true);
    expect(entersHistory(['calibration'], 'free')).toBe(true);
    expect(entersHistory([], 'diagnostic')).toBe(false);
    expect(entersHistory(['overload'], 'training')).toBe(false);
    expect(entersHistory(['timing_unreliable'], 'free')).toBe(false);
  });
});

const SESSIONS = [session('t', ago(10)), session('f', ago(3), { kind: 'free' }), session('d', ago(5), { kind: 'diagnostic' })];

describe('buildBlockHistory', () => {
  it('groups training and free blocks by variant, in order', () => {
    const blocks = [
      table('alternate', 150_000, { lBefore: 11, startedAt: ago(9) }),
      table('black_up', 44_000, { startedAt: ago(9) }),
      table('alternate', 140_520, { sessionId: 'f', lBefore: 12, startedAt: ago(2), flags: ['fatigued'] }),
      table('alternate', 120_000, { sessionId: 'd', startedAt: ago(5) }),
      table('alternate', 120_000, { flags: ['overload'] }),
      table('alternate', 120_000, { flags: ['timing_unreliable'] }),
      table('alternate', null),
      table('alternate', 120_000, { sessionId: 'unknown' }),
    ];
    const h = buildBlockHistory(blocks, SESSIONS);
    expect(h.get('gorbov:alternate')).toEqual([
      { at: ago(9), value: 150, L: 11, length: null, norms: [{ id: 'gorbovAlternate', value: 150 }] },
      { at: ago(2), value: 140.5, L: 12, length: null, norms: [{ id: 'gorbovAlternate', value: 140.5 }] },
    ]);
    expect(h.get('gorbov:black_up')?.map((e) => e.value)).toEqual([44]);
    expect([...h.keys()].sort()).toEqual(['gorbov:alternate', 'gorbov:black_up']);
  });

  it('damaged and old rows are skipped, never thrown on', () => {
    const blocks = [
      row({ module: 'pzmr', summaryJson: 'not json' }),
      row({ module: 'pzmr', summaryJson: '{"meanRt":"300"}' }),
      row({ module: 'stroop', summaryJson: '{"meanRt":500}' }),
      memory({ mode: 'xx', length: 7, exact: 4, answers: answers(6) }),
      row({ module: 'gorbov', paramsJson: '{}', summaryJson: '{"timeMs":44000}' }),
      row({ module: 'schulte', paramsJson: 'not json', summaryJson: '{"timeMs":30000}' }),
      row({ module: 'numseries', summaryJson: '{"correct":"7","total":10}' }),
    ];
    expect(buildBlockHistory(blocks, SESSIONS).size).toBe(0);
  });

  it('unfinished tables have no number', () => {
    expect(historyEntry(table('alternate', null))).toBeNull();
  });

  it('memory entries keep the row length', () => {
    const r = memory({ mode: 'digits', length: 7, exact: 4, positionsCorrect: 36, answers: answers(6) }, { lBefore: 9, startedAt: ago(1) });
    expect(historyEntry(r)).toEqual({ at: ago(1), value: 67, L: 9, length: 7, norms: [{ id: 'memorySpan', value: 7 }] });
    expect(historyEntry(memory({ mode: 'letters', exact: 3, answers: answers(6) }))).toMatchObject({ value: 50, length: null });
  });

  it('appendBlock adds a block exactly as buildBlockHistory does', () => {
    const rows = [
      table('alternate', 150_000, { lBefore: 11, startedAt: ago(9) }),
      table('black_up', 44_000, { startedAt: ago(9) }),
      table('alternate', 140_520, { sessionId: 'f', lBefore: 12, startedAt: ago(2) }),
    ] as const;
    const h = buildBlockHistory(rows.slice(0, 2), SESSIONS);
    appendBlock(h, rows[2], 'free');
    expect(h).toEqual(buildBlockHistory(rows, SESSIONS));

    const before = structuredClone(h);
    appendBlock(h, table('alternate', 100_000, { sessionId: 'd' }), 'diagnostic');
    appendBlock(h, table('alternate', null), 'training');
    expect(h).toEqual(before);
  });
});

describe('historyStats', () => {
  const e = (d: number, value: number, L = 10): HistoryEntry => ({ at: ago(d), value, L, length: null, norms: [] });

  it('last, best, 7-day mean and 30-day best', () => {
    const entries = [e(20, 41.0, 10), e(6, 42.4, 11), e(1, 48.2, 11)];
    const s = historyStats(entries, NOW, 'lower');
    expect(s).toMatchObject({ last: entries[2], best: 41, best30d: 41 });
    expect(s?.mean7d).toBeCloseTo(45.3, 9);
    expect(historyStats([e(3, 60), e(2, 70), e(1, 50)], NOW, 'higher')?.best).toBe(70);
    expect(historyStats([e(40, 30), e(10, 45)], NOW, 'lower')).toMatchObject({ best: 30, best30d: 45, mean7d: null });
    expect(historyStats([{ ...e(1, 10), at: 'garbage' }], NOW, 'lower')).toMatchObject({ best: 10, mean7d: null, best30d: null });
    expect(historyStats([], NOW, 'lower')).toBeNull();
  });

  it('the windows are [now − N days, now]', () => {
    expect(historyStats([e(7, 10), e(-0.001, 99)], NOW, 'lower')).toMatchObject({ mean7d: 10, best30d: 10 });
    expect(historyStats([e(7.001, 10)], NOW, 'higher')).toMatchObject({ mean7d: null, best30d: 10 });
    expect(historyStats([e(30, 5), e(30.001, 1)], NOW, 'lower')).toMatchObject({ best: 1, best30d: 5 });
  });
});

describe('mainVariant', () => {
  const entry: HistoryEntry = { at: ago(1), value: 30, L: 5, length: null, norms: [] };

  it('names the variant the progress screen shows', () => {
    const empty: BlockHistory = new Map();
    expect(mainVariant('gorbov', empty)).toBe('gorbov:alternate');
    expect(mainVariant('memory', empty)).toBe('memory:digits');
    expect(mainVariant('pzmr', empty)).toBe('pzmr');
    expect(mainVariant('numseries', empty)).toBe('numseries');
    expect(mainVariant('schulte', empty)).toBeNull();
  });

  it('Шульте: the largest grid with entries', () => {
    const h: BlockHistory = new Map([
      ['schulte:5', [entry]],
      ['schulte:7', [entry]],
      ['schulte:9', []],
      ['gorbov:alternate', [entry]],
    ]);
    expect(mainVariant('schulte', h)).toBe('schulte:7');
    expect(mainVariant('schulte', new Map([['schulte:10', [entry]], ['schulte:9', [entry]]]))).toBe('schulte:10');
    expect(mainVariant('schulte', new Map([['schulte:abc', [entry]]]))).toBeNull();
  });
});
