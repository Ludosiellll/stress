import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutKeys } from '../../engine/layouts';
import type { TrialCond, TrialSpec } from '../../engine/reaction/types';
import { createRng } from '../../engine/rng';
import { REACTION_MODULE_IDS } from '../../engine/types';
import { reactionModules } from '../registry';
import { NO_STRESSORS, stressorsOf } from './common';
import { pomeh } from './pomeh';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

const RED_CIRCLE = { shape: 'circle', color: 'red' } as const;
const GREEN_CIRCLE = { shape: 'circle', color: 'green' } as const;

/** Lengths of the runs of equal conditions, in order. */
function runs(block: readonly TrialSpec[]): { cond: TrialCond | undefined; length: number }[] {
  const out: { cond: TrialCond | undefined; length: number }[] = [];
  for (const t of block) {
    const last = out.at(-1);
    if (last !== undefined && last.cond === t.cond) last.length++;
    else out.push({ cond: t.cond, length: 1 });
  }
  return out;
}

const count = (block: readonly TrialSpec[], cond: TrialCond): number => block.filter((t) => t.cond === cond).length;

describe('pomeh catalogue', () => {
  it('title, block size, L_norm, stability threshold, keys by mode', () => {
    expect(pomeh.id).toBe('pomeh');
    expect(pomeh.title).toBe('Помехоустойчивость');
    expect(pomeh.blockSize).toBe(20);
    expect(pomeh.lNorm).toBe(14);
    expect(pomeh.cvMax(0)).toBeCloseTo(0.3, 12);
    expect(pomeh.cvMax(10)).toBeCloseTo(0.25, 12);
    expect(pomeh.cvMax(40)).toBe(0.15);
    expect(pomeh.keyCount(pomeh.params(19))).toBe(1);
    expect(pomeh.keyCount(pomeh.params(20))).toBe(2);
  });
});

describe('pomeh.params', () => {
  it('L = 0: window 1000, 3 figures for 1000 ms, no flicker, far only, no sound', () => {
    expect(pomeh.params(0)).toEqual({
      windowMs: 1000,
      mode: 'simple',
      isiMin: 500,
      isiMax: 2500,
      noise: { distractors: 3, lifetimeMs: 1000, flicker: false, farOnly: true, forbidden: [RED_CIRCLE] },
      audio: null,
    });
  });

  it('reference points L = 8, 12, 18, 20, 24, 36', () => {
    expect(pomeh.params(8)).toMatchObject({
      windowMs: 456,
      mode: 'simple',
      noise: { distractors: 7, lifetimeMs: 610, flicker: true, farOnly: true },
      audio: null,
    });
    expect(pomeh.params(12)).toMatchObject({ windowMs: 333, noise: { distractors: 9, lifetimeMs: 476, flicker: true, farOnly: false } });
    expect(pomeh.params(18)).toMatchObject({
      windowMs: 235,
      mode: 'simple',
      noise: { distractors: 12, lifetimeMs: 328, forbidden: [RED_CIRCLE] },
      audio: { layers: ['hum'], gain: 0.5 },
    });
    expect(pomeh.params(20)).toMatchObject({
      windowMs: 216,
      mode: 'choice',
      noise: { distractors: 13, lifetimeMs: 290, forbidden: [RED_CIRCLE, GREEN_CIRCLE] },
    });
    const p24 = pomeh.params(24);
    expect(p24).toMatchObject({ windowMs: 190, noise: { distractors: 14, lifetimeMs: 227 }, audio: { layers: ['hum', 'beeps'] } });
    expect(p24.audio?.gain).toBeCloseTo(0.65, 12);
    expect(pomeh.params(30).audio?.layers).toEqual(['hum', 'beeps', 'metronome']);
    const p36 = pomeh.params(36);
    expect(p36).toMatchObject({
      windowMs: 159,
      mode: 'choice',
      noise: { distractors: 14, lifetimeMs: 120, flicker: true, farOnly: false },
      audio: { layers: ['hum', 'beeps', 'metronome', 'babble'] },
    });
    expect(p36.audio?.gain).toBeCloseTo(0.95, 12);
  });

  it('band edges: sound from 18, choice from 20, gain capped at 1', () => {
    expect(pomeh.params(17.99).audio).toBeNull();
    expect(pomeh.params(19.99).mode).toBe('simple');
    expect(pomeh.params(23.99).audio?.layers).toEqual(['hum']);
    expect(pomeh.params(1000).audio).toEqual({ layers: ['hum', 'beeps', 'metronome', 'babble'], gain: 1 });
  });

  it('monotone: window and figure lifetime never grow; figures, flicker, !farOnly, sound layers and gain never drop', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = pomeh.params(a);
        const pb = pomeh.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        expect(pb.noise.lifetimeMs).toBeLessThanOrEqual(pa.noise.lifetimeMs);
        expect(pb.noise.distractors).toBeGreaterThanOrEqual(pa.noise.distractors);
        expect(Number(pb.noise.flicker)).toBeGreaterThanOrEqual(Number(pa.noise.flicker));
        expect(Number(!pb.noise.farOnly)).toBeGreaterThanOrEqual(Number(!pa.noise.farOnly));
        expect(pb.audio?.layers.length ?? 0).toBeGreaterThanOrEqual(pa.audio?.layers.length ?? 0);
        expect(pb.audio?.gain ?? 0).toBeGreaterThanOrEqual(pa.audio?.gain ?? 0);
        expect(pb.noise.distractors).toBeLessThanOrEqual(14);
        expect(pb.noise.lifetimeMs).toBeGreaterThanOrEqual(120);
        expect(pb.audio?.gain ?? 0).toBeLessThanOrEqual(1);
        expect(Number.isFinite(pb.windowMs)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('pomeh.generateBlock', () => {
  it('default length is blockSize, size overrides', () => {
    expect(pomeh.generateBlock(pomeh.params(0), createRng(1), 'keyboard')).toHaveLength(20);
    expect(pomeh.generateBlock(pomeh.params(0), createRng(1), 'keyboard', 40)).toHaveLength(40);
    expect(pomeh.generateBlock(pomeh.params(0), createRng(1), 'keyboard', 1)).toHaveLength(1);
  });

  it('quiet and noisy runs of 3–5 trials take turns; the last may be shorter', () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (const n of [3, 12, 20, 40]) {
        const r = runs(pomeh.generateBlock(pomeh.params(0), createRng(seed), 'keyboard', n));
        r.forEach((run, i) => {
          expect(['quiet', 'noisy']).toContain(run.cond);
          if (i > 0) expect(run.cond).not.toBe(r[i - 1]?.cond);
          if (i < r.length - 1) {
            expect(run.length).toBeGreaterThanOrEqual(3);
            expect(run.length).toBeLessThanOrEqual(5);
          } else {
            expect(run.length).toBeLessThanOrEqual(5);
          }
        });
      }
    }
  });

  it('the first run is quiet or noisy at random', () => {
    const first = new Set(Array.from({ length: 40 }, (_, seed) => pomeh.generateBlock(pomeh.params(0), createRng(seed), 'keyboard')[0]?.cond));
    expect([...first].sort()).toEqual(['noisy', 'quiet']);
  });

  it('each condition gets at least ⌊0.3·n⌋ trials for n in [10, 60]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10, max: 60 }), fc.integer({ min: 0, max: 0xffffffff }), (n, seed) => {
        const block = pomeh.generateBlock(pomeh.params(0), createRng(seed), 'keyboard', n);
        expect(count(block, 'quiet') + count(block, 'noisy')).toBe(n);
        expect(count(block, 'quiet')).toBeGreaterThanOrEqual(Math.floor(0.3 * n));
        expect(count(block, 'noisy')).toBeGreaterThanOrEqual(Math.floor(0.3 * n));
      }),
      { numRuns: 1000 },
    );
  });

  it('simple mode: a red circle in the centre, the single key, ISI in [500, 2500]', () => {
    const p = pomeh.params(10);
    for (const layout of ['keyboard', 'mouse', 'pult'] as const) {
      const [only] = layoutKeys(layout, 1).keys;
      for (const t of pomeh.generateBlock(p, createRng(3), layout, 40)) {
        expect(t.stimulus).toEqual({ kind: 'shape', shape: 'circle', color: 'red' });
        expect(t.expected).toEqual({ kind: 'press', key: only });
        expect(t.windowMs).toBe(p.windowMs);
        expect(Number.isInteger(t.isiMs)).toBe(true);
        expect(t.isiMs).toBeGreaterThanOrEqual(500);
        expect(t.isiMs).toBeLessThanOrEqual(2500);
      }
    }
  });

  it('choice mode: red circle → key 0, green circle → key 1, both colours appear', () => {
    const p = pomeh.params(20);
    for (const layout of ['keyboard', 'mouse', 'pult'] as const) {
      const keys = layoutKeys(layout, 2).keys;
      const block = pomeh.generateBlock(p, createRng(5), layout, 40);
      const colors = new Set<string>();
      for (const t of block) {
        if (t.stimulus.kind !== 'shape') throw new Error('expected a shape');
        expect(t.stimulus.shape).toBe('circle');
        colors.add(t.stimulus.color);
        expect(t.expected).toEqual({ kind: 'press', key: keys[t.stimulus.color === 'red' ? 0 : 1] });
      }
      expect([...colors].sort()).toEqual(['green', 'red']);
    }
  });

  it('deterministic for a seed', () => {
    const p = pomeh.params(24);
    expect(pomeh.generateBlock(p, createRng(9), 'keyboard')).toEqual(pomeh.generateBlock(p, createRng(9), 'keyboard'));
    expect(pomeh.generateBlock(p, createRng(9), 'keyboard')).not.toEqual(pomeh.generateBlock(p, createRng(10), 'keyboard'));
  });
});

/**
 * By brute force over every sequence the generator can make (alternating runs of 3–5, the last cut to n):
 * the fewest trials either condition gets in a block of n.
 */
function fewestPerCondBruteForce(n: number): number {
  // reach[pos][turn]: the quiet counts the trials from pos to n can hold when the next run is quiet (0) or noisy (1).
  const reach = Array.from({ length: n + 1 }, (): [Set<number>, Set<number>] => [new Set(), new Set()]);
  const at = (pos: number): [Set<number>, Set<number>] => reach[pos] as [Set<number>, Set<number>];
  at(n)[0].add(0);
  at(n)[1].add(0);
  for (let pos = n - 1; pos >= 0; pos--) {
    for (const turn of [0, 1] as const) {
      for (let len = 3; len <= 5; len++) {
        const take = Math.min(len, n - pos);
        for (const quiet of at(pos + take)[turn === 0 ? 1 : 0]) at(pos)[turn].add(quiet + (turn === 0 ? take : 0));
      }
    }
  }
  const quietCounts = [...at(0)[0], ...at(0)[1]];
  return Math.min(...quietCounts.map((q) => Math.min(q, n - q)));
}

describe('pomeh.minCondTrials', () => {
  it('is the worst case over every run sequence, for n in [1, 60], at any level', () => {
    for (let n = 1; n <= 60; n++) {
      expect(pomeh.minCondTrials?.(pomeh.params(0), n), `n = ${String(n)}`).toBe(fewestPerCondBruteForce(n));
      expect(pomeh.minCondTrials?.(pomeh.params(30), n)).toBe(pomeh.minCondTrials?.(pomeh.params(0), n));
    }
    expect([12, 13, 14, 15, 16].map((n) => pomeh.minCondTrials?.(pomeh.params(8), n))).toEqual([3, 3, 4, 5, 6]);
  });

  it('no generated block gives a condition fewer trials', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 0xffffffff }), (n, seed) => {
        const block = pomeh.generateBlock(pomeh.params(8), createRng(seed), 'keyboard', n);
        expect(Math.min(count(block, 'quiet'), count(block, 'noisy'))).toBeGreaterThanOrEqual(pomeh.minCondTrials?.(pomeh.params(8), n) ?? Infinity);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('stressors', () => {
  it('pomeh: its noise and sound, gated by the noisy trials', () => {
    const p = pomeh.params(18);
    expect(pomeh.stressors?.(p)).toEqual({ noise: p.noise, audio: { layers: ['hum'], gain: 0.5 }, gate: 'noisy' });
    expect(stressorsOf(pomeh, p)).toEqual({ noise: p.noise, audio: { layers: ['hum'], gain: 0.5 }, gate: 'noisy' });
    expect(stressorsOf(pomeh, pomeh.params(0))).toMatchObject({ audio: null, gate: 'noisy' });
  });

  it.each(REACTION_MODULE_IDS.filter((id) => id !== 'pomeh'))('%s: no stressors', (id) => {
    const m = reactionModules[id];
    expect(stressorsOf(m, m.params(40))).toBe(NO_STRESSORS);
    expect(NO_STRESSORS).toEqual({ noise: null, audio: null, gate: 'all' });
  });
});

describe('pomeh texts', () => {
  it('simple instruction names the key for the layout', () => {
    expect(pomeh.instruction('keyboard', pomeh.params(0))).toBe(
      'Когда в центре появится красный круг, нажми Пробел. Иногда вокруг будут появляться другие фигуры, на них не реагируй.',
    );
    expect(pomeh.instruction('pult', pomeh.params(0))).toContain('нажми ↓.');
  });

  it('flicker and sound add their notes', () => {
    expect(pomeh.instruction('keyboard', pomeh.params(8))).toBe(
      'Когда в центре появится красный круг, нажми Пробел. Иногда вокруг будут появляться другие фигуры, на них не реагируй.' +
        ' Вместе с фигурами будет мерцать фон.',
    );
    expect(pomeh.instruction('mouse', pomeh.params(18))).toBe(
      'Когда в центре появится красный круг, нажми ЛКМ. Иногда вокруг будут появляться другие фигуры, на них не реагируй.' +
        ' Вместе с фигурами будет мерцать фон. В части блока будут звуковые помехи, надень наушники.',
    );
  });

  it('an overload block leaves out the sound line: its prefix announces the sound on every trial (M2)', () => {
    expect(pomeh.instruction('keyboard', pomeh.params(20), true)).toBe(
      'Красный круг в центре — F, зелёный круг — J. На остальные фигуры не реагируй. Вместе с фигурами будет мерцать фон.',
    );
    expect(pomeh.instruction('keyboard', pomeh.params(20), false)).toBe(pomeh.instruction('keyboard', pomeh.params(20)));
  });

  it('choice instruction maps both circles to keys', () => {
    expect(pomeh.instruction('keyboard', pomeh.params(20))).toBe(
      'Красный круг в центре — F, зелёный круг — J. На остальные фигуры не реагируй.' +
        ' Вместе с фигурами будет мерцать фон. В части блока будут звуковые помехи, надень наушники.',
    );
    expect(pomeh.instruction('mouse', pomeh.params(20))).toContain('Красный круг в центре — ЛКМ, зелёный круг — ПКМ.');
    expect(pomeh.instruction('pult', pomeh.params(20))).toContain('Красный круг в центре — ←, зелёный круг — →.');
  });

  it('describeParams', () => {
    expect(pomeh.describeParams(pomeh.params(0))).toEqual([
      { label: 'Окно ответа', value: '1000 мс' },
      { label: 'Режим', value: 'простая реакция' },
      { label: 'Отвлекающих фигур', value: '3' },
      { label: 'Смена фигур', value: '1000 мс' },
      { label: 'Мерцание фона', value: 'нет' },
      { label: 'Звук', value: 'нет' },
    ]);
    expect(pomeh.describeParams(pomeh.params(36))).toEqual([
      { label: 'Окно ответа', value: '159 мс' },
      { label: 'Режим', value: 'выбор' },
      { label: 'Отвлекающих фигур', value: '14' },
      { label: 'Смена фигур', value: '120 мс' },
      { label: 'Мерцание фона', value: 'да' },
      { label: 'Звук', value: 'гул, сигналы, метроном, гомон' },
    ]);
  });
});
