import { STRESSOR_LAYERS, type AudioStressorParams } from '../../engine/audio/stressors';
import { keyLabel } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import type { TrialCond, TrialSpec } from '../../engine/reaction/types';
import type { Rng } from '../../engine/rng';
import type { InputKey } from '../../engine/types';
import {
  ISI_MAX,
  ISI_MIN,
  bandFields,
  blockLength,
  keysFor,
  ladder,
  loadBandOf,
  longBlockTrials,
  ms,
  singleKeyLabel,
  type ReactionModule,
} from './common';

export interface PomehParams {
  /** The load band played (F3) and its label. */
  band: number;
  bandLabel: string;
  windowMs: number;
  trials: number;
  /** simple: a red circle, one key; choice (band 3 on): red circle → key 0, green circle → key 1. */
  mode: 'simple' | 'choice';
  isiMin: number;
  isiMax: number;
  /** Shown on `noisy` trials, from the ISI before them. */
  noise: VisualNoiseParams;
  /** Sound on the same trials from band 2; null below. */
  audio: AudioStressorParams | null;
}

const BLOCK_SIZE = 20;

const FOUR_LAYERS = 'выбор из двух, помехи рядом, мерцание, звук 4 слоя';

/**
 * The Помехоустойчивость ladder (spec §3.1.3): bands 0–1 are the test format. The number of figures and how fast they
 * change stay smooth with L.
 */
const BANDS = ladder([
  ['простая реакция, помехи далеко', 1],
  ['простая реакция, помехи далеко', 1],
  ['простая реакция, помехи рядом, мерцание, звук', 1.05],
  ['выбор из двух, помехи рядом, мерцание, звук', 1.1],
  ['выбор из двух, помехи рядом, мерцание, звук 2 слоя', 1.05],
  ['выбор из двух, помехи рядом, мерцание, звук 3 слоя', 1.05],
  [FOUR_LAYERS, 1.05],
  [`${FOUR_LAYERS}, 30 сигналов`, 1],
  [`${FOUR_LAYERS}, 45 сигналов`, 1],
  [`${FOUR_LAYERS}, 60 сигналов`, 1],
]);
/** Quiet and noisy runs take turns, each rng.int(3, 5) trials long. */
const RUN_MIN = 3;
const RUN_MAX = 5;

const RED_CIRCLE = { shape: 'circle', color: 'red' } as const;
const GREEN_CIRCLE = { shape: 'circle', color: 'green' } as const;

/** Sound of a band (Р12): hum at 0.5 from band 2, + beeps at 0.6 (4), + metronome at 0.75 (5), all four at 1.0 (6). */
function soundAt(b: number): AudioStressorParams | null {
  if (b < 2) return null;
  if (b < 4) return { layers: ['hum'], gain: 0.5 };
  if (b === 4) return { layers: ['hum', 'beeps'], gain: 0.6 };
  return b === 5 ? { layers: ['hum', 'beeps', 'metronome'], gain: 0.75 } : { layers: [...STRESSOR_LAYERS], gain: 1 };
}

/** Conditions of a block: alternating quiet and noisy runs, the first chosen at random, the last cut to the size. */
function conditionRuns(n: number, rng: Rng): TrialCond[] {
  const conds: TrialCond[] = [];
  let cond: TrialCond = rng.pick(['quiet', 'noisy'] as const);
  while (conds.length < n) {
    const len = rng.int(RUN_MIN, RUN_MAX);
    for (let i = 0; i < len && conds.length < n; i++) conds.push(cond);
    cond = cond === 'quiet' ? 'noisy' : 'quiet';
  }
  return conds;
}

/**
 * Worst case of conditionRuns(n) for one condition: its runs as short as they come (RUN_MIN), the other's as long
 * (RUN_MAX), the other condition first, so the cut last run goes to the other one while it fits.
 */
function fewestPerCond(n: number): number {
  const period = RUN_MIN + RUN_MAX;
  return RUN_MIN * Math.floor(n / period) + Math.max(0, (n % period) - RUN_MAX);
}

/** One or two keys: every layout has them, the mouse too (no keyboard fallback). */
const keyCount = (p: PomehParams): number => (p.mode === 'choice' ? 2 : 1);

/** Помехоустойчивость: simple or choice reaction to a circle in the centre while figures, flicker and sound distract. */
export const pomeh: ReactionModule<PomehParams> = {
  id: 'pomeh',
  title: 'Помехоустойчивость',
  lNorm: L_NORM.pomeh,
  blockSize: BLOCK_SIZE,
  bands: BANDS,

  params(L, loadBand) {
    const b = loadBandOf(BANDS, L, loadBand);
    const choice = b >= 3;
    return {
      ...bandFields(BANDS, b, Math.round(150 + 850 * 0.845 ** L)),
      trials: longBlockTrials(b, 7, BLOCK_SIZE),
      mode: choice ? 'choice' : 'simple',
      isiMin: ISI_MIN,
      isiMax: ISI_MAX,
      noise: {
        distractors: Math.min(14, 3 + Math.floor(L / 2)),
        lifetimeMs: Math.round(Math.max(120, 1000 * 0.94 ** L)),
        flicker: b >= 2,
        farOnly: b < 2,
        forbidden: choice ? [{ ...RED_CIRCLE }, { ...GREEN_CIRCLE }] : [{ ...RED_CIRCLE }],
      },
      audio: soundAt(b),
    };
  },

  trials: (p) => p.trials,

  cvMax: 0.225,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, p.trials);
    const keys = keysFor(layout, keyCount(p));
    return conditionRuns(n, rng).map((cond): TrialSpec => {
      const isiMs = rng.int(p.isiMin, p.isiMax);
      const green = p.mode === 'choice' && rng.int(0, 1) === 1;
      return {
        isiMs,
        windowMs: p.windowMs,
        stimulus: { kind: 'shape', shape: 'circle', color: green ? 'green' : 'red' },
        expected: { kind: 'press', key: keys[green ? 1 : 0] as InputKey },
        cond,
      };
    });
  },

  keyCount,

  minCondTrials: (_p, size) => fewestPerCond(size),

  stressors: (p) => ({ noise: p.noise, audio: p.audio, gate: 'noisy', noiseGate: 'noisy' }),

  instruction(layout, p, overload = false) {
    const keys = keysFor(layout, keyCount(p));
    const rule =
      p.mode === 'choice'
        ? `Красный круг в центре — ${keyLabel(keys[0] as InputKey)}, зелёный круг — ${keyLabel(keys[1] as InputKey)}. ` +
          'На остальные фигуры не реагируй.'
        : `Когда в центре появится красный круг, нажми ${singleKeyLabel(layout)}. ` +
          'Иногда вокруг будут появляться другие фигуры, на них не реагируй.';
    return (
      rule +
      (p.noise.flicker ? ' Вместе с фигурами будет мерцать фон.' : '') +
      (p.audio === null || overload ? '' : ' В части блока будут звуковые помехи, надень наушники.')
    );
  },

  /** The mode, the flicker and the sound are in the band label (Р14); the figures stay smooth with L. */
  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Нагрузка', value: p.bandLabel },
    { label: 'Отвлекающих фигур', value: String(p.noise.distractors) },
    { label: 'Смена фигур', value: ms(p.noise.lifetimeMs) },
  ],
};
