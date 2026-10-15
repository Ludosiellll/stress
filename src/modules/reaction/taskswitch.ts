import { keyLabel } from '../../engine/layouts';
import { L_NORM } from '../../engine/planner';
import { RULE_WORDS, type Stimulus, type SwitchRule, type TrialSpec } from '../../engine/reaction/types';
import type { Rng } from '../../engine/rng';
import type { InputKey } from '../../engine/types';
import { blockLength, keysFor, ms, percent, type ReactionModule } from './common';

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
  windowMs: number;
  /** Active rules: colour and shape, plus size from L = 20. */
  rules: SwitchRule[];
  /** Share of rule changes among trials 1…n−1; count per block = round(switchProb · (n − 1)). */
  switchProb: number;
  /** The rule word appears this long before the figure (П2: shrinks with L while switches get more frequent). */
  cueLeadMs: number;
}

/** W2-R5: 20 trials (spec §6.2: 10–20). */
const BLOCK_SIZE = 20;
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

/** Переключение правил: answer a figure by the rule written above it; the rule can change from trial to trial. */
export const taskswitch: ReactionModule<TaskSwitchParams> = {
  id: 'taskswitch',
  title: 'Переключение правил',
  lNorm: L_NORM.taskswitch,
  blockSize: BLOCK_SIZE,

  params: (L) => ({
    windowMs: Math.round(150 + 1850 * 0.92 ** L),
    rules: RULES.slice(0, L >= 20 ? 3 : 2),
    switchProb: Math.min(0.5, 0.2 + 0.02 * L),
    cueLeadMs: Math.round(900 * 0.88 ** L),
  }),

  cvMax: 0.225,

  generateBlock(p, rng, layout, size) {
    const n = blockLength(size, BLOCK_SIZE);
    const keys = keysFor(layout, 2);
    const rules = ruleSequence(p.rules, n, switchCount(p, n), rng);
    return rules.map((rule, i): TrialSpec => {
      const isiMs = rng.int(p.cueLeadMs + ISI_MIN, p.cueLeadMs + ISI_MAX);
      const stimulus: SwitchStimulus = {
        kind: 'switch',
        rule,
        color: rng.pick(['red', 'blue'] as const),
        shape: rng.pick(['circle', 'square'] as const),
        size: rng.pick(['large', 'small'] as const),
      };
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
    const switches = switchCount(p, size);
    return Math.min(switches, size - 1 - switches);
  },

  instruction: (layout, p) => {
    const keys = keysFor(layout, 2);
    const rules = p.rules.map((r) => ruleText(r, keys));
    return ['Над фигурой написано правило.', ...rules, 'Правило может смениться в любой момент.'].join(' ');
  },

  describeParams: (p) => [
    { label: 'Окно ответа', value: ms(p.windowMs) },
    { label: 'Правил', value: String(p.rules.length) },
    { label: 'Доля смен', value: percent(p.switchProb) },
    { label: 'Подсказка заранее', value: ms(p.cueLeadMs) },
  ],
};
