import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { noiseFrame } from '../../engine/noise';
import { COLOR_IDS, type Stimulus } from '../../engine/reaction/types';
import { createRng } from '../../engine/rng';
import { BAND_MODULES, REACTION_MODULE_IDS, type BandModuleId } from '../../engine/types';
import { reactionModules } from '../registry';
import { NO_STRESSORS, bandIndex, stressorsOf, type LoadBand } from './common';
import { gonogo } from './gonogo';
import { pomeh } from './pomeh';
import { pzmr } from './pzmr';
import { rdo } from './rdo';
import { stroop } from './stroop';
import { szmr } from './szmr';
import { taskswitch } from './taskswitch';

/** The fields every band module's parameters carry (F3). */
interface BandParams {
  band: number;
  bandLabel: string;
  windowMs: number;
  trials: number;
}

const bandParams = (m: BandModuleId, L: number, loadBand?: number): BandParams & Record<string, unknown> =>
  reactionModules[m].params(L, loadBand) as BandParams & Record<string, unknown>;

/** Bands of the table: [label, chain]; the floor factor is 1.2. */
const table = (rows: ReadonlyArray<readonly [string, number]>): [string, number, number][] => rows.map(([label, chain]) => [label, chain, 1.2]);
/** The four tail bands after the table: the last load, chain 1.0, floor factors 1.15 / 1.10 / 1.05 / 1.00. */
const tail = (label: string): [string, number, number][] => [1.15, 1.1, 1.05, 1].map((f) => [label, 1, f]);

const PZMR_SOUND = 'интервал 0,3–3 с, помехи рядом, мерцание, звук';
const SZMR_NOISE = '6 цветов на 6 клавиш, форма, инверсия, звук, помехи';
const GONOGO_NOISE = 'no-go — круг с белой точкой, интервал 0,3–1 с, звук, помехи';
const POMEH_FOUR = 'выбор из двух, помехи рядом, мерцание, звук 4 слоя';
const STROOP_REVERSE = '4 цвета, интервал 0,3–1,2 с, обратное правило в рамке';
const SWITCH_UNCUED = '3 правила, смены без подсказки';

const LADDERS: Readonly<Record<BandModuleId, [string, number, number][]>> = {
  pzmr: [
    ...table([
      ['красный круг', 1],
      ['красный круг', 1],
      ['интервал 0,3–3 с', 1],
      ['интервал 0,3–3 с, помехи', 1.05],
      ['интервал 0,3–3 с, помехи, звук', 1.05],
      [PZMR_SOUND, 1.05],
      [`${PZMR_SOUND}, 30 сигналов`, 1],
      [`${PZMR_SOUND}, 45 сигналов`, 1],
      ['интервал 0,3–3 с, помехи рядом, мерцание, звук 4 слоя, 60 сигналов', 1],
    ]),
    ...tail('интервал 0,3–3 с, помехи рядом, мерцание, звук 4 слоя, 60 сигналов'),
  ],
  szmr: [
    ...table([
      ['2 цвета на 2 клавиши', 1],
      ['2 цвета на 2 клавиши', 1],
      ['3 цвета на 2 клавиши', 1.1],
      ['4 цвета на 4 клавиши', 1.1],
      ['4 цвета на 4 клавиши, отвлекающая форма', 1.05],
      ['5 цветов на 5 клавиш, отвлекающая форма', 1.1],
      ['6 цветов на 6 клавиш, отвлекающая форма', 1.1],
      ['6 цветов на 6 клавиш, форма, инверсия', 1.1],
      ['6 цветов на 6 клавиш, форма, инверсия, звук', 1.05],
      [SZMR_NOISE, 1.05],
      [`${SZMR_NOISE}, 30 сигналов`, 1],
      [`${SZMR_NOISE}, 45 сигналов`, 1],
      [`${SZMR_NOISE}, 60 сигналов`, 1],
    ]),
    ...tail(`${SZMR_NOISE}, 60 сигналов`),
  ],
  gonogo: [
    ...table([
      ['no-go 20 %, интервал 0,5–2,5 с', 1],
      ['no-go 20 %, интервал 0,5–2,5 с', 1],
      ['no-go 15 %, интервал 0,4–1,8 с', 1],
      ['no-go 15 %, интервал 0,3–1 с', 1],
      ['no-go — красный квадрат, интервал 0,3–1 с', 1.05],
      ['no-go — круг с белой точкой, интервал 0,3–1 с', 1.05],
      ['no-go — круг с белой точкой, интервал 0,3–1 с, звук', 1.05],
      [GONOGO_NOISE, 1.05],
      [`${GONOGO_NOISE}, 30 сигналов`, 1],
      [`${GONOGO_NOISE}, 45 сигналов`, 1],
      [`${GONOGO_NOISE}, 60 сигналов`, 1],
    ]),
    ...tail(`${GONOGO_NOISE}, 60 сигналов`),
  ],
  pomeh: [
    ...table([
      ['простая реакция, помехи далеко', 1],
      ['простая реакция, помехи далеко', 1],
      ['простая реакция, помехи рядом, мерцание, звук', 1.05],
      ['выбор из двух, помехи рядом, мерцание, звук', 1.1],
      ['выбор из двух, помехи рядом, мерцание, звук 2 слоя', 1.05],
      ['выбор из двух, помехи рядом, мерцание, звук 3 слоя', 1.05],
      [POMEH_FOUR, 1.05],
      [`${POMEH_FOUR}, 30 сигналов`, 1],
      [`${POMEH_FOUR}, 45 сигналов`, 1],
      [`${POMEH_FOUR}, 60 сигналов`, 1],
    ]),
    ...tail(`${POMEH_FOUR}, 60 сигналов`),
  ],
  stroop: [
    ...table([
      ['2 цвета, подсказка клавиш', 1],
      ['3 цвета, подсказка клавиш', 1.1],
      ['4 цвета без подсказки', 1.1],
      ['4 цвета, интервал 0,3–1,2 с', 1],
      [STROOP_REVERSE, 1.1],
      [`${STROOP_REVERSE}, звук`, 1.05],
      [`${STROOP_REVERSE}, звук, помехи`, 1.05],
      [`${STROOP_REVERSE}, звук, помехи, 30 сигналов`, 1],
      [`${STROOP_REVERSE}, звук, помехи, 45 сигналов`, 1],
      [`${STROOP_REVERSE}, звук, помехи, 60 сигналов`, 1],
    ]),
    ...tail(`${STROOP_REVERSE}, звук, помехи, 60 сигналов`),
  ],
  taskswitch: [
    ...table([
      ['2 правила, подсказка заранее', 1],
      ['2 правила, подсказка заранее', 1],
      ['3 правила, подсказка заранее', 1.1],
      ['3 правила, подсказка вместе с фигурой', 1.05],
      [SWITCH_UNCUED, 1.1],
      [`${SWITCH_UNCUED}, звук`, 1.05],
      [`${SWITCH_UNCUED}, звук, помехи`, 1.05],
      [`${SWITCH_UNCUED}, звук, помехи, 30 сигналов`, 1],
      [`${SWITCH_UNCUED}, звук, помехи, 45 сигналов`, 1],
      [`${SWITCH_UNCUED}, звук, помехи, 60 сигналов`, 1],
    ]),
    ...tail(`${SWITCH_UNCUED}, звук, помехи, 60 сигналов`),
  ],
};

const bandsOf = (m: BandModuleId): readonly LoadBand[] => {
  const bands = reactionModules[m].bands;
  if (bands === undefined) throw new Error(`${m} has no bands`);
  return bands;
};

describe('load bands (F3, spec §3.1.3)', () => {
  it('the six band modules are exactly the reaction modules with a ladder; РДО has none', () => {
    expect(BAND_MODULES).toEqual(['pzmr', 'szmr', 'gonogo', 'pomeh', 'stroop', 'taskswitch']);
    const withLadder = REACTION_MODULE_IDS.filter((m) => reactionModules[m].bands !== undefined);
    expect(new Set(withLadder)).toEqual(new Set(BAND_MODULES));
    expect(rdo.bands).toBeUndefined();
  });

  it('windows of the new curves (spec §3.1.1)', () => {
    const windows = (m: BandModuleId) => [0, 4, 8, 12, 16].map((L) => bandParams(m, L).windowMs);
    expect(windows('pzmr')).toEqual([1000, 542, 331, 233, 188]);
    expect(windows('szmr')).toEqual([1500, 822, 485, 317, 233]);
    expect(windows('gonogo')).toEqual([1000, 583, 371, 263, 207]);
    expect(windows('pomeh')).toEqual([1000, 583, 371, 263, 207]);
    expect(windows('stroop')).toEqual([2000, 1475, 1099, 830, 637]);
    expect(windows('taskswitch')).toEqual([2000, 1285, 846, 577, 412]);
  });

  it.each(BAND_MODULES)('%s bands: labels, chains and floor factors', (m) => {
    expect(bandsOf(m).map((b) => [b.label, b.chain, b.floorFactor])).toEqual(LADDERS[m]);
  });

  it('band sizes: ПЗМР 13, СЗМР 17, Go/No-Go 15, Помехоустойчивость 14, Струп 14, Переключение 14', () => {
    expect(BAND_MODULES.map((m) => bandsOf(m).length)).toEqual([13, 17, 15, 14, 14, 14]);
  });

  it.each(BAND_MODULES)('%s: params carry the band of the level, its label and the block size', (m) => {
    const bands = bandsOf(m);
    for (let b = 0; b < bands.length; b++) {
      for (const L of [4 * b, 4 * b + 3.99]) {
        const p = bandParams(m, L);
        expect([p.band, p.bandLabel], `L ${String(L)}`).toEqual([b, bands[b]?.label]);
        expect(reactionModules[m].trials(p)).toBe(p.trials);
      }
    }
  });

  it('bandIndex caps at the last band (Р15)', () => {
    expect(bandIndex(pzmr, 100)).toBe(12);
    expect(bandIndex(rdo, 100)).toBe(0);
    expect([bandIndex(szmr, 7.99), bandIndex(szmr, 8), bandIndex(szmr, 67.99), bandIndex(szmr, 68), bandIndex(szmr, 1000)]).toEqual([1, 2, 16, 16, 16]);
    expect(bandParams('pzmr', 100)).toMatchObject({ band: 12, bandLabel: LADDERS.pzmr[12]?.[0] });
  });

  it('params(L, loadBand) takes the load of loadBand and the window of L', () => {
    expect(szmr.params(9, 3)).toMatchObject({
      band: 3,
      bandLabel: '4 цвета на 4 клавиши',
      nColors: 4,
      nKeys: 4,
      windowMs: Math.round(150 + 1350 * 0.84 ** 9),
    });
    expect(szmr.params(9)).toMatchObject({ band: 2, nColors: 3, windowMs: Math.round(150 + 1350 * 0.84 ** 9) });
    // A load band past the ladder plays its last band.
    expect(pzmr.params(50, 13)).toEqual(pzmr.params(50, 12));
    for (const m of BAND_MODULES) {
      const last = bandsOf(m).length - 1;
      for (let b = 0; b <= last; b++) {
        const p = bandParams(m, 2, b);
        expect([p.band, p.windowMs], `${m} band ${String(b)}`).toEqual([b, bandParams(m, 2).windowMs]);
      }
    }
  });

  /** How like the go the no-go is (F8). */
  const NO_GO_STEP: Readonly<Record<string, number>> = { green_circle: 0, red_square: 1, red_marked: 2 };

  /** What a block asks of the player, as numbers that must never fall from one band to the next. */
  function loadVector(p: Record<string, unknown>): Record<string, number> {
    const noise = p['noise'] as { distractors: number; flicker: boolean; farOnly: boolean } | null | undefined;
    const audio = p['audio'] as { layers: string[] } | null | undefined;
    const flag = (k: string): number => (p[k] === true ? 1 : 0);
    return {
      colors: (p['nColors'] as number | undefined) ?? 0,
      keys: (p['nKeys'] as number | undefined) ?? 0,
      rules: (p['rules'] as unknown[] | undefined)?.length ?? 0,
      trials: p['trials'] as number,
      figures: noise?.distractors ?? 0,
      sound: audio?.layers.length ?? 0,
      noise: noise === null || noise === undefined ? 0 : 1,
      flicker: noise?.flicker === true ? 1 : 0,
      near: noise !== null && noise !== undefined && !noise.farOnly ? 1 : 0,
      shape: flag('shapeDistractor'),
      inversion: flag('inversion'),
      reverse: flag('reverse'),
      runs: flag('runs'),
      choice: p['mode'] === 'choice' ? 1 : 0,
      noLegend: p['legend'] === false ? 1 : 0,
      noGo: NO_GO_STEP[p['noGoStimulus'] as string] ?? 0,
      cueWithFigure: p['cueLeadMs'] === 0 ? 1 : 0,
    };
  }

  it.each(BAND_MODULES)('%s: the load never falls with the band', (m) => {
    const last = bandsOf(m).length - 1;
    for (const L of [0, 10, 30]) {
      for (let b = 0; b < last; b++) {
        const lower = loadVector(bandParams(m, L, b));
        const upper = loadVector(bandParams(m, L, b + 1));
        for (const [k, v] of Object.entries(upper)) expect(v, `${m} L ${String(L)}: ${k} from band ${String(b)}`).toBeGreaterThanOrEqual(lower[k] as number);
      }
    }
  });

  it.each(BAND_MODULES)('%s: params are finite for L in [0, 1000]', (m) => {
    const last = bandsOf(m).length - 1;
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1000, noNaN: true }), (L) => {
        const p = bandParams(m, L);
        expect(p.windowMs).toBeGreaterThanOrEqual(150);
        expect(p.band).toBeLessThanOrEqual(last);
        expect(p.band).toBe(bandIndex(reactionModules[m], L));
        for (const v of Object.values(p)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('the window never grows with L', () => {
    for (const m of BAND_MODULES) {
      for (let L = 0; L < 80; L += 0.5) expect(bandParams(m, L + 0.5).windowMs, `${m} L ${String(L)}`).toBeLessThanOrEqual(bandParams(m, L).windowMs);
    }
  });
});

describe('load by band: one example per row of the spec tables (§3.1.3, Р12)', () => {
  const FAR_RED = { distractors: 6, lifetimeMs: 600, flicker: false, farOnly: true, forbidden: [{ shape: 'circle', color: 'red' }] };
  const SOUND = { layers: ['hum', 'beeps'], gain: 0.6 };
  const ALL_LAYERS = ['hum', 'beeps', 'metronome', 'babble'];

  it('ПЗМР', () => {
    expect(pzmr.params(12)).toEqual({
      band: 3,
      bandLabel: 'интервал 0,3–3 с, помехи',
      isiMin: 300,
      isiMax: 3000,
      noise: FAR_RED,
      audio: null,
      trials: 15,
      windowMs: 233,
    });
    expect(pzmr.params(0)).toEqual({ band: 0, bandLabel: 'красный круг', isiMin: 500, isiMax: 2500, noise: null, audio: null, trials: 15, windowMs: 1000 });
    expect(pzmr.params(8)).toMatchObject({ band: 2, isiMin: 300, isiMax: 3000, noise: null, audio: null, trials: 15 });
    expect(pzmr.params(16)).toMatchObject({ band: 4, noise: FAR_RED, audio: SOUND, trials: 15 });
    expect(pzmr.params(20)).toMatchObject({
      band: 5,
      noise: { distractors: 10, lifetimeMs: 600, flicker: true, farOnly: false, forbidden: [{ shape: 'circle', color: 'red' }] },
      audio: SOUND,
      trials: 15,
    });
    expect([24, 28].map((L) => pzmr.params(L).trials)).toEqual([30, 45]);
    expect(pzmr.params(32)).toMatchObject({ band: 8, audio: { layers: ALL_LAYERS, gain: 0.8 }, trials: 60, noise: { distractors: 10, flicker: true } });
    expect(pzmr.params(50)).toMatchObject({ band: 12, audio: { layers: ALL_LAYERS, gain: 0.8 }, trials: 60 });
  });

  it('СЗМР', () => {
    const rows: [number, Record<string, unknown>][] = [
      [0, { nColors: 2, nKeys: 2, shapeDistractor: false, inversion: false, audio: null, noise: null, trials: 20 }],
      [8, { nColors: 3, nKeys: 2, shapeDistractor: false }],
      [12, { nColors: 4, nKeys: 4, shapeDistractor: false }],
      [16, { nColors: 4, nKeys: 4, shapeDistractor: true, inversion: false }],
      [20, { nColors: 5, nKeys: 5, shapeDistractor: true }],
      [24, { nColors: 6, nKeys: 6, inversion: false }],
      [28, { nColors: 6, nKeys: 6, inversion: true, audio: null }],
      [32, { inversion: true, audio: SOUND, noise: null }],
      [36, { audio: SOUND, noise: { distractors: 6, lifetimeMs: 600, flicker: false, farOnly: true }, trials: 20 }],
      [40, { trials: 30 }],
      [44, { trials: 45 }],
      [48, { trials: 60, noise: { farOnly: true }, audio: SOUND }],
      [52, { band: 13, trials: 60 }],
    ];
    for (const [L, load] of rows) expect(szmr.params(L), `L ${String(L)}`).toMatchObject({ band: Math.min(16, Math.floor(L / 4)), ...load });
    // Band 9: the noise never takes a target pair (every pair of the active colours).
    const forbidden = szmr.params(36).noise?.forbidden ?? [];
    expect(forbidden).toHaveLength(36);
    expect(new Set(forbidden.map((f) => f.color))).toEqual(new Set(['red', 'green', 'yellow', 'blue', 'white', 'purple']));
  });

  it('Go/No-Go (bands 0–5: the F8 table)', () => {
    const rows: [number, Record<string, unknown>][] = [
      [0, { isiMin: 500, isiMax: 2500, noGoRatio: 0.2, noGoStimulus: 'green_circle', audio: null, noise: null, trials: 20 }],
      [8, { isiMin: 400, isiMax: 1800, noGoRatio: 0.15, noGoStimulus: 'green_circle' }],
      [12, { isiMin: 300, isiMax: 1000, noGoRatio: 0.15, noGoStimulus: 'green_circle' }],
      [16, { isiMin: 300, isiMax: 1000, noGoStimulus: 'red_square' }],
      [20, { noGoStimulus: 'red_marked', audio: null }],
      [24, { noGoStimulus: 'red_marked', audio: SOUND, noise: null }],
      [28, { audio: SOUND, noise: { distractors: 6, lifetimeMs: 600, flicker: false, farOnly: true }, trials: 20 }],
      [32, { trials: 30 }],
      [36, { trials: 45 }],
      [40, { trials: 60 }],
      [44, { band: 11, trials: 60, noGoStimulus: 'red_marked' }],
    ];
    for (const [L, load] of rows) expect(gonogo.params(L), `L ${String(L)}`).toMatchObject({ band: Math.floor(L / 4), swapped: false, ...load });
    expect(gonogo.params(24).audio).toEqual({ layers: ['hum', 'beeps'], gain: 0.6 });
  });

  it('Помехоустойчивость (figures and their change stay smooth with L)', () => {
    const rows: [number, Record<string, unknown>][] = [
      [0, { mode: 'simple', noise: { distractors: 3, lifetimeMs: 1000, flicker: false, farOnly: true }, audio: null, trials: 20 }],
      [8, { mode: 'simple', noise: { distractors: 7, lifetimeMs: 610, flicker: true, farOnly: false }, audio: { layers: ['hum'], gain: 0.5 } }],
      [12, { mode: 'choice', audio: { layers: ['hum'], gain: 0.5 } }],
      [16, { mode: 'choice', audio: { layers: ['hum', 'beeps'], gain: 0.6 } }],
      [20, { audio: { layers: ['hum', 'beeps', 'metronome'], gain: 0.75 } }],
      [24, { audio: { layers: ALL_LAYERS, gain: 1 }, trials: 20 }],
      [28, { trials: 30 }],
      [32, { trials: 45 }],
      [36, { trials: 60, noise: { distractors: 14, lifetimeMs: 120 } }],
      [40, { band: 10, trials: 60 }],
    ];
    for (const [L, load] of rows) expect(pomeh.params(L), `L ${String(L)}`).toMatchObject({ band: Math.floor(L / 4), isiMin: 500, isiMax: 2500, ...load });
    expect(pomeh.params(12).noise.forbidden).toEqual([
      { shape: 'circle', color: 'red' },
      { shape: 'circle', color: 'green' },
    ]);
    expect(pomeh.params(7.99).noise.forbidden).toEqual([{ shape: 'circle', color: 'red' }]);
  });

  it('Струп (the incongruent share stays smooth with L)', () => {
    const rows: [number, Record<string, unknown>][] = [
      [0, { nColors: 2, legend: true, isiMin: 500, isiMax: 2000, reverse: false, audio: null, noise: null, trials: 20, incongruentRatio: 0.5 }],
      [4, { nColors: 3, legend: true }],
      [8, { nColors: 4, legend: false, isiMin: 500, isiMax: 2000 }],
      [12, { nColors: 4, isiMin: 300, isiMax: 1200, reverse: false }],
      [16, { reverse: true, audio: null, incongruentRatio: 0.75 }],
      [20, { reverse: true, audio: SOUND, noise: null }],
      [24, { audio: SOUND, noise: { distractors: 6, lifetimeMs: 600, flicker: false, farOnly: true }, trials: 20 }],
      [28, { trials: 30 }],
      [32, { trials: 45 }],
      [36, { trials: 60 }],
      [40, { band: 10, trials: 60, reverse: true }],
    ];
    for (const [L, load] of rows) expect(stroop.params(L), `L ${String(L)}`).toMatchObject({ band: Math.floor(L / 4), ...load });
    expect(stroop.params(16).reverse).toBe(true);
  });

  it('Переключение (switch share and cue lead stay smooth before their bands)', () => {
    const rows: [number, Record<string, unknown>][] = [
      [0, { rules: ['color', 'shape'], switchProb: 0.2, cueLeadMs: 900, runs: false, audio: null, noise: null, trials: 20 }],
      [8, { rules: ['color', 'shape', 'size'], cueLeadMs: Math.round(900 * 0.88 ** 8) }],
      [12, { rules: ['color', 'shape', 'size'], cueLeadMs: 0, runs: false }],
      [16, { cueLeadMs: 0, runs: true, audio: null }],
      [20, { runs: true, audio: SOUND, noise: null }],
      [24, { audio: SOUND, noise: { distractors: 6, lifetimeMs: 600, flicker: false, farOnly: true }, trials: 20 }],
      [28, { trials: 30 }],
      [32, { trials: 45 }],
      [36, { trials: 60 }],
      [40, { band: 10, trials: 60, runs: true }],
    ];
    for (const [L, load] of rows) expect(taskswitch.params(L), `L ${String(L)}`).toMatchObject({ band: Math.floor(L / 4), ...load });
    expect(taskswitch.params(12).cueLeadMs).toBe(0);
    expect(taskswitch.params(16).runs).toBe(true);
  });
});

describe('stressors of the band modules', () => {
  it('noise and sound outside Помехоустойчивость play on every trial (noiseGate all, Р12)', () => {
    for (const m of ['pzmr', 'szmr', 'gonogo', 'stroop', 'taskswitch'] as const) {
      const mod = reactionModules[m];
      const last = bandParams(m, 60);
      expect(stressorsOf(mod, last), m).toEqual({ noise: last['noise'], audio: last['audio'], gate: 'all', noiseGate: 'all' });
      expect(stressorsOf(mod, mod.params(0)), m).toMatchObject({ noise: null, audio: null });
    }
    expect(stressorsOf(pomeh, pomeh.params(8))).toMatchObject({ gate: 'noisy', noiseGate: 'noisy' });
    expect(stressorsOf(rdo, rdo.params(40))).toBe(NO_STRESSORS);
    expect(NO_STRESSORS).toEqual({ noise: null, audio: null, gate: 'all', noiseGate: 'noisy' });
  });
});

describe('the grey of the noise (Р13)', () => {
  it('grey is the last colour, kept for the noise', () => {
    expect(COLOR_IDS.at(-1)).toBe('gray');
    expect(COLOR_IDS).toHaveLength(7);
  });

  it('СЗМР band 9 noise never matches a target: grey non-circles only', () => {
    const p = szmr.params(36).noise;
    if (p === null) throw new Error('expected noise at band 9');
    for (let seed = 0; seed < 200; seed++) {
      for (const d of noiseFrame(p, seed, seed * 37, { halfW: 0.9, halfH: 0.5 })) {
        expect(d.color).toBe('gray');
        expect(d.shape).not.toBe('circle');
      }
    }
  });

  it('no module ever shows a grey stimulus', () => {
    const colours = (s: Stimulus): string[] => {
      switch (s.kind) {
        case 'shape':
          return [s.color, ...(s.frame === undefined ? [] : [s.frame])];
        case 'word':
          return [s.word, s.ink];
        case 'switch':
          return [s.color];
        case 'rdo':
          return [];
      }
    };
    for (const m of REACTION_MODULE_IDS) {
      const mod = reactionModules[m];
      const last = mod.bands?.length ?? 1;
      for (let b = 0; b < last; b++) {
        for (let seed = 0; seed < 5; seed++) {
          for (const t of mod.generateBlock(mod.params(4 * b), createRng(seed), 'keyboard', 60)) {
            expect(colours(t.stimulus), `${m} band ${String(b)}`).not.toContain('gray');
          }
        }
      }
    }
  });
});
