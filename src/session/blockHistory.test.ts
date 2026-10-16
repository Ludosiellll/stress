import { describe, expect, it } from 'vitest';
import { block, session } from '../data/repository.contract';
import { pzmr } from '../modules/reaction/pzmr';
import { szmr } from '../modules/reaction/szmr';
import type { BlockRow } from '../data/rows';
import type { ModuleId } from '../engine/types';
import {
  appendBlock,
  buildBlockHistory,
  entersHistory,
  historyEntry,
  historyStats,
  isTwoChoice,
  keyMetric,
  KEY_METRICS,
  mainVariant,
  normSamples,
  schulteSize,
  scoreFromCounts,
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

describe('band variants (Р29, T-R7)', () => {
  it('a band module\'s block is a variant of its band; a warm-up stays the warm-up; a row without a band keeps the bare key', () => {
    expect(variantOf(row({ module: 'szmr', paramsJson: '{"band":2,"windowMs":431}' }))).toBe('szmr:b2');
    expect(variantOf(row({ module: 'pzmr', paramsJson: '{"band":0}' }))).toBe('pzmr:b0');
    expect(variantOf(row({ module: 'taskswitch', paramsJson: '{"band":12}' }))).toBe('taskswitch:b12');
    // An overload block is the variant of the band it played the window of (it never enters the history).
    expect(variantOf(row({ module: 'gonogo', flags: ['overload'], paramsJson: '{"band":3,"loadBand":4}' }))).toBe('gonogo:b3');
    expect(variantOf(row({ module: 'pzmr', flags: ['warmup'], paramsJson: '{"band":1}' }))).toBe('pzmr:warmup');
    expect(variantOf(row({ module: 'pzmr', paramsJson: '{"windowMs":300}' }))).toBe('pzmr');
    // Damaged: unreadable parameters, a band that is no whole number from 0.
    for (const paramsJson of ['not json', '{"band":"2"}', '{"band":2.5}', '{"band":-1}', '{"band":null}']) {
      expect(variantOf(row({ module: 'stroop', paramsJson })), paramsJson).toBe('stroop');
    }
    // Modules without bands keep their variants.
    expect(variantOf(row({ module: 'rdo', paramsJson: '{"band":2}' }))).toBe('rdo');
    expect(variantOf(row({ module: 'schulte', paramsJson: '{"band":2,"size":6}' }))).toBe('schulte:6');
  });

  it('the history of a band module is kept by band', () => {
    const sessions = [session('t', ago(9))];
    const pz = (band: number | null, meanRt: number): BlockRow =>
      row({ module: 'pzmr', paramsJson: band === null ? '{"windowMs":300}' : JSON.stringify({ band }), summaryJson: JSON.stringify({ meanRt }) });
    const h = buildBlockHistory([pz(null, 300), pz(2, 280), pz(3, 290), pz(2, 270)], sessions);
    expect([...h].map(([k, v]) => [k, v.map((x) => x.value)])).toEqual([
      ['pzmr', [300]],
      ['pzmr:b2', [280, 270]],
      ['pzmr:b3', [290]],
    ]);
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
    // 0,4 ms shows as 0 ms: out of range (A-R16).
    expect(keyMetric({ module: 'gonogo', summaryJson: '{"meanRt":0.4}' })).toBeNull();
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

  it('rejects out-of-range values of damaged or imported rows (A-R16)', () => {
    for (const bad of ['{"meanRt":0}', '{"meanRt":-5}']) {
      for (const module of ['pzmr', 'szmr', 'gonogo'] as const) expect(keyMetric({ module, summaryJson: bad })).toBeNull();
    }
    expect(keyMetric({ module: 'rdo', summaryJson: '{"meanAbsErrorMs":-1}' })).toBeNull();
    expect(keyMetric({ module: 'rdo', summaryJson: '{"meanAbsErrorMs":0}' })).toBe(0);
    expect(keyMetric({ module: 'gorbov', summaryJson: '{"timeMs":-5}' })).toBeNull();
    expect(keyMetric({ module: 'schulte', summaryJson: '{"timeMs":0}' })).toBeNull();
    const cond = (f: number, s: number): string => JSON.stringify({ conditions: { congruent: { medianRt: f }, incongruent: { medianRt: s } } });
    expect(keyMetric({ module: 'stroop', summaryJson: cond(0, 600) })).toBeNull();
    expect(keyMetric({ module: 'stroop', summaryJson: cond(500, -1) })).toBeNull();
    expect(keyMetric({ module: 'memory', summaryJson: '{"exact":9,"answers":[1]}' })).toBeNull();
    expect(keyMetric({ module: 'memory', summaryJson: '{"exact":-1,"answers":[1,2]}' })).toBeNull();
    expect(keyMetric({ module: 'memory', summaryJson: '{"exact":2,"answers":[1,2]}' })).toBe(100);
    expect(keyMetric({ module: 'numseries', summaryJson: '{"correct":11,"total":10}' })).toBeNull();
    expect(keyMetric({ module: 'numseries', summaryJson: '{"correct":-1,"total":10}' })).toBeNull();
    expect(keyMetric({ module: 'numseries', summaryJson: '{"correct":0,"total":10}' })).toBe(0);
  });

  it('a stored 0 ms is never «лучший»: the row stays out of the history (A-R16)', () => {
    const blocks = [row({ module: 'pzmr', summaryJson: '{"meanRt":0}' }), row({ module: 'pzmr', summaryJson: '{"meanRt":280}' })];
    expect(buildBlockHistory(blocks, [{ id: 't', kind: 'training' }]).get('pzmr')?.map((e) => e.value)).toEqual([280]);
  });

  it('has a key metric description for every module', () => {
    const ms = { unit: 'мс', better: 'lower', signed: false };
    const cost = { unit: 'мс', better: 'lower', signed: true };
    const seconds = { unit: 'с', better: 'lower', signed: false };
    const percent = { unit: '%', better: 'higher', signed: false };
    expect(KEY_METRICS).toEqual({
      pzmr: ms,
      szmr: ms,
      gonogo: ms,
      rdo: ms,
      gorbov: seconds,
      schulte: seconds,
      stroop: cost,
      taskswitch: cost,
      pomeh: cost,
      memory: percent,
      numseries: percent,
    });
  });

  it('a row of a module it does not know has no number and no entry', () => {
    const odd = row({ module: 'tapping' as ModuleId, summaryJson: '{"meanRt":300}' });
    expect(keyMetric(odd)).toBeNull();
    expect(buildBlockHistory([odd], SESSIONS).size).toBe(0);
  });

  it('a "__proto__" key in stored JSON is a plain field, never an inherited value', () => {
    expect(keyMetric({ module: 'pzmr', summaryJson: '{"__proto__":{"meanRt":300}}' })).toBeNull();
    expect(keyMetric({ module: 'stroop', summaryJson: '{"conditions":{"__proto__":{"congruent":{"medianRt":500},"incongruent":{"medianRt":580}}}}' })).toBeNull();
    expect(variantOf(row({ module: 'schulte', paramsJson: '{"__proto__":{"size":6}}' }))).toBeNull();
    expect(variantOf(row({ module: 'gorbov', paramsJson: '{"task":"__proto__"}', summaryJson: '{"task":"constructor"}' }))).toBeNull();
    expect(variantOf(memory({ mode: 'toString' }))).toBeNull();
  });
});

describe('normSamples', () => {
  it('ПЗМР: the mean first, then the SD', () => {
    expect(normSamples(row({ module: 'pzmr', summaryJson: '{"meanRt":262.4,"sdRt":50.2}' }), 'diagnostic')).toEqual([
      { id: 'pzmrMean', value: 262 },
      { id: 'pzmrSd', value: 50 },
    ]);
    expect(normSamples(row({ module: 'pzmr', summaryJson: '{"meanRt":262.4,"sdRt":null}' }), 'diagnostic')).toEqual([{ id: 'pzmrMean', value: 262 }]);
    expect(normSamples(row({ module: 'pzmr', summaryJson: 'not json' }), 'diagnostic')).toEqual([]);
  });

  it('ПЗМР and СЗМР in training: norms only for a block answered in time, never for overload (FW2)', () => {
    const reaction = (module: 'pzmr' | 'szmr', counts: object | null, over: Partial<BlockRow> = {}): BlockRow =>
      row({ module, lBefore: 5, summaryJson: JSON.stringify({ meanRt: 262.4, sdRt: 50.2, ...(counts === null ? {} : { counts }) }), ...over });
    const clean = { hit: 15, miss: 0, late: 0, false_start: 1 };
    expect(normSamples(reaction('pzmr', clean), 'training')).toEqual([
      { id: 'pzmrMean', value: 262 },
      { id: 'pzmrSd', value: 50 },
    ]);
    expect(normSamples(reaction('szmr', clean), 'free')).toEqual([{ id: 'szmrMean', value: 262 }]);
    for (const module of ['pzmr', 'szmr'] as const) {
      expect(normSamples(reaction(module, { ...clean, late: 1 }), 'training'), `${module}: late`).toEqual([]);
      expect(normSamples(reaction(module, { ...clean, miss: 1 }), 'free'), `${module}: miss`).toEqual([]);
      expect(normSamples(reaction(module, clean, { flags: ['overload'] }), 'training'), `${module}: overload`).toEqual([]);
      expect(normSamples(reaction(module, null), 'training'), `${module}: no counts`).toEqual([]);
      // The diagnostic window is wide: its norms stay.
      expect(normSamples(reaction(module, { ...clean, miss: 1 }), 'diagnostic')).not.toEqual([]);
    }
  });

  it('ПЗМР and СЗМР in training: the published norms grade only a block without noise and sound (T-R23)', () => {
    const clean = { hit: 15, miss: 0, late: 0 };
    const played = (module: 'pzmr' | 'szmr', paramsJson: string): BlockRow =>
      row({ module, lBefore: 5, paramsJson, summaryJson: JSON.stringify({ meanRt: 262.4, sdRt: 50.2, counts: clean }) });
    const norms = [
      { id: 'pzmrMean', value: 262 },
      { id: 'pzmrSd', value: 50 },
    ];
    // Band 0: a quiet screen. Band 3 (L 12): far figures; band 4 (L 16): figures and sound.
    expect(pzmr.params(0)).toMatchObject({ noise: null, audio: null });
    expect(normSamples(played('pzmr', JSON.stringify(pzmr.params(0))), 'training')).toEqual(norms);
    expect(pzmr.params(12)).toMatchObject({ noise: { farOnly: true }, audio: null });
    expect(normSamples(played('pzmr', JSON.stringify(pzmr.params(12))), 'training')).toEqual([]);
    expect(pzmr.params(16).audio).not.toBeNull();
    expect(normSamples(played('pzmr', JSON.stringify(pzmr.params(16))), 'free')).toEqual([]);
    // A 2-choice СЗМР block with sound (a damaged or future row) is not graded either.
    expect(normSamples(played('szmr', '{"nColors":2,"nKeys":2}'), 'training')).toEqual([{ id: 'szmrMean', value: 262 }]);
    expect(normSamples(played('szmr', '{"nColors":2,"nKeys":2,"audio":{"layers":["hum"],"gain":0.5}}'), 'training')).toEqual([]);
    // Read defensively: a damaged value, or parameters that cannot be read, leave the block ungraded; an old row without
    // the fields is quiet.
    expect(normSamples(played('pzmr', '{"windowMs":300,"noise":"x"}'), 'training')).toEqual([]);
    expect(normSamples(played('pzmr', '{"windowMs":300,"audio":0}'), 'training')).toEqual([]);
    expect(normSamples(played('pzmr', 'not json'), 'training')).toEqual([]);
    expect(normSamples(played('pzmr', '{"windowMs":300}'), 'training')).toEqual(norms);
    // A diagnostic plays the frozen 0.2.0 parameters: graded as before, whatever the row says.
    expect(normSamples(played('pzmr', JSON.stringify(pzmr.params(16))), 'diagnostic')).toEqual(norms);
  });

  it('СЗМР: the 2-choice norm only for 2 colours on 2 keys, by the parameters of its level', () => {
    expect(normSamples(row({ module: 'szmr', lBefore: 7.9, summaryJson: '{"meanRt":401.6}' }), 'diagnostic')).toEqual([{ id: 'szmrMean', value: 402 }]);
    expect(normSamples(row({ module: 'szmr', lBefore: 8, summaryJson: '{"meanRt":401.6}' }), 'diagnostic')).toEqual([]);
    expect(normSamples(row({ module: 'szmr', lBefore: 0, summaryJson: '{"meanRt":null}' }), 'diagnostic')).toEqual([]);
    // Today level 8 is where СЗМР adds the third colour.
    expect([szmr.params(7.9), szmr.params(8)].map((p) => [p.nColors, p.nKeys])).toEqual([
      [2, 2],
      [3, 2],
    ]);
    expect([isTwoChoice(szmr.params(7.9)), isTwoChoice(szmr.params(8))]).toEqual([true, false]);
  });

  it('СЗМР: the parameters the block was played with come first (FW8)', () => {
    const played = (lBefore: number, nColors: number, nKeys: number): BlockRow =>
      row({ module: 'szmr', lBefore, paramsJson: JSON.stringify({ windowMs: 700, nColors, nKeys }), summaryJson: '{"meanRt":401.6}' });
    expect(normSamples(played(9, 2, 2), 'diagnostic')).toEqual([{ id: 'szmrMean', value: 402 }]);
    expect(normSamples(played(5, 3, 2), 'diagnostic')).toEqual([]);
    expect(normSamples(played(5, 2, 3), 'diagnostic')).toEqual([]);
  });

  it('Горбов: by task, only a finished table', () => {
    expect(normSamples(table('black_up', 44_000), 'training')).toEqual([{ id: 'gorbovSimple', value: 44 }]);
    expect(normSamples(table('red_down', 36_960), 'training')).toEqual([{ id: 'gorbovSimple', value: 37 }]);
    expect(normSamples(table('alternate', 150_240), 'training')).toEqual([{ id: 'gorbovAlternate', value: 150.2 }]);
    expect(normSamples(table('alternate', null), 'training')).toEqual([]);
    expect(normSamples(row({ module: 'gorbov', paramsJson: '{}', summaryJson: '{"timeMs":44000}' }), 'training')).toEqual([]);
  });

  it('память: digits, all 6 answers and at least 4 exact give the row length', () => {
    expect(normSamples(memory({ mode: 'digits', length: 7, exact: 4, answers: answers(6) }), 'training')).toEqual([{ id: 'memorySpan', value: 7 }]);
    expect(normSamples(memory({ mode: 'digits', length: 7, exact: 3, answers: answers(6) }), 'training')).toEqual([]);
    expect(normSamples(memory({ mode: 'letters', length: 7, exact: 6, answers: answers(6) }), 'training')).toEqual([]);
    expect(normSamples(memory({ mode: 'digits', length: 7, exact: 3, answers: answers(3) }), 'training')).toEqual([]);
    expect(normSamples(memory({ mode: 'digits', length: 'x', exact: 6, answers: answers(6) }), 'training')).toEqual([]);
  });

  it('память: the span protocol gives its span', () => {
    expect(normSamples(memory({ protocol: 'span', mode: 'digits', exact: 9, span: 8, answers: answers(14) }), 'diagnostic')).toEqual([
      { id: 'memorySpan', value: 8 },
    ]);
    expect(normSamples(memory({ protocol: 'span', mode: 'digits', exact: 0, span: null, answers: answers(2) }), 'diagnostic')).toEqual([]);
  });

  it('out-of-range values get no norm: a 0 ms mean never grades «высокий» (A-R16)', () => {
    expect(normSamples(row({ module: 'pzmr', summaryJson: '{"meanRt":0,"sdRt":-3}' }), 'diagnostic')).toEqual([]);
    expect(normSamples(row({ module: 'pzmr', summaryJson: '{"meanRt":262,"sdRt":0}' }), 'diagnostic')).toEqual([
      { id: 'pzmrMean', value: 262 },
      { id: 'pzmrSd', value: 0 },
    ]);
    expect(normSamples(row({ module: 'szmr', lBefore: 0, summaryJson: '{"meanRt":-1}' }), 'diagnostic')).toEqual([]);
    expect(normSamples(table('black_up', 0), 'training')).toEqual([]);
    expect(normSamples(memory({ mode: 'digits', length: 7, exact: 9, answers: answers(6) }), 'training')).toEqual([]);
    expect(normSamples(memory({ mode: 'digits', length: 0, exact: 6, answers: answers(6) }), 'training')).toEqual([]);
    expect(normSamples(memory({ protocol: 'span', mode: 'digits', exact: 9, span: -2, answers: answers(14) }), 'diagnostic')).toEqual([]);
  });

  it('РДО and Струп have no norm', () => {
    expect(normSamples(row({ module: 'rdo', summaryJson: '{"meanAbsErrorMs":18.4}' }), 'training')).toEqual([]);
    expect(normSamples(row({ module: 'stroop', summaryJson: '{"meanRt":500}' }), 'training')).toEqual([]);
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

  it('a block counted as 0 after Esc stays out (Р29): it measured nothing', () => {
    expect(entersHistory(['discarded'], 'training')).toBe(false);
    expect(entersHistory(['warmup', 'discarded'], 'free')).toBe(false);
    // A counted number-series block keeps its answered items: its summary would read, so the flag alone keeps it out.
    const series = row({ module: 'numseries', flags: ['discarded'], summaryJson: '{"correct":3,"total":10}' });
    expect(keyMetric(series)).toBe(30);
    expect(buildBlockHistory([series, { ...series, id: 'kept', flags: [] }], [session('t', ago(1))]).get('numseries')).toHaveLength(1);
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

  it('a test-format run goes to its own variant {module}:test (F4, Р29): never the main variant or its «лучший»', () => {
    const run = (module: ModuleId, summaryJson: string, startedAt: string): BlockRow =>
      row({ module, flags: ['test_format'], paramsJson: '{"band":0,"trials":50}', summaryJson, startedAt });
    for (const module of ['pzmr', 'szmr', 'gonogo', 'rdo'] as const) {
      expect(variantOf(run(module, '{}', ago(1)))).toBe(`${module}:test`);
      expect(variantOf({ ...run(module, '{}', ago(1)), flags: ['test_format', 'timing_unreliable'] })).toBe(`${module}:test`);
    }
    const regular = row({ module: 'szmr', paramsJson: '{"band":0}', summaryJson: '{"meanRt":400}', startedAt: ago(3) });
    const h = buildBlockHistory(
      [regular, run('szmr', '{"meanRt":350}', ago(2)), run('rdo', '{"meanAbsErrorMs":20}', ago(1))],
      SESSIONS,
    );
    expect(h.get('szmr:test')?.map((e) => e.value)).toEqual([350]);
    expect(h.get('rdo:test')?.map((e) => e.value)).toEqual([20]);
    // The run is later, the main variant stays the band's.
    expect(mainVariant('szmr', h)).toBe('szmr:b0');
    expect(mainVariant('rdo', h)).toBe('rdo');
  });

  it('a warm-up block goes to its own variant pzmr:warmup (F5, Р29): never the main ПЗМР variant or its «лучший»', () => {
    const pzmrSummary = '{"meanRt":300,"sdRt":20,"counts":{"miss":0,"late":0}}';
    const warmup = row({ module: 'pzmr', flags: ['warmup'], lBefore: 5, summaryJson: '{"meanRt":250,"sdRt":20,"counts":{"miss":0,"late":0}}', startedAt: ago(2) });
    const regular = row({ module: 'pzmr', lBefore: 6, summaryJson: pzmrSummary, startedAt: ago(1) });
    expect(variantOf(warmup)).toBe('pzmr:warmup');
    expect(variantOf({ ...warmup, flags: ['warmup', 'fatigued'] })).toBe('pzmr:warmup');
    const h = buildBlockHistory([warmup, regular], SESSIONS);
    expect(h.get('pzmr:warmup')?.map((e) => [e.value, e.L])).toEqual([[250, 5]]);
    expect(h.get('pzmr')?.map((e) => e.value)).toEqual([300]);
    expect(mainVariant('pzmr', h)).toBe('pzmr');
    expect(historyStats(h.get(mainVariant('pzmr', h) ?? '') ?? [], NOW, 'lower')?.best).toBe(300);
  });

  it('unfinished tables have no number', () => {
    expect(historyEntry(table('alternate', null))).toBeNull();
  });

  it('memory entries keep the row length, whole as shown', () => {
    const r = memory({ mode: 'digits', length: 7, exact: 4, positionsCorrect: 36, answers: answers(6) }, { lBefore: 9, startedAt: ago(1) });
    expect(historyEntry(r)).toEqual({ at: ago(1), value: 67, L: 9, length: 7, norms: [{ id: 'memorySpan', value: 7 }] });
    expect(historyEntry(memory({ mode: 'letters', exact: 3, answers: answers(6) }))).toMatchObject({ value: 50, length: null });
    expect(historyEntry(memory({ mode: 'letters', length: 6.6, exact: 3, answers: answers(6) }))).toMatchObject({ length: 7 });
    expect(historyEntry(memory({ mode: 'letters', length: -2, exact: 3, answers: answers(6) }))).toMatchObject({ length: null });
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

  it('the grid size of a Шульте variant', () => {
    expect(schulteSize('schulte:6')).toBe(6);
    expect(schulteSize(variantOf(row({ module: 'schulte', paramsJson: '{"size":7}' })) ?? '')).toBe(7);
    expect(schulteSize('schulte:abc')).toBeNull();
    expect(schulteSize('schulte:')).toBeNull();
    expect(schulteSize('gorbov:alternate')).toBeNull();
  });

  it('a band module: the band variant with the latest entry; the bare key without one (Р29, T-R7)', () => {
    const at = (d: number): HistoryEntry => ({ ...entry, at: ago(d) });
    const h: BlockHistory = new Map([
      ['szmr', [at(20), at(10)]],
      ['szmr:b1', [at(9), at(3)]],
      ['szmr:b2', [at(6), at(4)]],
      ['szmr:b3', []],
      ['pzmr:warmup', [at(0)]],
      ['pzmr:b0', [at(5)]],
    ]);
    expect(mainVariant('szmr', h)).toBe('szmr:b1');
    // The warm-up never is the main variant.
    expect(mainVariant('pzmr', h)).toBe('pzmr:b0');
    // Only rows from before the bands: the bare key, also when there is nothing at all.
    expect(mainVariant('szmr', new Map([['szmr', [at(2)]]]))).toBe('szmr');
    expect(mainVariant('gonogo', h)).toBe('gonogo');
    // A bare entry later than every band entry (a restored old file) wins too.
    expect(mainVariant('szmr', new Map([['szmr:b1', [at(3)]], ['szmr', [at(1)]]]))).toBe('szmr');
    // An unreadable date is the earliest.
    expect(mainVariant('szmr', new Map([['szmr:b2', [{ ...entry, at: 'yesterday' }]], ['szmr:b1', [at(30)]]]))).toBe('szmr:b1');
    // РДО has no bands.
    expect(mainVariant('rdo', new Map([['rdo:b1', [at(1)]]]))).toBe('rdo');
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

describe('scoreFromCounts (T-R31, shared reader)', () => {
  const zero = { hit: 0, wrong: 0, miss: 0, late: 0, false_start: 0, commission: 0, correct_reject: 0, early: 0, timing_late: 0 };
  it('the penalised score from all nine stored counts; n is their sum', () => {
    expect(scoreFromCounts(JSON.stringify({ score: 0.85, counts: { ...zero, hit: 17, wrong: 2, false_start: 1 } }))).toBeCloseTo(0.65, 12);
    expect(scoreFromCounts(JSON.stringify({ counts: { ...zero, hit: 9, correct_reject: 3, commission: 1, early: 1 } }))).toBeCloseTo(10 / 14, 12);
  });
  it('null for missing, damaged or all-zero counts', () => {
    for (const text of ['not json', '{"score":0.9}', '{"counts":[1,2]}', JSON.stringify({ counts: zero })]) expect(scoreFromCounts(text), text).toBeNull();
    const eight = Object.fromEntries(Object.entries({ ...zero, hit: 5 }).filter(([k]) => k !== 'timing_late'));
    expect(scoreFromCounts(JSON.stringify({ counts: eight }))).toBeNull();
    expect(scoreFromCounts(JSON.stringify({ counts: { ...zero, hit: 5, wrong: 1.5 } }))).toBeNull();
    expect(scoreFromCounts(JSON.stringify({ counts: { ...zero, hit: 5, miss: -1 } }))).toBeNull();
  });
});
