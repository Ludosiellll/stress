import { STRESSOR_LAYERS, type AudioStressorParams } from '../../engine/audio/stressors';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import type { TrialSpec } from '../../engine/reaction/types';
import {
  ISI_MAX,
  ISI_MIN,
  bandFields,
  bandSound,
  blockLength,
  everyTrial,
  farNoise,
  keysFor,
  ladder,
  loadBandOf,
  longBlockTrials,
  ms,
  singleKeyLabel,
  stressorNotes,
  type ReactionModule,
} from './common';

export interface PzmrParams {
  /** The load band played (F3) and its label. */
  band: number;
  bandLabel: string;
  windowMs: number;
  trials: number;
  isiMin: number;
  isiMax: number;
  /** Figures around the centre on every trial; null: none. */
  noise: VisualNoiseParams | null;
  /** Sound on every trial; null: none. */
  audio: AudioStressorParams | null;
}

const BLOCK_SIZE = 15;

const SOUND = 'интервал 0,3–3 с, помехи рядом, мерцание, звук';
const LOUD = 'интервал 0,3–3 с, помехи рядом, мерцание, звук 4 слоя, 60 сигналов';

/** The ПЗМР ladder (spec §3.1.3): bands 0–1 are the test format. */
const BANDS = ladder([
  ['красный круг', 1],
  ['красный круг', 1],
  ['интервал 0,3–3 с', 1],
  ['интервал 0,3–3 с, помехи', 1.05],
  ['интервал 0,3–3 с, помехи, звук', 1.05],
  [SOUND, 1.05],
  [`${SOUND}, 30 сигналов`, 1],
  [`${SOUND}, 45 сигналов`, 1],
  [LOUD, 1],
]);

const TARGET = [{ shape: 'circle', color: 'red' }] as const;

/** Far noise from band 3; from band 5 near the circle too, 10 figures and a flickering background (Р12). */
function noiseAt(b: number): VisualNoiseParams | null {
  if (b < 3) return null;
  const far = farNoise(TARGET);
  return b < 5 ? far : { ...far, distractors: 10, flicker: true, farOnly: false };
}

/** Hum and beeps from band 4; all four layers at 0.8 from band 8 (Р12). */
function soundAt(b: number): AudioStressorParams | null {
  if (b < 4) return null;
  return b < 8 ? bandSound() : { layers: [...STRESSOR_LAYERS], gain: 0.8 };
}

/** ПЗМР: simple reaction to a red circle with one key. */
export const pzmr: ReactionModule<PzmrParams> = {
  id: 'pzmr',
  title: 'ПЗМР',
  lNorm: L_NORM.pzmr,
  blockSize: BLOCK_SIZE,
  bands: BANDS,

  params(L, loadBand) {
    const b = loadBandOf(BANDS, L, loadBand);
    const wide = b >= 2;
    return {
      ...bandFields(BANDS, b, Math.round(150 + 850 * 0.824 ** L)),
      trials: longBlockTrials(b, 6, BLOCK_SIZE),
      isiMin: wide ? 300 : ISI_MIN,
      isiMax: wide ? 3000 : ISI_MAX,
      noise: noiseAt(b),
      audio: soundAt(b),
    };
  },

  trials: (p) => p.trials,

  cvMax: 0.19,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, p.trials);
    const [key] = keysFor(layout, 1) as [string];
    return Array.from(
      { length: n },
      (): TrialSpec => ({
        isiMs: rng.int(p.isiMin, p.isiMax),
        windowMs: p.windowMs,
        stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
        expected: { kind: 'press', key },
      }),
    );
  },

  keyCount: () => 1,

  stressors: everyTrial,

  instruction: (layout, p, overload = false) =>
    `Когда появится красный круг, как можно быстрее нажми ${singleKeyLabel(layout)}. ` +
    'Не нажимай заранее: это фальстарт.' +
    stressorNotes(p, overload),

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Нагрузка', value: p.bandLabel },
  ],
};
