import type { AudioStressorParams } from '../../engine/audio/stressors';
import { keyLabel } from '../../engine/layouts';
import type { VisualNoiseParams } from '../../engine/noise';
import { L_NORM } from '../../engine/planner';
import { RULE_WORDS, type Stimulus, type SwitchRule, type TrialSpec } from '../../engine/reaction/types';
import type { Rng } from '../../engine/rng';
import type { InputKey } from '../../engine/types';
import {
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
  percent,
  stressorNotes,
  type ReactionModule,
} from './common';

type SwitchStimulus = Extract<Stimulus, { kind: 'switch' }>;

/** Rules in the order they are added with L. */
const RULES: readonly SwitchRule[] = ['color', 'shape', 'size'];

/** Per rule: the feature values that go to key 0 and key 1, and how the instruction names them. */
const RULE_KEYS: Readonly<Record<SwitchRule, { first: (s: SwitchStimulus) => boolean; names: [string, string] }>> = {
  color: { first: (s) => s.color === 'red', names: ['красная', 'синяя'] },
  shape: { first: (s) => s.shape === 'circle', names: ['круг', 'квадрат'] },
  size: { first: (s) => s.size === 'large', names: ['большая', 'маленькая'] },
};

export interface TaskSwitchParams {
  /** The load band played (F3) and its label. */
  band: number;
  bandLabel: string;
  windowMs: number;
  trials: number;
  /** Active rules: colour and shape, plus size from band 2. */
  rules: SwitchRule[];
  /** Share of rule changes among trials 1…n−1; count per block = round(switchProb · (n − 1)). Not used with runs. */
  switchProb: number;
  /** The rule word appears this long before the figure (П2: shrinks with L; 0 from band 3, with the figure). */
  cueLeadMs: number;
  /** Runs of RUN_LENGTH trials per rule in a constant order, the word on a run's first trial only (F3, Р12). */
  runs: boolean;
  /** Figures around the centre on every trial; null: none. */
  noise: VisualNoiseParams | null;
  /** Sound on every trial; null: none. */
  audio: AudioStressorParams | null;
}

/** W2-R5: 20 trials (spec §6.2: 10–20). */
const BLOCK_SIZE = 20;
/** Trials per rule in a run (Р12). */
const RUN_LENGTH = 4;

const UNCUED = '3 правила, смены без подсказки';

/** The Переключение ladder (spec §3.1.3): bands 0–1 are the test format. Switches and the cue lead stay smooth with L. */
const BANDS = ladder([
  ['2 правила, подсказка заранее', 1],
  ['2 правила, подсказка заранее', 1],
  ['3 правила, подсказка заранее', 1.1],
  ['3 правила, подсказка вместе с фигурой', 1.05],
  [UNCUED, 1.1],
  [`${UNCUED}, звук`, 1.05],
  [`${UNCUED}, звук, помехи`, 1.05],
  [`${UNCUED}, звук, помехи, 30 сигналов`, 1],
  [`${UNCUED}, звук, помехи, 45 сигналов`, 1],
  [`${UNCUED}, звук, помехи, 60 сигналов`, 1],
]);

/** Every figure the module shows: far noise takes none of their colours (Р12). */
const FIGURES = (['red', 'blue'] as const).flatMap((color) => (['circle', 'square'] as const).map((shape) => ({ shape, color })));
/** ISI = cueLeadMs + [ISI_MIN, ISI_MAX]: the blank pause before the cue stays 500–1500 ms at every level. */
const ISI_MIN = 500;
const ISI_MAX = 1500;

/** «ЦВЕТ: красная — F, синяя — J.» */
function ruleText(rule: SwitchRule, keys: readonly InputKey[]): string {
  const [a, b] = RULE_KEYS[rule].names;
  return `${RULE_WORDS[rule]}: ${a} — ${keyLabel(keys[0] as InputKey)}, ${b} — ${keyLabel(keys[1] as InputKey)}.`;
}

/** Rule changes in a block of n: round(switchProb · (n − 1)); the other trials after the first repeat. */
const switchCount = (p: TaskSwitchParams, n: number): number => Math.round(p.switchProb * (n - 1));

/** Rule of each trial: a random first rule, then exactly `switches` changes at shuffled positions. */
function ruleSequence(rules: readonly SwitchRule[], n: number, switches: number, rng: Rng): SwitchRule[] {
  const isSwitch = rng.shuffle(Array.from({ length: n - 1 }, (_, i) => i < switches));
  const seq: SwitchRule[] = [rng.pick(rules)];
  for (const change of isSwitch) {
    const prev = seq[seq.length - 1] as SwitchRule;
    seq.push(change ? rng.pick(rules.filter((r) => r !== prev)) : prev);
  }
  return seq;
}

/** Rules in runs of RUN_LENGTH in the constant order of `rules`, the first run's rule drawn (Р12). */
function runSequence(rules: readonly SwitchRule[], n: number, rng: Rng): SwitchRule[] {
  const start = rules.indexOf(rng.pick(rules));
  return Array.from({ length: n }, (_, i) => rules[(start + Math.floor(i / RUN_LENGTH)) % rules.length] as SwitchRule);
}

/** Rule changes in a block of n with runs: the first trial of every run after the first. */
const runSwitches = (n: number): number => Math.floor((n - 1) / RUN_LENGTH);

/** Переключение правил: answer a figure by the rule written above it; the rule can change from trial to trial. */
export const taskswitch: ReactionModule<TaskSwitchParams> = {
  id: 'taskswitch',
  title: 'Переключение правил',
  lNorm: L_NORM.taskswitch,
  blockSize: BLOCK_SIZE,
  bands: BANDS,

  params(L, loadBand) {
    const b = loadBandOf(BANDS, L, loadBand);
    return {
      ...bandFields(BANDS, b, Math.round(150 + 1850 * 0.885 ** L)),
      trials: longBlockTrials(b, 7, BLOCK_SIZE),
      rules: RULES.slice(0, b >= 2 ? 3 : 2),
      switchProb: Math.min(0.5, 0.2 + 0.02 * L),
      cueLeadMs: b >= 3 ? 0 : Math.round(900 * 0.88 ** L),
      runs: b >= 4,
      noise: b >= 6 ? farNoise(FIGURES) : null,
      audio: b >= 5 ? bandSound() : null,
    };
  },

  trials: (p) => p.trials,

  cvMax: 0.225,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, p.trials);
    const keys = keysFor(layout, 2);
    const rules = p.runs ? runSequence(p.rules, n, rng) : ruleSequence(p.rules, n, switchCount(p, n), rng);
    return rules.map((rule, i): TrialSpec => {
      const isiMs = rng.int(p.cueLeadMs + ISI_MIN, p.cueLeadMs + ISI_MAX);
      const stimulus: SwitchStimulus = {
        kind: 'switch',
        rule,
        color: rng.pick(['red', 'blue'] as const),
        shape: rng.pick(['circle', 'square'] as const),
        size: rng.pick(['large', 'small'] as const),
      };
      if (p.runs && i % RUN_LENGTH !== 0) stimulus.hideRule = true;
      const spec: TrialSpec = {
        isiMs,
        windowMs: p.windowMs,
        stimulus,
        expected: { kind: 'press', key: keys[RULE_KEYS[rule].first(stimulus) ? 0 : 1] as InputKey },
        cueLeadMs: p.cueLeadMs,
      };
      if (i > 0) spec.cond = rule === rules[i - 1] ? 'repeat' : 'switch';
      return spec;
    });
  },

  keyCount: () => 2,

  minCondTrials(p, size) {
    const switches = p.runs ? runSwitches(size) : switchCount(p, size);
    return Math.min(switches, size - 1 - switches);
  },

  stressors: everyTrial,

  instruction: (layout, p, overload = false) => {
    const keys = keysFor(layout, 2);
    const rules = p.rules.map((r) => ruleText(r, keys));
    const order = p.rules.map((r) => RULE_WORDS[r]).join(' → ');
    const text = p.runs
      ? [
          `Правила идут по кругу: ${order}, по ${String(RUN_LENGTH)} фигуры на каждое.`,
          'Правило написано только над первой фигурой из четырёх.',
          ...rules,
        ]
      : ['Над фигурой написано правило.', ...rules, 'Правило может смениться в любой момент.'];
    return text.join(' ') + stressorNotes(p, overload);
  },

  /** The rules, the cue with the figure and the runs are in the band label (Р14). */
  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Нагрузка', value: p.bandLabel },
    ...(p.runs ? [] : [{ label: 'Доля смен', value: percent(p.switchProb) }]),
    { label: 'Подсказка заранее', value: ms(p.cueLeadMs) },
  ],
};
