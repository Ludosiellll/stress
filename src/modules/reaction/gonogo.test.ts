import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Stimulus, TrialSpec } from '../../engine/reaction/types';
import { createRng, deriveSeed } from '../../engine/rng';
import { gonogo, isSwappedSegment, swapColours, SWAP_SHARE, type GoNoGoParams } from './gonogo';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

const NO_GO_STEP: Record<GoNoGoParams['noGoStimulus'], number> = { green_circle: 0, red_square: 1, red_marked: 2 };

/** The block's go and no-go stimuli (a size large enough for both). */
function stimuliOf(p: GoNoGoParams): { go: Stimulus; noGo: Stimulus } {
  const block = gonogo.generateBlock(p, createRng(3), 'keyboard', 40);
  const pick = (kind: TrialSpec['expected']['kind']): Stimulus => (block.find((t) => t.expected.kind === kind) as TrialSpec).stimulus;
  return { go: pick('press'), noGo: pick('withhold') };
}

/** How the instruction names a stimulus: «красный круг», «зелёный квадрат», «… с белой точкой». */
function nameOf(s: Stimulus): string {
  if (s.kind !== 'shape') throw new Error('Go/No-Go stimuli are shapes');
  const color = { red: 'красный', green: 'зелёный' }[s.color as 'red' | 'green'];
  const shape = { circle: 'круг', square: 'квадрат' }[s.shape as 'circle' | 'square'];
  return `${color} ${shape}${s.mark === true ? ' с белой точкой' : ''}`;
}

describe('gonogo.params', () => {
  it.each([
    [0, 500, 2500, 0.2, 'green_circle'],
    [7.99, 500, 2500, 0.2, 'green_circle'],
    [8, 400, 1800, 0.15, 'green_circle'],
    [11.99, 400, 1800, 0.15, 'green_circle'],
    [12, 300, 1000, 0.15, 'green_circle'],
    [15.99, 300, 1000, 0.15, 'green_circle'],
    [16, 300, 1000, 0.15, 'red_square'],
    [19.99, 300, 1000, 0.15, 'red_square'],
    [20, 300, 1000, 0.15, 'red_marked'],
    [100, 300, 1000, 0.15, 'red_marked'],
  ] as const)('parameters by level (spec §2.5, bands 0–5 of F3): L %f → ISI %i–%i ms, no-go %f, %s', (L, isiMin, isiMax, noGoRatio, noGoStimulus) => {
    expect(gonogo.params(L)).toMatchObject({
      windowMs: Math.round(150 + 850 * 0.845 ** L),
      noGoRatio,
      noGoStimulus,
      isiMin,
      isiMax,
      swapped: false,
    });
  });

  it('the window is round(150 + 850·0.845^L) (F3)', () => {
    expect([0, 10, 16, 20].map((L) => gonogo.params(L).windowMs)).toEqual([1000, 308, 207, 179]);
  });

  it('swapColours swaps the colours and the no-go the band label names', () => {
    expect(swapColours(gonogo.params(16))).toEqual({ ...gonogo.params(16), swapped: true, bandLabel: 'no-go — зелёный квадрат, интервал 0,3–1 с' });
    // The other labels name no colour.
    for (const L of [0, 8, 12, 20, 24, 28, 40, 60]) expect(swapColours(gonogo.params(L))).toEqual({ ...gonogo.params(L), swapped: true });
  });

  it('monotone: the window and the pace only shorten, the no-go only gets more similar, its share stays 15–20 %', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = gonogo.params(a);
        const pb = gonogo.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        expect(pb.windowMs).toBeGreaterThanOrEqual(150);
        expect(pb.isiMin).toBeLessThanOrEqual(pa.isiMin);
        expect(pb.isiMax).toBeLessThanOrEqual(pa.isiMax);
        expect(NO_GO_STEP[pb.noGoStimulus]).toBeGreaterThanOrEqual(NO_GO_STEP[pa.noGoStimulus]);
        expect([0.15, 0.2]).toContain(pb.noGoRatio);
        expect(pb.swapped).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('gonogo.cvMax', () => {
  it('0.205 at every level (F2)', () => {
    expect(gonogo.cvMax).toBe(0.205);
  });
});

describe('isSwappedSegment', () => {
  it('a segment is swapped when its own draw from the plan seed is below SWAP_SHARE', () => {
    expect(SWAP_SHARE).toBe(0.3);
    for (const [seed, index] of [
      [1, 0],
      [2, 3],
      [77, 1],
      [12345, 5],
    ] as const) {
      expect(isSwappedSegment(seed, index)).toBe(createRng(deriveSeed(seed, 'swap:' + String(index))).next() < 0.3);
    }
  });

  it('about 30 % of segments are swapped', () => {
    let swapped = 0;
    for (let seed = 1; seed <= 10_000; seed++) if (isSwappedSegment(seed, 0)) swapped++;
    const share = swapped / 10_000;
    expect(share).toBeGreaterThanOrEqual(0.28);
    expect(share).toBeLessThanOrEqual(0.32);
  });

  it('segments of one plan draw apart', () => {
    const draws = new Set(Array.from({ length: 20 }, (_, i) => isSwappedSegment(4, i)));
    expect(draws).toEqual(new Set([true, false]));
  });
});

describe('gonogo.generateBlock', () => {
  it('default length is blockSize 20, size overrides', () => {
    expect(gonogo.blockSize).toBe(20);
    expect(gonogo.generateBlock(gonogo.params(0), createRng(1), 'keyboard')).toHaveLength(20);
    expect(gonogo.generateBlock(gonogo.params(10), createRng(1), 'keyboard', 60)).toHaveLength(60);
  });

  it('no-go count: 4 of 20 at 20 %, 3 of 20 at 15 %', () => {
    for (const [L, size, noGo] of [
      [0, 20, 4],
      [7.99, 20, 4],
      [8, 20, 3],
      [16, 20, 3],
      [24, 20, 3],
      [10, 60, 9],
    ] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const block = gonogo.generateBlock(gonogo.params(L), createRng(seed), 'keyboard', size);
        expect(block.filter((t) => t.expected.kind === 'withhold'), `L ${String(L)}, size ${String(size)}`).toHaveLength(noGo);
      }
    }
  });

  it('go presses the key, no-go withholds; the ISI stays in the level’s range', () => {
    for (const L of [0, 8, 12, 25]) {
      const p = gonogo.params(L);
      const isis = new Set<number>();
      for (const t of gonogo.generateBlock(p, createRng(5), 'pult', 200)) {
        expect(t.windowMs).toBe(p.windowMs);
        expect(Number.isInteger(t.isiMs)).toBe(true);
        expect(t.isiMs).toBeGreaterThanOrEqual(p.isiMin);
        expect(t.isiMs).toBeLessThanOrEqual(p.isiMax);
        isis.add(t.isiMs);
        if (t.expected.kind !== 'withhold') expect(t.expected).toEqual({ kind: 'press', key: 'ArrowDown' });
      }
      expect(isis.size).toBeGreaterThan(50);
    }
  });

  it('stimuli: the go is a red circle, the no-go by level; swapped, the go is green and the no-go swaps its colour', () => {
    const red = { kind: 'shape', shape: 'circle', color: 'red' } as const;
    const green = { kind: 'shape', shape: 'circle', color: 'green' } as const;
    expect(stimuliOf(gonogo.params(0))).toEqual({ go: red, noGo: green });
    expect(stimuliOf(gonogo.params(16))).toEqual({ go: red, noGo: { kind: 'shape', shape: 'square', color: 'red' } });
    expect(stimuliOf(gonogo.params(20))).toEqual({ go: red, noGo: { ...red, mark: true } });
    const swapped = (L: number): GoNoGoParams => ({ ...gonogo.params(L), swapped: true });
    expect(stimuliOf(swapped(0))).toEqual({ go: green, noGo: red });
    expect(stimuliOf(swapped(16))).toEqual({ go: green, noGo: { kind: 'shape', shape: 'square', color: 'green' } });
    expect(stimuliOf(swapped(20))).toEqual({ go: green, noGo: { ...green, mark: true } });
    // Only the marked circle carries the field.
    expect(stimuliOf(gonogo.params(0)).go).not.toHaveProperty('mark');
  });

  it('no-go positions are shuffled', () => {
    const p = gonogo.params(10);
    const positions = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      const block = gonogo.generateBlock(p, createRng(seed), 'keyboard');
      positions.add(block.map((t) => (t.expected.kind === 'withhold' ? 'N' : 'G')).join(''));
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('is deterministic for a seed, and swapping changes only the colours', () => {
    const p = gonogo.params(10);
    const block = gonogo.generateBlock(p, createRng(4), 'mouse');
    expect(block).toEqual(gonogo.generateBlock(p, createRng(4), 'mouse'));
    const swapped = gonogo.generateBlock({ ...p, swapped: true }, createRng(4), 'mouse');
    const timing = (t: TrialSpec) => [t.isiMs, t.windowMs, t.expected];
    expect(swapped.map(timing)).toEqual(block.map(timing));
    expect(swapped.map((t) => t.stimulus)).not.toEqual(block.map((t) => t.stimulus));
  });
});

describe('gonogo texts', () => {
  it('instructions match the stimuli', () => {
    const plain = (L: number): string => gonogo.instruction('keyboard', gonogo.params(L));
    const swapped = (L: number): string => gonogo.instruction('keyboard', { ...gonogo.params(L), swapped: true });
    expect([0, 16, 20].map(plain)).toEqual([
      'На красный круг нажимай Пробел. На зелёный круг не нажимай ничего.',
      'На красный круг нажимай Пробел. На красный квадрат не нажимай ничего.',
      'На красный круг нажимай Пробел. На красный круг с белой точкой не нажимай ничего.',
    ]);
    expect([0, 16, 20].map(swapped)).toEqual([
      'В этом задании наоборот: на зелёный круг нажимай Пробел, на красный круг — ничего.',
      'В этом задании наоборот: на зелёный круг нажимай Пробел, на зелёный квадрат — ничего.',
      'В этом задании наоборот: на зелёный круг нажимай Пробел, на зелёный круг с белой точкой — ничего.',
    ]);
    // The names come from what the block shows.
    for (const L of [0, 8, 12, 16, 20]) {
      for (const swap of [false, true]) {
        const p = { ...gonogo.params(L), swapped: swap };
        const { go, noGo } = stimuliOf(p);
        const text = gonogo.instruction('mouse', p);
        expect(text).toBe(
          swap
            ? `В этом задании наоборот: на ${nameOf(go)} нажимай ЛКМ, на ${nameOf(noGo)} — ничего.`
            : `На ${nameOf(go)} нажимай ЛКМ. На ${nameOf(noGo)} не нажимай ничего.`,
        );
      }
    }
  });

  it('sound and figures get their notes; an overload block leaves out the sound one (M2)', () => {
    const rule = 'На красный круг нажимай Пробел. На красный круг с белой точкой не нажимай ничего.';
    expect(gonogo.instruction('keyboard', gonogo.params(24))).toBe(rule + ' В блоке будут звуковые помехи, надень наушники.');
    expect(gonogo.instruction('keyboard', gonogo.params(28), true)).toBe(rule + ' Вокруг будут появляться другие фигуры, на них не реагируй.');
  });

  it('describeParams: the window and the load, which holds the interval, the no-go share and the no-go (Р14)', () => {
    expect(gonogo.describeParams(gonogo.params(0))).toEqual([
      { label: 'Окно ответа', value: '1000 мс' },
      { label: 'Нагрузка', value: 'no-go 20 %, интервал 0,5–2,5 с' },
    ]);
    expect(gonogo.describeParams(gonogo.params(16))).toEqual([
      { label: 'Окно ответа', value: '207 мс' },
      { label: 'Нагрузка', value: 'no-go — красный квадрат, интервал 0,3–1 с' },
    ]);
    expect(gonogo.describeParams(swapColours(gonogo.params(16)))[1]).toEqual({ label: 'Нагрузка', value: 'no-go — зелёный квадрат, интервал 0,3–1 с' });
  });
});
