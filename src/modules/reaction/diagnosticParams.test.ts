import { describe, expect, it } from 'vitest';
import { BAND_MODULES } from '../../engine/types';
import { reactionModules } from '../registry';
import { DIAGNOSTIC_PARAMS } from './diagnosticParams';

describe('DIAGNOSTIC_PARAMS', () => {
  it('the diagnostic parameters are those of 0.2.0 (spec §2.0)', () => {
    // F3 fields at the values that keep the block of 0.2.0: the band of the format, the 0.2.0 block size, no new noise
    // or sound, no reverse rule, no runs.
    expect(DIAGNOSTIC_PARAMS.pzmr).toEqual({
      windowMs: 1000,
      isiMin: 500,
      isiMax: 2500,
      band: 0,
      bandLabel: 'красный круг',
      trials: 15,
      noise: null,
      audio: null,
    });
    expect(DIAGNOSTIC_PARAMS.szmr).toEqual({
      windowMs: 1500,
      nColors: 2,
      nKeys: 2,
      shapeDistractor: false,
      inversion: false,
      band: 0,
      bandLabel: '2 цвета на 2 клавиши',
      trials: 20,
      noise: null,
      audio: null,
    });
    // F8 fields at their 0.2.0 values: the ISI of 0.2.0, colours never swapped.
    expect(DIAGNOSTIC_PARAMS.gonogo).toEqual({
      windowMs: 446,
      noGoRatio: 0.2,
      noGoStimulus: 'green_circle',
      isiMin: 500,
      isiMax: 2500,
      swapped: false,
      band: 0,
      bandLabel: 'no-go 20 %, интервал 0,5–2,5 с',
      trials: 20,
      noise: null,
      audio: null,
    });
    expect(DIAGNOSTIC_PARAMS.rdo).toEqual({ periodMs: 3000, toleranceMs: 60, isiMin: 800, isiMax: 1500, trials: 10 });
    expect(DIAGNOSTIC_PARAMS.pomeh).toEqual({
      windowMs: 456,
      mode: 'simple',
      isiMin: 500,
      isiMax: 2500,
      noise: { distractors: 7, lifetimeMs: 610, flicker: true, farOnly: true, forbidden: [{ shape: 'circle', color: 'red' }] },
      audio: null,
      band: 0,
      bandLabel: 'простая реакция, помехи далеко',
      trials: 20,
    });
    expect(DIAGNOSTIC_PARAMS.stroop).toEqual({
      windowMs: 1099,
      nColors: 3,
      incongruentRatio: 0.66,
      legend: true,
      isiMin: 500,
      isiMax: 2000,
      band: 1,
      bandLabel: '3 цвета, подсказка клавиш',
      trials: 20,
      noise: null,
      audio: null,
      reverse: false,
    });
    expect(DIAGNOSTIC_PARAMS.taskswitch).toEqual({
      windowMs: 1369,
      rules: ['color', 'shape'],
      switchProb: 0.3,
      cueLeadMs: 475,
      band: 1,
      bandLabel: '2 правила, подсказка заранее',
      trials: 20,
      noise: null,
      audio: null,
      runs: false,
    });
    expect(Object.isFrozen(DIAGNOSTIC_PARAMS.pomeh.noise)).toBe(true);
  });

  it('the band labels are those of the module ladders', () => {
    for (const m of BAND_MODULES) {
      const { band, bandLabel } = DIAGNOSTIC_PARAMS[m];
      expect(reactionModules[m].bands?.[band]?.label, m).toBe(bandLabel);
    }
  });

  it('is frozen all the way down', () => {
    const frozenDeep = (v: unknown): boolean =>
      typeof v !== 'object' || v === null || (Object.isFrozen(v) && Object.values(v).every(frozenDeep));
    expect(frozenDeep(DIAGNOSTIC_PARAMS)).toBe(true);
  });

  it('is read-only all the way down for the type checker too', () => {
    // Never called: on the frozen object these writes would throw. `npm run typecheck` fails if one of them compiles.
    const writes = [
      // @ts-expect-error a nested field is read-only
      () => (DIAGNOSTIC_PARAMS.pomeh.noise.distractors = 8),
      // @ts-expect-error a nested array is read-only
      () => (DIAGNOSTIC_PARAMS.taskswitch.rules[0] = 'size'),
      () => {
        for (const f of DIAGNOSTIC_PARAMS.pomeh.noise.forbidden) {
          // @ts-expect-error an object inside a nested array is read-only
          f.color = 'green';
        }
      },
    ];
    expect(writes).toHaveLength(3);
  });
});
