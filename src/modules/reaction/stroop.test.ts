import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutKeys } from '../../engine/layouts';
import { createRng } from '../../engine/rng';
import type { TrialSpec } from '../../engine/reaction/types';
import type { LayoutId } from '../../engine/types';
import { COLOR_WORDS, STROOP_COLORS, stroop } from './stroop';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

function word(t: TrialSpec) {
  if (t.stimulus.kind !== 'word') throw new Error('expected a word stimulus');
  return t.stimulus;
}

function key(t: TrialSpec): string {
  if (t.expected.kind !== 'press') throw new Error('expected a press trial');
  return t.expected.key;
}

describe('stroop catalogue', () => {
  it('colours in key order and their words', () => {
    expect(STROOP_COLORS).toEqual(['red', 'green', 'blue', 'yellow']);
    expect(COLOR_WORDS).toEqual({ red: 'КРАСНЫЙ', green: 'ЗЕЛЁНЫЙ', blue: 'СИНИЙ', yellow: 'ЖЁЛТЫЙ' });
  });

  it('title, block size (W2-R5), no stability threshold', () => {
    expect(stroop.id).toBe('stroop');
    expect(stroop.title).toBe('Струп');
    expect(stroop.blockSize).toBe(20);
    expect(stroop.lNorm).toBe(10);
    expect(stroop.cvMax(0)).toBeNull();
    expect(stroop.cvMax(30)).toBeNull();
  });
});

describe('stroop.params', () => {
  it('reference points', () => {
    expect(stroop.params(0)).toEqual({ windowMs: 2000, nColors: 2, incongruentRatio: 0.5, legend: true, isiMin: 500, isiMax: 2000 });
    const p8 = stroop.params(8);
    expect(p8).toMatchObject({ windowMs: 1099, nColors: 3, legend: true });
    expect(p8.incongruentRatio).toBeCloseTo(0.66, 12);
    expect(stroop.params(11.9).legend).toBe(true);
    expect(stroop.params(12).legend).toBe(false);
    const p16 = stroop.params(16);
    expect(p16).toMatchObject({ windowMs: 637, nColors: 4, legend: false });
    expect(p16.incongruentRatio).toBeCloseTo(0.75, 12);
  });

  it('band edges', () => {
    expect(stroop.params(7.99).nColors).toBe(2);
    expect(stroop.params(15.99).nColors).toBe(3);
    expect(stroop.params(1000)).toMatchObject({ windowMs: 150, nColors: 4, incongruentRatio: 0.75, legend: false });
  });

  it('monotone: window never grows; colours and incongruent share never drop; all finite', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = stroop.params(a);
        const pb = stroop.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        expect(pb.nColors).toBeGreaterThanOrEqual(pa.nColors);
        expect(pb.incongruentRatio).toBeGreaterThanOrEqual(pa.incongruentRatio);
        expect(Number(pb.legend)).toBeLessThanOrEqual(Number(pa.legend));
        expect(pb.windowMs).toBeGreaterThanOrEqual(150);
        for (const v of [pb.windowMs, pb.nColors, pb.incongruentRatio, pb.isiMin, pb.isiMax]) expect(Number.isFinite(v)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('stroop.generateBlock', () => {
  it('default length is blockSize, size overrides', () => {
    expect(stroop.generateBlock(stroop.params(0), createRng(1), 'keyboard')).toHaveLength(20);
    expect(stroop.generateBlock(stroop.params(0), createRng(1), 'keyboard', 24)).toHaveLength(24);
  });

  it('L=8, 24 trials: 16 incongruent, cond matches word/ink, words from the active colours, key by ink, ISI 500..2000', () => {
    const p = stroop.params(8);
    const keys = layoutKeys('keyboard', 3).keys;
    const active = STROOP_COLORS.slice(0, 3);
    for (let seed = 1; seed <= 30; seed++) {
      const block = stroop.generateBlock(p, createRng(seed), 'keyboard', 24);
      expect(block.filter((t) => t.cond === 'incongruent')).toHaveLength(16);
      for (const t of block) {
        const s = word(t);
        expect(t.cond).toBe(s.word === s.ink ? 'congruent' : 'incongruent');
        expect(active).toContain(s.word);
        expect(active).toContain(s.ink);
        expect(key(t)).toBe(keys[STROOP_COLORS.indexOf(s.ink)]);
        expect(t.windowMs).toBe(p.windowMs);
        expect(Number.isInteger(t.isiMs)).toBe(true);
        expect(t.isiMs).toBeGreaterThanOrEqual(500);
        expect(t.isiMs).toBeLessThanOrEqual(2000);
      }
    }
  });

  it('every colour appears as ink, and an incongruent word can be any other active colour', () => {
    const p = stroop.params(16);
    const block = stroop.generateBlock(p, createRng(5), 'keyboard', 400);
    expect(new Set(block.map((t) => word(t).ink)).size).toBe(4);
    const wordsOnRed = new Set(block.filter((t) => word(t).ink === 'red' && t.cond === 'incongruent').map((t) => word(t).word));
    expect([...wordsOnRed].sort()).toEqual(['blue', 'green', 'yellow']);
  });

  it('incongruent positions are shuffled', () => {
    const block = stroop.generateBlock(stroop.params(0), createRng(2), 'keyboard', 40);
    const flags = block.map((t) => t.cond === 'incongruent');
    expect(flags.slice(0, 20).every(Boolean)).toBe(false);
    expect(flags.filter(Boolean)).toHaveLength(20);
  });

  it('minCondTrials: the smaller of the congruent and incongruent counts, whatever the seed', () => {
    for (const L of [0, 5, 8, 12, 16, 40]) {
      const p = stroop.params(L);
      for (let n = 1; n <= 60; n++) {
        const block = stroop.generateBlock(p, createRng(n), 'keyboard', n);
        const incongruent = block.filter((t) => t.cond === 'incongruent').length;
        expect(stroop.minCondTrials?.(p, n), `L ${String(L)}, n ${String(n)}`).toBe(Math.min(incongruent, n - incongruent));
      }
    }
    // L = 8 (ratio 0.66): 14 trials hold 5 congruent; L = 16 (0.75): 19.
    expect([13, 14].map((n) => stroop.minCondTrials?.(stroop.params(8), n))).toEqual([4, 5]);
    expect([18, 19].map((n) => stroop.minCondTrials?.(stroop.params(16), n))).toEqual([4, 5]);
  });

  it('is deterministic for a seed', () => {
    const p = stroop.params(8);
    expect(stroop.generateBlock(p, createRng(9), 'keyboard')).toEqual(stroop.generateBlock(p, createRng(9), 'keyboard'));
    expect(stroop.generateBlock(p, createRng(9), 'keyboard')).not.toEqual(stroop.generateBlock(p, createRng(10), 'keyboard'));
  });

  it.each<[LayoutId, string[]]>([
    ['mouse', ['KeyD', 'KeyF', 'KeyJ']],
    ['pult', ['ArrowDown', 'ArrowLeft', 'ArrowRight']],
  ])('%s layout with 3 colours uses its keys', (layout, expected) => {
    const block = stroop.generateBlock(stroop.params(8), createRng(3), layout, 100);
    expect([...new Set(block.map(key))].sort()).toEqual(expected);
  });
});

describe('stroop keys and texts', () => {
  it('keyCount is the number of colours', () => {
    expect(stroop.keyCount(stroop.params(0))).toBe(2);
    expect(stroop.keyCount(stroop.params(8))).toBe(3);
    expect(stroop.keyCount(stroop.params(16))).toBe(4);
  });

  it('legend names each colour with its key, only while the level shows it', () => {
    const legend = (layout: LayoutId, L: number): string | null | undefined => stroop.legend?.(layout, stroop.params(L));
    expect(legend('keyboard', 0)).toBe('красный — F · зелёный — J');
    expect(legend('keyboard', 8)).toBe('красный — D · зелёный — F · синий — J');
    expect(legend('pult', 0)).toBe('красный — ← · зелёный — →');
    expect(legend('keyboard', 12)).toBeNull();
  });

  it('instruction: rule with the keys, the legend note while it is shown', () => {
    expect(stroop.instruction('keyboard', stroop.params(0))).toBe(
      'Отвечай по цвету букв, а не по слову: красный — F, зелёный — J. Подсказка клавиш — внизу экрана.',
    );
    expect(stroop.instruction('mouse', stroop.params(0))).toBe(
      'Отвечай по цвету букв, а не по слову: красный — ЛКМ, зелёный — ПКМ. Подсказка клавиш — внизу экрана.',
    );
    expect(stroop.instruction('keyboard', stroop.params(16))).toBe(
      'Отвечай по цвету букв, а не по слову: красный — D, зелёный — F, синий — J, жёлтый — K.',
    );
  });

  it('mouse layout with 3 colours falls back to the keyboard and says so', () => {
    const text = stroop.instruction('mouse', stroop.params(8));
    expect(text).toContain('красный — D, зелёный — F, синий — J.');
    expect(text).toContain('Для этого уровня нужны клавиши: D, F, J');
  });

  it('describeParams', () => {
    expect(stroop.describeParams(stroop.params(0))).toEqual([
      { label: 'Окно ответа', value: '2000 мс' },
      { label: 'Цветов', value: '2' },
      { label: 'Доля несовпадений', value: '50 %' },
      { label: 'Подсказка клавиш', value: 'да' },
    ]);
    expect(stroop.describeParams(stroop.params(16))).toEqual([
      { label: 'Окно ответа', value: '637 мс' },
      { label: 'Цветов', value: '4' },
      { label: 'Доля несовпадений', value: '75 %' },
      { label: 'Подсказка клавиш', value: 'нет' },
    ]);
  });
});
