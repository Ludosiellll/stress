import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutKeys } from '../../engine/layouts';
import { noiseFrame } from '../../engine/noise';
import { createRng } from '../../engine/rng';
import { RULE_WORDS, type SwitchRule, type TrialSpec } from '../../engine/reaction/types';
import type { LayoutId } from '../../engine/types';
import { taskswitch } from './taskswitch';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

function sw(t: TrialSpec) {
  if (t.stimulus.kind !== 'switch') throw new Error('expected a switch stimulus');
  return t.stimulus;
}

function key(t: TrialSpec): string {
  if (t.expected.kind !== 'press') throw new Error('expected a press trial');
  return t.expected.key;
}

/** Key index the rule gives: red / circle / large → 0, blue / square / small → 1. */
function ruleIndex(t: TrialSpec): number {
  const s = sw(t);
  const first: Record<SwitchRule, boolean> = { color: s.color === 'red', shape: s.shape === 'circle', size: s.size === 'large' };
  return first[s.rule] ? 0 : 1;
}

describe('taskswitch catalogue', () => {
  it('rule words', () => {
    expect(RULE_WORDS).toEqual({ color: 'ЦВЕТ', shape: 'ФОРМА', size: 'РАЗМЕР' });
  });

  it('title, block size (W2-R5), L_norm, two keys, stability threshold', () => {
    expect(taskswitch.id).toBe('taskswitch');
    expect(taskswitch.title).toBe('Переключение правил');
    expect(taskswitch.blockSize).toBe(20);
    expect(taskswitch.lNorm).toBe(8);
    expect(taskswitch.cvMax).toBe(0.225);
    expect(taskswitch.keyCount(taskswitch.params(0))).toBe(2);
    expect(taskswitch.keyCount(taskswitch.params(20))).toBe(2);
  });
});

describe('taskswitch.params', () => {
  it('reference points L = 0, 5, 10, 20 (F3: rules, cue with the figure and runs by band)', () => {
    expect(taskswitch.params(0)).toEqual({
      band: 0,
      bandLabel: '2 правила, подсказка заранее',
      windowMs: 2000,
      trials: 20,
      rules: ['color', 'shape'],
      switchProb: 0.2,
      cueLeadMs: 900,
      runs: false,
      noise: null,
      audio: null,
    });
    const p5 = taskswitch.params(5);
    expect(p5).toMatchObject({ windowMs: 1154, rules: ['color', 'shape'], cueLeadMs: 475 });
    expect(p5.switchProb).toBeCloseTo(0.3, 12);
    const p10 = taskswitch.params(10);
    expect(p10).toMatchObject({ windowMs: 695, rules: ['color', 'shape', 'size'], cueLeadMs: 251, runs: false });
    expect(p10.switchProb).toBeCloseTo(0.4, 12);
    expect(taskswitch.params(20)).toMatchObject({ windowMs: 311, rules: ['color', 'shape', 'size'], switchProb: 0.5, cueLeadMs: 0, runs: true });
  });

  it('band edges and far levels', () => {
    expect(taskswitch.params(7.99).rules).toEqual(['color', 'shape']);
    expect(taskswitch.params(8).rules).toEqual(['color', 'shape', 'size']);
    expect(taskswitch.params(11.99).cueLeadMs).toBeGreaterThan(0);
    expect(taskswitch.params(15.99).runs).toBe(false);
    expect(taskswitch.params(1000)).toMatchObject({ windowMs: 150, rules: ['color', 'shape', 'size'], switchProb: 0.5, cueLeadMs: 0, runs: true });
  });

  it('monotone (П2): window and cue lead never grow; switch share and rule count never drop; all finite', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = taskswitch.params(a);
        const pb = taskswitch.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        expect(pb.cueLeadMs).toBeLessThanOrEqual(pa.cueLeadMs);
        expect(pb.switchProb).toBeGreaterThanOrEqual(pa.switchProb);
        expect(pb.rules.length).toBeGreaterThanOrEqual(pa.rules.length);
        expect(pb.switchProb).toBeLessThanOrEqual(0.5);
        expect(pb.cueLeadMs).toBeGreaterThanOrEqual(0);
        for (const v of [pb.windowMs, pb.switchProb, pb.cueLeadMs]) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('taskswitch.generateBlock', () => {
  it('default length is blockSize, size overrides', () => {
    expect(taskswitch.generateBlock(taskswitch.params(0), createRng(1), 'keyboard')).toHaveLength(20);
    expect(taskswitch.generateBlock(taskswitch.params(0), createRng(1), 'keyboard', 48)).toHaveLength(48);
    expect(taskswitch.generateBlock(taskswitch.params(0), createRng(1), 'keyboard', 1)).toHaveLength(1);
  });

  it.each([0, 5, 10, 12, 15.99])('L = %s: key by the rule, cond ⇔ rule change, exact switch count, cue lead, ISI range', (L) => {
    const p = taskswitch.params(L);
    const keys = layoutKeys('keyboard', 2).keys;
    for (const n of [12, 20, 48]) {
      for (let seed = 1; seed <= 20; seed++) {
        const block = taskswitch.generateBlock(p, createRng(seed), 'keyboard', n);
        expect(block[0]?.cond).toBeUndefined();
        expect(block.filter((t) => t.cond === 'switch')).toHaveLength(Math.round(p.switchProb * (n - 1)));
        block.forEach((t, i) => {
          expect(p.rules).toContain(sw(t).rule);
          expect(key(t)).toBe(keys[ruleIndex(t)]);
          if (i > 0) expect(t.cond).toBe(sw(t).rule === sw(block[i - 1] as TrialSpec).rule ? 'repeat' : 'switch');
          expect(t.cueLeadMs).toBe(p.cueLeadMs);
          expect(t.windowMs).toBe(p.windowMs);
          expect(Number.isInteger(t.isiMs)).toBe(true);
          expect(t.isiMs).toBeGreaterThanOrEqual(p.cueLeadMs + 500);
          expect(t.isiMs).toBeLessThanOrEqual(p.cueLeadMs + 1500);
        });
      }
    }
  });

  it('minCondTrials: the smaller of the switch and repeat counts, whatever the seed', () => {
    for (const L of [0, 5, 10, 12, 15.99]) {
      const p = taskswitch.params(L);
      for (let n = 1; n <= 60; n++) {
        const block = taskswitch.generateBlock(p, createRng(n), 'keyboard', n);
        const switches = block.filter((t) => t.cond === 'switch').length;
        const repeats = block.filter((t) => t.cond === 'repeat').length;
        expect(taskswitch.minCondTrials?.(p, n), `L ${String(L)}, n ${String(n)}`).toBe(Math.min(switches, repeats));
      }
    }
    // L = 5 (0.3): 12 trials give 3 switches (W2-R30), 16 give 5; L = 0 (0.2) needs 24.
    expect([12, 15, 16].map((n) => taskswitch.minCondTrials?.(taskswitch.params(5), n))).toEqual([3, 4, 5]);
    expect([20, 23, 24].map((n) => taskswitch.minCondTrials?.(taskswitch.params(0), n))).toEqual([4, 4, 5]);
  });

  it('switch positions are shuffled and the first rule is random', () => {
    const p = taskswitch.params(0);
    const seeds = 400;
    // Trials 1…39 of 40: round(0.2 · 39) = 8 switches each.
    const patterns = Array.from({ length: seeds }, (_, seed) =>
      taskswitch
        .generateBlock(p, createRng(seed), 'keyboard', 40)
        .slice(1)
        .map((t) => t.cond === 'switch'),
    );
    for (const flags of patterns) {
      expect(flags.filter(Boolean)).toHaveLength(8);
      expect(flags.slice(0, 8).every(Boolean)).toBe(false);
      expect(flags.slice(-8).every(Boolean)).toBe(false);
    }
    // A rotation or another fixed layout gives few distinct patterns; a shuffle almost never repeats one.
    expect(new Set(patterns.map((f) => f.map(Number).join(''))).size).toBeGreaterThanOrEqual(seeds - 2);
    // Each of the 39 positions is a switch in 8/39 of the blocks: 82 ± 5σ (σ ≈ 8).
    for (let i = 0; i < 39; i++) {
      const count = patterns.filter((f) => f[i]).length;
      expect(count, `position ${String(i + 1)}`).toBeGreaterThanOrEqual(42);
      expect(count, `position ${String(i + 1)}`).toBeLessThanOrEqual(122);
    }
    const firstRule = (seed: number): SwitchRule => sw(taskswitch.generateBlock(p, createRng(seed), 'keyboard')[0] as TrialSpec).rule;
    const firstRules = new Set(Array.from({ length: 40 }, (_, seed) => firstRule(seed)));
    expect([...firstRules].sort()).toEqual(['color', 'shape']);
  });

  it('Переключение: runs of 4 in a constant order, the rule word on the first trial only', () => {
    const p = taskswitch.params(16);
    expect(p).toMatchObject({ runs: true, cueLeadMs: 0, rules: ['color', 'shape', 'size'] });
    const keys = layoutKeys('keyboard', 2).keys;
    const starts = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      for (const n of [20, 23]) {
        const block = taskswitch.generateBlock(p, createRng(seed), 'keyboard', n);
        const start = p.rules.indexOf(sw(block[0] as TrialSpec).rule);
        starts.add(start);
        block.forEach((t, i) => {
          expect(sw(t).rule, `seed ${String(seed)}, trial ${String(i)}`).toBe(p.rules[(start + Math.floor(i / 4)) % 3]);
          if (i % 4 === 0) expect('hideRule' in sw(t)).toBe(false);
          else expect(sw(t).hideRule).toBe(true);
          expect(t.cond).toBe(i === 0 ? undefined : i % 4 === 0 ? 'switch' : 'repeat');
          expect(key(t)).toBe(keys[ruleIndex(t)]);
          expect(t.cueLeadMs).toBe(0);
        });
      }
    }
    // The first run's rule is drawn.
    expect([...starts].sort()).toEqual([0, 1, 2]);
  });

  it('minCondTrials of runs: a switch every 4 trials', () => {
    const p = taskswitch.params(16);
    for (let n = 1; n <= 60; n++) {
      const block = taskswitch.generateBlock(p, createRng(n), 'keyboard', n);
      const switches = block.filter((t) => t.cond === 'switch').length;
      expect(switches).toBe(Math.floor((n - 1) / 4));
      expect(taskswitch.minCondTrials?.(p, n), `n ${String(n)}`).toBe(Math.min(switches, block.filter((t) => t.cond === 'repeat').length));
    }
    expect(taskswitch.minCondTrials?.(p, 20)).toBe(4);
  });

  it('a switch goes to any other rule with three rules', () => {
    const block = taskswitch.generateBlock(taskswitch.params(12), createRng(4), 'keyboard', 400);
    const switchesFromColor = block.slice(1).filter((t, i) => t.cond === 'switch' && sw(block[i] as TrialSpec).rule === 'color');
    const fromColor = new Set(switchesFromColor.map((t) => sw(t).rule));
    expect([...fromColor].sort()).toEqual(['shape', 'size']);
  });

  it('every feature value appears in 40–60 % of 2000 trials', () => {
    const block = taskswitch.generateBlock(taskswitch.params(20), createRng(11), 'keyboard', 2000);
    const share = (pred: (t: TrialSpec) => boolean): number => block.filter(pred).length / block.length;
    for (const s of [
      share((t) => sw(t).color === 'red'),
      share((t) => sw(t).shape === 'circle'),
      share((t) => sw(t).size === 'large'),
    ]) {
      expect(s).toBeGreaterThanOrEqual(0.4);
      expect(s).toBeLessThanOrEqual(0.6);
    }
  });

  it('the size rule appears from band 2 (L 8)', () => {
    const rulesAt = (L: number): Set<SwitchRule> =>
      new Set(taskswitch.generateBlock(taskswitch.params(L), createRng(6), 'keyboard', 400).map((t) => sw(t).rule));
    expect([...rulesAt(0)].sort()).toEqual(['color', 'shape']);
    expect([...rulesAt(7.9)].sort()).toEqual(['color', 'shape']);
    expect([...rulesAt(8)].sort()).toEqual(['color', 'shape', 'size']);
  });

  it('is deterministic for a seed', () => {
    const p = taskswitch.params(10);
    expect(taskswitch.generateBlock(p, createRng(9), 'keyboard')).toEqual(taskswitch.generateBlock(p, createRng(9), 'keyboard'));
    expect(taskswitch.generateBlock(p, createRng(9), 'keyboard')).not.toEqual(taskswitch.generateBlock(p, createRng(10), 'keyboard'));
  });

  it.each<[LayoutId, string[]]>([
    ['mouse', ['MouseLeft', 'MouseRight']],
    ['pult', ['ArrowLeft', 'ArrowRight']],
  ])('%s layout uses its two keys', (layout, expected) => {
    const block = taskswitch.generateBlock(taskswitch.params(0), createRng(3), layout, 100);
    expect([...new Set(block.map(key))].sort()).toEqual([...expected].sort());
    expect(layoutKeys(layout, 2).keys).toEqual(expected);
  });
});

describe('taskswitch texts', () => {
  it('instruction: the rules with the layout keys, the size rule from band 2', () => {
    expect(taskswitch.instruction('keyboard', taskswitch.params(0))).toBe(
      'Над фигурой написано правило. ЦВЕТ: красная — F, синяя — J. ФОРМА: круг — F, квадрат — J. ' +
        'Правило может смениться в любой момент.',
    );
    expect(taskswitch.instruction('keyboard', taskswitch.params(8))).toBe(
      'Над фигурой написано правило. ЦВЕТ: красная — F, синяя — J. ФОРМА: круг — F, квадрат — J. ' +
        'РАЗМЕР: большая — F, маленькая — J. Правило может смениться в любой момент.',
    );
    expect(taskswitch.instruction('mouse', taskswitch.params(0))).toContain('ЦВЕТ: красная — ЛКМ, синяя — ПКМ.');
    expect(taskswitch.instruction('pult', taskswitch.params(0))).toContain('ФОРМА: круг — ←, квадрат — →.');
  });

  it('runs: the order of the rules and where the word is; sound and figures get their notes, but the sound one not in overload (M2)', () => {
    const runs =
      'Правила идут по кругу: ЦВЕТ → ФОРМА → РАЗМЕР, по 4 фигуры на каждое. Правило написано только над первой фигурой из четырёх. ' +
      'ЦВЕТ: красная — F, синяя — J. ФОРМА: круг — F, квадрат — J. РАЗМЕР: большая — F, маленькая — J.';
    expect(taskswitch.instruction('keyboard', taskswitch.params(16))).toBe(runs);
    expect(taskswitch.instruction('keyboard', taskswitch.params(24))).toBe(
      runs + ' Вокруг будут появляться другие фигуры, на них не реагируй. В блоке будут звуковые помехи, надень наушники.',
    );
    expect(taskswitch.instruction('keyboard', taskswitch.params(20), true)).toBe(runs);
  });

  it('describeParams: the window, the load and the levers smooth with L (Р14); runs leave out the switch share', () => {
    expect(taskswitch.describeParams(taskswitch.params(0))).toEqual([
      { label: 'Окно ответа', value: '2000 мс' },
      { label: 'Нагрузка', value: '2 правила, подсказка заранее' },
      { label: 'Доля смен', value: '20 %' },
      { label: 'Подсказка заранее', value: '900 мс' },
    ]);
    expect(taskswitch.describeParams(taskswitch.params(20))).toEqual([
      { label: 'Окно ответа', value: '311 мс' },
      { label: 'Нагрузка', value: '3 правила, смены без подсказки, звук' },
    ]);
  });

  it('describeParams: from band 3 the cue comes with the figure, a constant, so the cue lead is no longer listed', () => {
    expect(taskswitch.describeParams(taskswitch.params(11.99)).map((e) => e.label)).toContain('Подсказка заранее');
    for (const [L, share] of [
      [12, '44 %'],
      [15.99, '50 %'],
    ] as const) {
      expect(taskswitch.params(L).cueLeadMs).toBe(0);
      expect(taskswitch.describeParams(taskswitch.params(L))).toEqual([
        { label: 'Окно ответа', value: `${String(taskswitch.params(L).windowMs)} мс` },
        { label: 'Нагрузка', value: '3 правила, подсказка вместе с фигурой' },
        { label: 'Доля смен', value: share },
      ]);
    }
  });
});

describe('taskswitch noise', () => {
  it('the noise never draws a white figure: the rule word above the figure is white (band 6 on)', () => {
    for (const L of [24, 36, 60]) {
      const noise = taskswitch.params(L).noise;
      if (noise === null) throw new Error(`expected noise at L ${String(L)}`);
      for (let seed = 0; seed < 300; seed++) {
        for (const d of noiseFrame(noise, seed, seed * 41, { halfW: 0.9, halfH: 0.5 })) {
          expect(d.color, `L ${String(L)}, seed ${String(seed)}`).not.toBe('white');
        }
      }
    }
  });
});
