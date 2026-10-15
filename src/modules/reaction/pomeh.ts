import { STRESSOR_LAYERS, type AudioStressorParams, type StressorLayer } from '../../engine/audio/stressors';
import { keyLabel } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import type { TrialCond, TrialSpec } from '../../engine/reaction/types';
import type { Rng } from '../../engine/rng';
import type { InputKey } from '../../engine/types';
import { ISI_MAX, ISI_MIN, blockLength, keysFor, ms, singleKeyLabel, yesNo, type ReactionModule } from './common';

export interface PomehParams {
  windowMs: number;
  /** simple: a red circle, one key; choice (L ≥ 20): red circle → key 0, green circle → key 1. */
  mode: 'simple' | 'choice';
  isiMin: number;
  isiMax: number;
  /** Shown on `noisy` trials, from the ISI before them. */
  noise: VisualNoiseParams;
  /** Sound on the same trials from L = 18; null below. */
  audio: AudioStressorParams | null;
}

const BLOCK_SIZE = 20;
/** Quiet and noisy runs take turns, each rng.int(3, 5) trials long. */
const RUN_MIN = 3;
const RUN_MAX = 5;

const RED_CIRCLE = { shape: 'circle', color: 'red' } as const;
const GREEN_CIRCLE = { shape: 'circle', color: 'green' } as const;

const LAYER_NAMES: Readonly<Record<StressorLayer, string>> = { hum: 'гул', beeps: 'сигналы', metronome: 'метроном', babble: 'гомон' };

/** Sound from L = 18: hum, then beeps (24), metronome (30), babble (36); gain 0.5 rising 0.025 per level up to 1. */
function soundAt(L: number): AudioStressorParams | null {
  if (L < 18) return null;
  const layers = L >= 36 ? 4 : L >= 30 ? 3 : L >= 24 ? 2 : 1;
  return { layers: STRESSOR_LAYERS.slice(0, layers), gain: Math.min(1, 0.5 + 0.025 * (L - 18)) };
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

  params(L) {
    const choice = L >= 20;
    return {
      windowMs: Math.round(150 + 850 * 0.88 ** L),
      mode: choice ? 'choice' : 'simple',
      isiMin: ISI_MIN,
      isiMax: ISI_MAX,
      noise: {
        distractors: Math.min(14, 3 + Math.floor(L / 2)),
        lifetimeMs: Math.round(Math.max(120, 1000 * 0.94 ** L)),
        flicker: L >= 8,
        farOnly: L < 12,
        forbidden: choice ? [RED_CIRCLE, GREEN_CIRCLE] : [RED_CIRCLE],
      },
      audio: soundAt(L),
    };
  },

  cvMax: 0.225,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
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

  stressors: (p) => ({ noise: p.noise, audio: p.audio, gate: 'noisy' }),

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

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Режим', value: p.mode === 'choice' ? 'выбор' : 'простая реакция' },
    { label: 'Отвлекающих фигур', value: String(p.noise.distractors) },
    { label: 'Смена фигур', value: ms(p.noise.lifetimeMs) },
    { label: 'Мерцание фона', value: yesNo(p.noise.flicker) },
    { label: 'Звук', value: p.audio === null ? 'нет' : p.audio.layers.map((l) => LAYER_NAMES[l]).join(', ') },
  ],
};
