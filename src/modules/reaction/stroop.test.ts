import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutKeys } from '../../engine/layouts';
import { createRng } from '../../engine/rng';
import { COLOR_WORDS, type TrialSpec } from '../../engine/reaction/types';
import type { LayoutId } from '../../engine/types';
import { STROOP_COLORS, stroop } from './stroop';

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

  it('title, block size (W2-R5), stability threshold', () => {
    expect(stroop.id).toBe('stroop');
    expect(stroop.title).toBe('Струп');
    expect(stroop.blockSize).toBe(20);
    expect(stroop.lNorm).toBe(12);
    expect(stroop.cvMax).toBe(0.235);
  });
});

describe('stroop.params', () => {
  it('reference points (F3: colours, key hint and pace by band, the window as before)', () => {
    expect(stroop.params(0)).toEqual({
      band: 0,
      bandLabel: '2 цвета, подсказка клавиш',
      windowMs: 2000,
      trials: 20,
      nColors: 2,
      incongruentRatio: 0.5,
      legend: true,
      isiMin: 500,
      isiMax: 2000,
      reverse: false,
      noise: null,
      audio: null,
    });
    const p8 = stroop.params(8);
    expect(p8).toMatchObject({ windowMs: 1099, nColors: 4, legend: false });
    expect(p8.incongruentRatio).toBeCloseTo(0.66, 12);
    expect(stroop.params(7.9)).toMatchObject({ nColors: 3, legend: true });
    expect(stroop.params(12)).toMatchObject({ windowMs: 830, isiMin: 300, isiMax: 1200, reverse: false });
    const p16 = stroop.params(16);
    expect(p16).toMatchObject({ windowMs: 637, nColors: 4, legend: false, reverse: true });
    expect(p16.incongruentRatio).toBeCloseTo(0.75, 12);
  });

  it('band edges', () => {
    expect(stroop.params(3.99).nColors).toBe(2);
    expect(stroop.params(7.99).nColors).toBe(3);
    expect(stroop.params(11.99)).toMatchObject({ isiMin: 500, isiMax: 2000 });
    expect(stroop.params(15.99).reverse).toBe(false);
    expect(stroop.params(1000)).toMatchObject({ windowMs: 150, nColors: 4, incongruentRatio: 0.75, legend: false, reverse: true });
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
    const keys = layoutKeys('keyboard', 4).keys;
    const active = STROOP_COLORS.slice(0, 4);
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
    const p = stroop.params(12);
    const block = stroop.generateBlock(p, createRng(5), 'keyboard', 400);
    expect(new Set(block.map((t) => word(t).ink)).size).toBe(4);
    const wordsOnRed = new Set(block.filter((t) => word(t).ink === 'red' && t.cond === 'incongruent').map((t) => word(t).word));
    expect([...wordsOnRed].sort()).toEqual(['blue', 'green', 'yellow']);
  });

  it('incongruent positions are shuffled: they vary with the seed, never a run at either end, every position equally often', () => {
    const n = 40;
    const seeds = 400;
    const patterns = Array.from({ length: seeds }, (_, seed) =>
      stroop.generateBlock(stroop.params(0), createRng(seed), 'keyboard', n).map((t) => t.cond === 'incongruent'),
    );
    const k = 20; // ratio 0.5 at L 0
    for (const flags of patterns) {
      expect(flags.filter(Boolean)).toHaveLength(k);
      expect(flags.slice(0, k).every(Boolean)).toBe(false);
      expect(flags.slice(n - k).every(Boolean)).toBe(false);
    }
    // A rotation or another fixed layout gives few distinct patterns; a shuffle almost never repeats one.
    expect(new Set(patterns.map((f) => f.map(Number).join(''))).size).toBeGreaterThanOrEqual(seeds - 2);
    // Each position is incongruent in about half of the blocks: 200 ± 5σ (σ = 10).
    for (let i = 0; i < n; i++) {
      const count = patterns.filter((f) => f[i]).length;
      expect(count, `position ${String(i)}`).toBeGreaterThanOrEqual(150);
      expect(count, `position ${String(i)}`).toBeLessThanOrEqual(250);
    }
  });

  it('minCondTrials: the smaller of the congruent and incongruent counts, whatever the seed', () => {
    for (const L of [0, 5, 8, 12, 15.99]) {
      const p = stroop.params(L);
      for (let n = 1; n <= 60; n++) {
        const block = stroop.generateBlock(p, createRng(n), 'keyboard', n);
        const incongruent = block.filter((t) => t.cond === 'incongruent').length;
        expect(stroop.minCondTrials?.(p, n), `L ${String(L)}, n ${String(n)}`).toBe(Math.min(incongruent, n - incongruent));
      }
    }
    // L = 8 (ratio 0.66): 14 trials hold 5 congruent; L = 15 (0.75): 19.
    expect([13, 14].map((n) => stroop.minCondTrials?.(stroop.params(8), n))).toEqual([4, 5]);
    expect([18, 19].map((n) => stroop.minCondTrials?.(stroop.params(15), n))).toEqual([4, 5]);
  });

  /** Runs of equal flags: their values and lengths, in order. */
  function runsOf(flags: readonly boolean[]): { framed: boolean; length: number }[] {
    const out: { framed: boolean; length: number }[] = [];
    for (const framed of flags) {
      const last = out.at(-1);
      if (last?.framed === framed) last.length++;
      else out.push({ framed, length: 1 });
    }
    return out;
  }

  it('the reverse rule plays in framed runs of 8–15 trials, answered by the word, without a condition', () => {
    const p = stroop.params(16);
    expect(p.reverse).toBe(true);
    const keys = layoutKeys('keyboard', 4).keys;
    for (let seed = 1; seed <= 60; seed++) {
      const block = stroop.generateBlock(p, createRng(seed), 'keyboard', 40);
      const framed = block.map((t) => word(t).frame === 'white');
      const runs = runsOf(framed);
      expect(runs[0]?.framed).toBe(false);
      expect(runs.length).toBeGreaterThan(1);
      runs.forEach((r, i) => {
        expect(r.length).toBeLessThanOrEqual(15);
        if (i < runs.length - 1) expect(r.length).toBeGreaterThanOrEqual(8);
      });
      // The block keeps its share of mismatched words; the frames take them first.
      expect(block.filter((t) => word(t).word !== word(t).ink)).toHaveLength(Math.round(p.incongruentRatio * 40));
      for (const t of block) {
        const s = word(t);
        if (s.frame === 'white') {
          expect(t.cond).toBeUndefined();
          expect(key(t)).toBe(keys[STROOP_COLORS.indexOf(s.word)]);
        } else {
          expect('frame' in s).toBe(false);
          expect(t.cond).toBe(s.word === s.ink ? 'congruent' : 'incongruent');
          expect(key(t)).toBe(keys[STROOP_COLORS.indexOf(s.ink)]);
        }
      }
      const framedMismatched = block.filter((t) => word(t).frame === 'white' && word(t).word !== word(t).ink).length;
      expect(framedMismatched).toBe(Math.min(Math.round(p.incongruentRatio * 40), framed.filter(Boolean).length));
    }
  });

  /** Every count of framed trials a block of n can have: alternating runs of 8–15, the first plain, the last cut. */
  function framedCounts(n: number): Set<number> {
    const counts = new Set<number>();
    const walk = (pos: number, framed: number, nextFramed: boolean): void => {
      if (pos >= n) {
        counts.add(framed);
        return;
      }
      for (let len = 8; len <= 15; len++) {
        const take = Math.min(len, n - pos);
        walk(pos + take, framed + (nextFramed ? take : 0), !nextFramed);
        if (take < len) break;
      }
    };
    walk(0, 0, false);
    return counts;
  }

  it('minCondTrials with the reverse rule: the worst case over every layout of the frames', () => {
    for (const L of [12, 16, 40]) {
      const p = stroop.params(L, 4);
      for (let n = 1; n <= 60; n++) {
        const incongruent = Math.round(p.incongruentRatio * n);
        const worst = Math.min(
          ...[...framedCounts(n)].map((f) => {
            const framedIncongruent = Math.min(incongruent, f);
            return Math.min(incongruent - framedIncongruent, n - incongruent - (f - framedIncongruent));
          }),
        );
        expect(stroop.minCondTrials?.(p, n), `L ${String(L)}, n ${String(n)}`).toBe(worst);
      }
    }
    // A block of 20: 12 framed trials at most leave 3 incongruent and 5 congruent ones.
    expect(stroop.minCondTrials?.(stroop.params(16), 20)).toBe(3);
  });

  it('no block with the reverse rule gives a condition fewer trials than minCondTrials', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 0xffffffff }), (n, seed) => {
        const p = stroop.params(16);
        const block = stroop.generateBlock(p, createRng(seed), 'keyboard', n);
        const fewest = Math.min(block.filter((t) => t.cond === 'congruent').length, block.filter((t) => t.cond === 'incongruent').length);
        expect(fewest).toBeGreaterThanOrEqual(stroop.minCondTrials?.(p, n) ?? Infinity);
      }),
      { numRuns: 1000 },
    );
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
    const block = stroop.generateBlock(stroop.params(4), createRng(3), layout, 100);
    expect([...new Set(block.map(key))].sort()).toEqual(expected);
  });
});

describe('stroop keys and texts', () => {
  it('keyCount is the number of colours', () => {
    expect(stroop.keyCount(stroop.params(0))).toBe(2);
    expect(stroop.keyCount(stroop.params(4))).toBe(3);
    expect(stroop.keyCount(stroop.params(16))).toBe(4);
  });

  it('legend names each colour with its key, only while the level shows it', () => {
    const legend = (layout: LayoutId, L: number): string | null | undefined => stroop.legend?.(layout, stroop.params(L));
    expect(legend('keyboard', 0)).toBe('красный — F · зелёный — J');
    expect(legend('keyboard', 4)).toBe('красный — D · зелёный — F · синий — J');
    expect(legend('pult', 0)).toBe('красный — ← · зелёный — →');
    expect(legend('keyboard', 8)).toBeNull();
  });

  it('instruction: rule with the keys, the legend note while it is shown', () => {
    expect(stroop.instruction('keyboard', stroop.params(0))).toBe(
      'Отвечай по цвету букв, а не по слову: красный — F, зелёный — J. Подсказка клавиш — внизу экрана.',
    );
    expect(stroop.instruction('mouse', stroop.params(0))).toBe(
      'Отвечай по цвету букв, а не по слову: красный — ЛКМ, зелёный — ПКМ. Подсказка клавиш — внизу экрана.',
    );
    expect(stroop.instruction('keyboard', stroop.params(12))).toBe(
      'Отвечай по цвету букв, а не по слову: красный — D, зелёный — F, синий — J, жёлтый — K.',
    );
  });

  it('the reverse rule, the sound and the figures get their notes; an overload block leaves out the sound one (M2)', () => {
    const rule = 'Отвечай по цвету букв, а не по слову: красный — D, зелёный — F, синий — J, жёлтый — K.';
    const reverse = ' Слово в белой рамке — наоборот: отвечай по слову.';
    expect(stroop.instruction('keyboard', stroop.params(16))).toBe(rule + reverse);
    expect(stroop.instruction('keyboard', stroop.params(24))).toBe(
      rule + reverse + ' Вокруг будут появляться другие фигуры, на них не реагируй. В блоке будут звуковые помехи, надень наушники.',
    );
    expect(stroop.instruction('keyboard', stroop.params(20), true)).toBe(rule + reverse);
  });

  it('mouse layout with 3 colours falls back to the keyboard and says so', () => {
    const text = stroop.instruction('mouse', stroop.params(4));
    expect(text).toContain('красный — D, зелёный — F, синий — J.');
    expect(text).toContain('Для этого уровня нужны клавиши: D, F, J');
  });

  it('describeParams: the window, the load and the incongruent share that stays smooth with L (Р14)', () => {
    expect(stroop.describeParams(stroop.params(0))).toEqual([
      { label: 'Окно ответа', value: '2000 мс' },
      { label: 'Нагрузка', value: '2 цвета, подсказка клавиш' },
      { label: 'Доля несовпадений', value: '50 %' },
    ]);
    expect(stroop.describeParams(stroop.params(16))).toEqual([
      { label: 'Окно ответа', value: '637 мс' },
      { label: 'Нагрузка', value: '4 цвета, интервал 0,3–1,2 с, обратное правило в рамке' },
      { label: 'Доля несовпадений', value: '75 %' },
    ]);
  });
});
