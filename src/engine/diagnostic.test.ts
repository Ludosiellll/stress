import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_VOLUME,
  EMPTY_METRICS,
  EMPTY_RESULTS,
  SERIES_FORMS,
  diagnosticSegmentSeed,
  diagnosticSeriesSchedule,
  diagnosticSeriesSeed,
  isReactionId,
  parseResults,
  planDiagnostic,
  type DiagnosticResults,
} from './diagnostic';
import { hashString } from './rng';

/** The six segments of the 0.1.0 diagnostic, as 0.1.0 played them (order, fixedL, volumes). */
const W1_SEGMENTS = [
  { module: 'pzmr', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, trialCount: 50, practiceTrials: 5 },
  { module: 'szmr', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, trialCount: 70, practiceTrials: 5 },
  { module: 'gonogo', budgetMs: 0, purpose: 'diagnostic', fixedL: 10, trialCount: 60, practiceTrials: 5 },
  { module: 'rdo', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, trialCount: 50, practiceTrials: 5 },
  { module: 'gorbov', budgetMs: 0, purpose: 'diagnostic', fixedL: 0, runs: 3 },
  { module: 'numseries', budgetMs: 0, purpose: 'diagnostic', items: 20, totalTimeLimitMs: 600000 },
];

describe('planDiagnostic', () => {
  it('W1 segments are unchanged', () => {
    const plan = planDiagnostic(3);
    expect(plan.kind).toBe('diagnostic');
    expect(plan.diagnosticNumber).toBe(3);
    expect(plan.seed).toBe(hashString('diag:3'));
    expect(plan.segments.slice(0, 6)).toEqual(W1_SEGMENTS);
    // Block seeds hash the number and the module only, so the W1 tables and series of diagnostic n stay the same.
    expect(diagnosticSegmentSeed(3, 'gorbov')).toBe(hashString('diag:3:gorbov'));
  });

  it('the W2 segments follow the number series (П8)', () => {
    expect(planDiagnostic(3).segments.slice(6)).toEqual([
      { module: 'pomeh', budgetMs: 0, purpose: 'diagnostic', fixedL: 8, trialCount: 40, practiceTrials: 5 },
      { module: 'stroop', budgetMs: 0, purpose: 'diagnostic', fixedL: 8, trialCount: 48, practiceTrials: 5 },
      { module: 'taskswitch', budgetMs: 0, purpose: 'diagnostic', fixedL: 5, trialCount: 48, practiceTrials: 5 },
      { module: 'memory', budgetMs: 0, purpose: 'diagnostic' },
    ]);
  });

  it('takes its seeds from seedIndex, which defaults to the number (I5)', () => {
    expect(planDiagnostic(3)).toMatchObject({ diagnosticNumber: 3, diagnosticSeedIndex: 3 });
    const later = planDiagnostic(2, 5);
    expect(later).toMatchObject({ diagnosticNumber: 2, diagnosticSeedIndex: 5, seed: hashString('diag:5') });
    expect(later.segments).toEqual(planDiagnostic(2).segments);
  });

  it('DIAGNOSTIC_VOLUME: 50+5, 70+5, 60+5, 50+5, 40+5, 48+5, 48+5 at the 0.2.0 levels', () => {
    expect(DIAGNOSTIC_VOLUME).toEqual({
      pzmr: { fixedL: 0, trialCount: 50, practiceTrials: 5 },
      szmr: { fixedL: 0, trialCount: 70, practiceTrials: 5 },
      gonogo: { fixedL: 10, trialCount: 60, practiceTrials: 5 },
      rdo: { fixedL: 0, trialCount: 50, practiceTrials: 5 },
      pomeh: { fixedL: 8, trialCount: 40, practiceTrials: 5 },
      stroop: { fixedL: 8, trialCount: 48, practiceTrials: 5 },
      taskswitch: { fixedL: 5, trialCount: 48, practiceTrials: 5 },
    });
    expect(Object.isFrozen(DIAGNOSTIC_VOLUME) && Object.values(DIAGNOSTIC_VOLUME).every(Object.isFrozen)).toBe(true);
    // planDiagnostic reads it: the reaction segments carry exactly these volumes.
    const reaction = planDiagnostic(1).segments.flatMap(({ module }) => (isReactionId(module) ? [module] : []));
    expect(reaction).toEqual(['pzmr', 'szmr', 'gonogo', 'rdo', 'pomeh', 'stroop', 'taskswitch']);
    for (const module of reaction) {
      expect(planDiagnostic(1).segments.find((s) => s.module === module)).toEqual({
        module,
        budgetMs: 0,
        purpose: 'diagnostic',
        ...DIAGNOSTIC_VOLUME[module],
      });
    }
  });

  it('is deterministic and number-dependent', () => {
    expect(planDiagnostic(1)).toEqual(planDiagnostic(1));
    expect(planDiagnostic(1).seed).not.toBe(planDiagnostic(2).seed);
  });
});

describe('diagnosticSegmentSeed', () => {
  it('hashes diag:n:module', () => {
    expect(diagnosticSegmentSeed(3, 'rdo')).toBe(hashString('diag:3:rdo'));
    expect(diagnosticSegmentSeed(3, 'rdo')).not.toBe(diagnosticSegmentSeed(3, 'szmr'));
  });
});

describe('diagnosticSeriesSchedule (F12)', () => {
  it('the 20 items of spec §4.8: the 11 training families once, the 3 held-out ones three times, targetD 900…1470', () => {
    const s = diagnosticSeriesSchedule();
    expect(s.map((e) => e.family)).toEqual([
      'arith', 'letters', 'digitsum', 'geom', 'addsub', 'powstep', 'second', 'primes', 'twostep', 'alt',
      'digitsum', 'fib', 'powstep', 'linrec', 'twostep', 'powers', 'digitsum', 'opcycle', 'powstep', 'twostep',
    ]);
    expect(s.map((e) => e.targetD)).toEqual(Array.from({ length: 20 }, (_, i) => 900 + 30 * i));
    expect(s[19]).toEqual({ family: 'twostep', targetD: 1470 });
    // R_FORMAT of the assessment plan rests on the mean targetD: 1185, as before.
    expect(s.reduce((sum, e) => sum + e.targetD, 0) / s.length).toBe(1185);
  });
});

describe('diagnosticSeriesSeed (F12)', () => {
  it('six fixed forms: seedIndex 1…6 play forms 0…5, seedIndex 7 form 0 again', () => {
    expect(SERIES_FORMS).toBe(6);
    expect([1, 2, 3, 4, 5, 6, 7, 13].map((seedIndex) => diagnosticSeriesSeed(seedIndex, 4))).toEqual(
      [0, 1, 2, 3, 4, 5, 0, 0].map((form) => hashString(`series-form:${String(form)}:4`)),
    );
    expect(diagnosticSeriesSeed(1, 1)).toBe(hashString('series-form:0:1'));
    expect(diagnosticSeriesSeed(6, 20)).toBe(hashString('series-form:5:20'));
    // Every item of a form has a seed of its own.
    expect(new Set(Array.from({ length: 20 }, (_, i) => diagnosticSeriesSeed(2, i + 1))).size).toBe(20);
  });
});

const EMPTY: DiagnosticResults = EMPTY_RESULTS;

describe('parseResults', () => {
  it('reads rows stored before `unreliable` existed as reliable', () => {
    const old = Object.fromEntries(Object.entries({ ...EMPTY, pzmrMedianRt: 300 }).filter(([k]) => k !== 'unreliable'));
    expect(parseResults({ resultsJson: JSON.stringify(old) })).toEqual({ ...EMPTY, pzmrMedianRt: 300, unreliable: [] });
  });

  it('a missing metric reads as null', () => {
    expect(parseResults({ resultsJson: '{}' })).toEqual(EMPTY);
  });

  it('a 0.1.0 row reads with the W2 metrics null, never zero', () => {
    const w1 = {
      pzmrMedianRt: 300,
      szmrMedianRt: 450,
      gonogoScore: 90,
      rdoMeanAbsErrorMs: 40,
      gorbov: { V: 30, P: 60, Pi: 10 },
      numseriesCorrect: 14,
      unreliable: [],
    };
    expect(parseResults({ resultsJson: JSON.stringify(w1) })).toEqual({
      ...w1,
      pzmrMeanRt: null,
      szmrMeanRt: null,
      pzmrSdRt: null,
      szmrSdRt: null,
      pzmrIqrRt: null,
      szmrIqrRt: null,
      pzmrFalseStarts: null,
      szmrFalseStarts: null,
      szmrWrong: null,
      gonogoCommissions: null,
      gonogoOmissions: null,
      rdoEarly: null,
      rdoLate: null,
      rdoSignedBiasMs: null,
      pomehQuietRt: null,
      pomehNoisyRt: null,
      pomehDeltaMs: null,
      stroopCongruentRt: null,
      stroopIncongruentRt: null,
      stroopInterferenceMs: null,
      switchRepeatRt: null,
      switchSwitchRt: null,
      switchCostMs: null,
      memorySpan: null,
      restarts: {},
      // A row before 0.3.0 played Горбов on three tables (F10) and the old number series (F12).
      gorbovOneTable: false,
      seriesForm: null,
    });
  });

  it('old previous rows read their missing metrics as null', () => {
    // A 0.2.0 row: every metric but the mean RTs added in 0.3.0.
    const w2 = Object.fromEntries(Object.entries({ ...EMPTY, pzmrMedianRt: 300, szmrMedianRt: 450, memorySpan: 7 }).filter(([k]) => !k.endsWith('MeanRt')));
    expect(Object.keys(w2)).not.toContain('pzmrMeanRt');
    const r = parseResults({ resultsJson: JSON.stringify(w2) });
    expect(r).toEqual({ ...EMPTY, pzmrMedianRt: 300, szmrMedianRt: 450, memorySpan: 7 });
    expect(r?.pzmrMeanRt).toBeNull();
    expect(r?.szmrMeanRt).toBeNull();
  });

  it('old rows read the F7 metrics as null', () => {
    // A row stored before F7: every earlier metric, none of the SD, IQR and error counts.
    const f7 = [
      'pzmrSdRt',
      'szmrSdRt',
      'pzmrIqrRt',
      'szmrIqrRt',
      'pzmrFalseStarts',
      'szmrFalseStarts',
      'szmrWrong',
      'gonogoCommissions',
      'gonogoOmissions',
      'rdoEarly',
      'rdoLate',
      'rdoSignedBiasMs',
    ] as const;
    const before = { ...EMPTY, pzmrMedianRt: 300, pzmrMeanRt: 310, gonogoScore: 90, memorySpan: 7 };
    const old = Object.fromEntries(Object.entries(before).filter(([k]) => !(f7 as readonly string[]).includes(k)));
    expect(Object.keys(old)).not.toContain('pzmrSdRt');
    const r = parseResults({ resultsJson: JSON.stringify(old) });
    expect(r).toEqual(before);
    for (const k of f7) expect(r?.[k], k).toBeNull();
    // A row with them keeps them; a damaged one reads null.
    const now = parseResults({ resultsJson: JSON.stringify({ ...before, pzmrSdRt: 38.5, szmrWrong: 2, rdoSignedBiasMs: -6.2, gonogoOmissions: '1' }) });
    expect(now).toMatchObject({ pzmrSdRt: 38.5, szmrWrong: 2, rdoSignedBiasMs: -6.2, gonogoOmissions: null });
  });

  it('EMPTY_RESULTS: every metric missing, nothing unreliable, no restarts, three Горбов tables, the old series; frozen', () => {
    expect(EMPTY_RESULTS).toEqual({ ...EMPTY_METRICS, unreliable: [], restarts: {}, gorbovOneTable: false, seriesForm: null });
    expect(Object.isFrozen(EMPTY_RESULTS)).toBe(true);
    expect(Object.isFrozen(EMPTY_RESULTS.unreliable)).toBe(true);
    expect(Object.isFrozen(EMPTY_RESULTS.restarts)).toBe(true);
  });

  it('a row stored before F11 reads its restarts as {}', () => {
    const old = Object.fromEntries(Object.entries({ ...EMPTY, pzmrMedianRt: 300 }).filter(([k]) => k !== 'restarts'));
    expect(old).not.toHaveProperty('restarts');
    expect(parseResults({ resultsJson: JSON.stringify(old) })?.restarts).toEqual({});
  });

  it('keeps the restarts of each module (F11)', () => {
    const restarts = { pzmr: { user: 1, focus: 2 }, gorbov: { user: 2, focus: 0 } };
    expect(parseResults({ resultsJson: JSON.stringify({ ...EMPTY, restarts }) })?.restarts).toEqual(restarts);
  });

  it('damaged restarts: an entry of an unknown module or not an object is dropped, a bad count reads 0 (T-R22)', () => {
    const read = (restarts: unknown): unknown => parseResults({ resultsJson: JSON.stringify({ ...EMPTY, restarts }) })?.restarts;
    for (const bad of ['x', 3, null, [], [{ user: 1, focus: 0 }]]) expect(read(bad), JSON.stringify(bad)).toEqual({});
    expect(
      read({
        pzmr: { user: 1, focus: 0 },
        tetris: { user: 1, focus: 1 },
        szmr: 'x',
        stroop: null,
        gonogo: { user: -1, focus: 2 },
        rdo: { user: 1.5, focus: 'a' },
        memory: { focus: 3 },
        gorbov: { user: 0, focus: 0 },
        schulte: [1, 2],
      }),
    ).toEqual({ pzmr: { user: 1, focus: 0 }, gonogo: { user: 0, focus: 2 }, memory: { user: 0, focus: 3 } });
  });

  it('a row stored before F10 played Горбов on three tables: gorbovOneTable reads false', () => {
    const old = Object.fromEntries(Object.entries({ ...EMPTY, gorbov: { V: 40, P: 80, Pi: 0 } }).filter(([k]) => k !== 'gorbovOneTable'));
    expect(old).not.toHaveProperty('gorbovOneTable');
    expect(parseResults({ resultsJson: JSON.stringify(old) })?.gorbovOneTable).toBe(false);
    expect(parseResults({ resultsJson: JSON.stringify({ ...EMPTY, gorbovOneTable: true }) })?.gorbovOneTable).toBe(true);
  });

  it('a damaged gorbovOneTable reads false (T-R22)', () => {
    for (const bad of ['true', 1, null, [], {}, [true], 'yes']) {
      expect(parseResults({ resultsJson: JSON.stringify({ ...EMPTY, gorbovOneTable: bad }) })?.gorbovOneTable, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a row stored before F12 played the old number series: seriesForm reads null', () => {
    const old = Object.fromEntries(Object.entries({ ...EMPTY, numseriesCorrect: 14 }).filter(([k]) => k !== 'seriesForm'));
    expect(old).not.toHaveProperty('seriesForm');
    expect(parseResults({ resultsJson: JSON.stringify(old) })?.seriesForm).toBeNull();
    expect(parseResults({ resultsJson: JSON.stringify({ ...EMPTY, seriesForm: 'v2' }) })?.seriesForm).toBe('v2');
  });

  it('a damaged seriesForm reads null (T-R22)', () => {
    for (const bad of ['v1', 'V2', 'v3', 2, true, null, [], {}, ['v2']]) {
      expect(parseResults({ resultsJson: JSON.stringify({ ...EMPTY, seriesForm: bad }) })?.seriesForm, JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps only reaction module ids in `unreliable`', () => {
    expect(parseResults({ resultsJson: JSON.stringify({ ...EMPTY, unreliable: ['rdo', 'gorbov', 7, 'pzmr'] }) })?.unreliable).toEqual(['rdo', 'pzmr']);
  });

  it('null for JSON that is not an object', () => {
    expect(parseResults({ resultsJson: 'not json' })).toBeNull();
    expect(parseResults({ resultsJson: '42' })).toBeNull();
  });

  it('a damaged or imported row: every metric is a finite number or null, Горбов needs V, P and Π (FW9)', () => {
    expect(parseResults({ resultsJson: '{"gorbov":{"V":40}}' })).toEqual(EMPTY);
    expect(parseResults({ resultsJson: '{"gorbov":{"V":40,"P":"60","Pi":10}}' })?.gorbov).toBeNull();
    expect(parseResults({ resultsJson: '{"gorbov":[40,60,10]}' })?.gorbov).toBeNull();
    expect(parseResults({ resultsJson: '{"gorbov":{"V":40,"P":60,"Pi":-10,"extra":1}}' })?.gorbov).toEqual({ V: 40, P: 60, Pi: -10 });
    expect(parseResults({ resultsJson: '{"pzmrMedianRt":"281","szmrMedianRt":true,"memorySpan":{},"rdoMeanAbsErrorMs":1e999}' })).toEqual(EMPTY);
    expect(parseResults({ resultsJson: '{"pzmrMedianRt":281,"number":3}' })).toEqual({ ...EMPTY, pzmrMedianRt: 281 });
  });
});
