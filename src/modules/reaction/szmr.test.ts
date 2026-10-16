import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { keyLabel, layoutKeys } from '../../engine/layouts';
import { createRng } from '../../engine/rng';
import type { ColorId, TrialSpec } from '../../engine/reaction/types';
import type { LayoutId } from '../../engine/types';
import { COLOR_NAMES } from './common';
import { szmr, type SzmrParams } from './szmr';

const levelPair = fc
  .tuple(fc.double({ min: 0, max: 1000, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }))
  .filter(([a, b]) => a !== b)
  .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a]));

const COLORS: ColorId[] = ['red', 'green', 'yellow', 'blue', 'white', 'purple'];

/** Reference table for the 3 colors / 2 keys band. */
const THREE_ON_TWO: Partial<Record<ColorId, number>> = { red: 0, green: 1, yellow: 0 };

/** Key index for a color without inversion, per the parameter reference. */
function normalIndex(color: ColorId, p: SzmrParams): number {
  if (p.nColors === 3 && p.nKeys === 2) return THREE_ON_TWO[color] ?? -1;
  return COLORS.indexOf(color);
}

function shape(t: TrialSpec) {
  if (t.stimulus.kind !== 'shape') throw new Error('expected a shape stimulus');
  return t.stimulus;
}

function key(t: TrialSpec): string {
  if (t.expected.kind !== 'press') throw new Error('expected a press trial');
  return t.expected.key;
}

/** Lengths of consecutive runs of equal values. */
function runs(xs: boolean[]): { value: boolean; length: number }[] {
  const out: { value: boolean; length: number }[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last?.value === x) last.length++;
    else out.push({ value: x, length: 1 });
  }
  return out;
}

describe('szmr.params', () => {
  it.each([
    [0, 1500, 2, 2, false, false],
    [8, 485, 3, 2, false, false],
    [16, 233, 4, 4, true, false],
    [24, 171, 6, 6, true, false],
    [32, 155, 6, 6, true, true],
  ])('L=%i → window %i, %i colors / %i keys, shape %s, inversion %s (F3)', (L, windowMs, nColors, nKeys, sd, inv) => {
    expect(szmr.params(L)).toMatchObject({ windowMs, nColors, nKeys, shapeDistractor: sd, inversion: inv });
  });

  it('band edges', () => {
    expect(szmr.params(7.99)).toMatchObject({ nColors: 2, nKeys: 2 });
    expect(szmr.params(11.99)).toMatchObject({ nColors: 3, nKeys: 2 });
    expect(szmr.params(12)).toMatchObject({ nColors: 4, nKeys: 4 });
    expect(szmr.params(15.99).shapeDistractor).toBe(false);
    expect(szmr.params(16).shapeDistractor).toBe(true);
    expect(szmr.params(19.99)).toMatchObject({ nColors: 4, nKeys: 4 });
    expect(szmr.params(27.99)).toMatchObject({ nColors: 6, nKeys: 6, inversion: false });
    expect(szmr.params(1000)).toMatchObject({ windowMs: 150, nColors: 6, nKeys: 6, inversion: true });
  });

  it('monotone: window never grows; colors, keys, distractor, inversion never drop', () => {
    fc.assert(
      fc.property(levelPair, ([a, b]) => {
        const pa = szmr.params(a);
        const pb = szmr.params(b);
        expect(pb.windowMs).toBeLessThanOrEqual(pa.windowMs);
        expect(pb.nColors).toBeGreaterThanOrEqual(pa.nColors);
        expect(pb.nKeys).toBeGreaterThanOrEqual(pa.nKeys);
        expect(Number(pb.shapeDistractor)).toBeGreaterThanOrEqual(Number(pa.shapeDistractor));
        expect(Number(pb.inversion)).toBeGreaterThanOrEqual(Number(pa.inversion));
        for (const v of [pb.windowMs, pb.nColors, pb.nKeys]) expect(Number.isFinite(v)).toBe(true);
        expect(pb.windowMs).toBeGreaterThanOrEqual(150);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('szmr.cvMax', () => {
  it('0.22 at every level (F2)', () => {
    expect(szmr.cvMax).toBe(0.22);
  });
});

describe('szmr.generateBlock', () => {
  it('default length is blockSize 20, size overrides', () => {
    expect(szmr.blockSize).toBe(20);
    expect(szmr.generateBlock(szmr.params(0), createRng(1), 'keyboard')).toHaveLength(20);
    expect(szmr.generateBlock(szmr.params(0), createRng(1), 'keyboard', 70)).toHaveLength(70);
  });

  const cases: [number, LayoutId][] = [
    [0, 'keyboard'],
    [8, 'pult'],
    [12, 'mouse'],
    [16, 'keyboard'],
    [20, 'pult'],
    [24, 'keyboard'],
    [32, 'keyboard'],
    [40, 'pult'],
  ];

  it.each(cases)('L=%i on %s: colors, shapes, ISI and expected keys follow the table', (L, layout) => {
    const p = szmr.params(L);
    const keys = layoutKeys(layout, p.nKeys).keys;
    const block = szmr.generateBlock(p, createRng(L + 1), layout, 400);
    const allowed = COLORS.slice(0, p.nColors);
    const seenColors = new Set<ColorId>();
    const seenShapes = new Set<string>();
    for (const t of block) {
      const s = shape(t);
      seenColors.add(s.color);
      seenShapes.add(s.shape);
      expect(allowed).toContain(s.color);
      if (!p.shapeDistractor) expect(s.shape).toBe('circle');
      expect(t.windowMs).toBe(p.windowMs);
      expect(Number.isInteger(t.isiMs)).toBe(true);
      expect(t.isiMs).toBeGreaterThanOrEqual(500);
      expect(t.isiMs).toBeLessThanOrEqual(2500);
      const idx = normalIndex(s.color, p);
      const inverted = s.frame === 'white';
      expect(key(t)).toBe(keys[inverted ? p.nKeys - 1 - idx : idx]);
      if (!p.inversion) expect('frame' in s).toBe(false);
    }
    expect(seenColors.size).toBe(p.nColors);
    if (p.shapeDistractor) expect(seenShapes.size).toBeGreaterThan(1);
  });

  it('inversion: alternating segments of 8..15 trials, starting normal, frame only on inverted', () => {
    const p = szmr.params(32);
    for (let seed = 1; seed <= 50; seed++) {
      const block = szmr.generateBlock(p, createRng(seed), 'keyboard', 120);
      const flags = block.map((t) => {
        const s = shape(t);
        if ('frame' in s) expect(s.frame).toBe('white');
        return 'frame' in s;
      });
      const rs = runs(flags);
      expect(rs[0]?.value).toBe(false);
      expect(rs.length).toBeGreaterThan(1);
      rs.forEach((r, i) => {
        expect(r.length).toBeLessThanOrEqual(15);
        if (i < rs.length - 1) expect(r.length).toBeGreaterThanOrEqual(8);
      });
    }
  });

  it('mouse layout with 4 keys falls back to keyboard keys', () => {
    const p = szmr.params(16);
    const block = szmr.generateBlock(p, createRng(3), 'mouse', 100);
    const used = new Set(block.map(key));
    expect([...used].sort()).toEqual(['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  });

  it('is deterministic for a seed', () => {
    const p = szmr.params(40);
    expect(szmr.generateBlock(p, createRng(9), 'keyboard')).toEqual(szmr.generateBlock(p, createRng(9), 'keyboard'));
    expect(szmr.generateBlock(p, createRng(9), 'keyboard')).not.toEqual(
      szmr.generateBlock(p, createRng(10), 'keyboard'),
    );
  });
});

describe('szmr texts', () => {
  const ONE_KEY_EACH = 'Каждому цвету соответствует своя клавиша: ';
  const FAST = ' Нажимай нужную как можно быстрее.';
  const SHAPE = ' Форму фигуры не учитывай.';
  const FRAME = ' Белая рамка — правило перевёрнуто.';

  it.each([
    ['L < 8', 0, 'keyboard', ONE_KEY_EACH + 'красный — F, зелёный — J.' + FAST],
    ['L < 8, pult', 7, 'pult', ONE_KEY_EACH + 'красный — ←, зелёный — →.' + FAST],
    [
      '8 ≤ L < 16: shared key',
      8,
      'keyboard',
      'Нажимай клавишу по цвету: красный и жёлтый — F, зелёный — J. Отвечай как можно быстрее.',
    ],
    [
      '8 ≤ L < 12, pult',
      11,
      'pult',
      'Нажимай клавишу по цвету: красный и жёлтый — ←, зелёный — →. Отвечай как можно быстрее.',
    ],
    [
      '12 ≤ L < 16',
      12,
      'keyboard',
      ONE_KEY_EACH + 'красный — D, зелёный — F, жёлтый — J, синий — K.' + FAST,
    ],
    [
      '16 ≤ L < 20: shape distractor',
      16,
      'keyboard',
      ONE_KEY_EACH + 'красный — D, зелёный — F, жёлтый — J, синий — K.' + FAST + SHAPE,
    ],
    [
      '20 ≤ L < 24',
      23,
      'keyboard',
      ONE_KEY_EACH + 'красный — S, зелёный — D, жёлтый — F, синий — J, белый — K.' + FAST + SHAPE,
    ],
    [
      '28 ≤ L < 32: inversion',
      28,
      'keyboard',
      ONE_KEY_EACH +
        'красный — S, зелёный — D, жёлтый — F, синий — J, белый — K, фиолетовый — L.' +
        FAST +
        SHAPE +
        FRAME,
    ],
    [
      'L ≥ 36: sound and figures, pult',
      40,
      'pult',
      ONE_KEY_EACH +
        'красный — 1, зелёный — 2, жёлтый — 3, синий — 4, белый — 5, фиолетовый — 6.' +
        FAST +
        SHAPE +
        FRAME +
        ' Вокруг будут появляться другие фигуры, на них не реагируй. В блоке будут звуковые помехи, надень наушники.',
    ],
  ] as const)('instruction, %s', (_, L, layout, text) => {
    expect(szmr.instruction(layout, szmr.params(L))).toBe(text);
  });

  it('mouse layout names its buttons and falls back to keyboard keys above 2', () => {
    expect(szmr.instruction('mouse', szmr.params(0))).toBe(
      ONE_KEY_EACH + 'красный — ЛКМ, зелёный — ПКМ.' + FAST,
    );
    expect(szmr.instruction('mouse', szmr.params(8))).toBe(
      'Нажимай клавишу по цвету: красный и жёлтый — ЛКМ, зелёный — ПКМ. Отвечай как можно быстрее.',
    );
    expect(szmr.instruction('mouse', szmr.params(12))).toBe(
      ONE_KEY_EACH +
        'красный — D, зелёный — F, жёлтый — J, синий — K.' +
        FAST +
        ' Для этого уровня нужны клавиши: D, F, J, K.',
    );
  });

  it('an overload block leaves out the sound note (M2)', () => {
    expect(szmr.instruction('keyboard', szmr.params(32), true)).toBe(szmr.instruction('keyboard', szmr.params(28)));
    expect(szmr.instruction('keyboard', szmr.params(32))).toBe(
      szmr.instruction('keyboard', szmr.params(28)) + ' В блоке будут звуковые помехи, надень наушники.',
    );
  });

  it('describeParams: the window and the load (Р14)', () => {
    expect(szmr.describeParams(szmr.params(0))).toEqual([
      { label: 'Окно ответа', value: '1500 мс' },
      { label: 'Нагрузка', value: '2 цвета на 2 клавиши' },
    ]);
    expect(szmr.describeParams(szmr.params(28))).toEqual([
      { label: 'Окно ответа', value: '160 мс' },
      { label: 'Нагрузка', value: '6 цветов на 6 клавиш, форма, инверсия' },
    ]);
  });
});

describe('the segment mapping (F9)', () => {
  const withMapping = (p: SzmrParams, seed: number): SzmrParams => {
    if (szmr.withMapping === undefined) throw new Error('СЗМР maps its keys');
    return szmr.withMapping(p, seed);
  };
  const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
  const seeds = fc.integer({ min: 0, max: 2 ** 32 - 1 });
  /** The levels of every colours-and-keys band: 2 on 2, 3 on 2, 4 on 4, 5 on 5, 6 on 6, 6 on 6 with inversion. */
  const LEVELS = [0, 8, 12, 20, 24, 28] as const;

  it('params(L) plays the canonical mapping (Р26)', () => {
    for (const L of LEVELS) expect(szmr.params(L).mapping).toBeNull();
  });

  it('a segment mapping is a permutation, or one of the 6 groupings of 3 colours on 2 keys', () => {
    fc.assert(
      fc.property(seeds, fc.constantFrom(...LEVELS), (seed, L) => {
        const p = szmr.params(L);
        const { mapping } = withMapping(p, seed);
        if (mapping === null) throw new Error('a segment mapping');
        if (p.nColors === p.nKeys) {
          expect(mapping).toEqual(createRng(seed).shuffle(range(p.nKeys)));
          expect([...mapping].sort((a, b) => a - b)).toEqual(range(p.nKeys));
        } else {
          // rng.int(0, 2): the colour alone on its key; rng.int(0, 1): the key the other two share.
          const rng = createRng(seed);
          const alone = rng.int(0, 2);
          const shared = rng.int(0, 1);
          expect(mapping).toEqual(range(3).map((c) => (c === alone ? 1 - shared : shared)));
        }
      }),
      { numRuns: 1000 },
    );
    const seen = new Set(range(1000).map((seed) => withMapping(szmr.params(8), seed).mapping?.join(',')));
    expect(seen).toEqual(new Set(['1,0,0', '0,1,1', '0,1,0', '1,0,1', '0,0,1', '1,1,0']));
  });

  it('the mapping of a new band in the same segment comes from the same seed', () => {
    // 3 colours on 2 keys → 4 on 4 inside one segment: each band's mapping is a function of the seed alone.
    for (const seed of [1, 77, 4242]) {
      const threeOnTwo = withMapping(szmr.params(8), seed).mapping;
      const fourOnFour = withMapping(szmr.params(12), seed).mapping;
      expect(withMapping(szmr.params(11), seed).mapping).toEqual(threeOnTwo);
      expect(withMapping(szmr.params(15), seed).mapping).toEqual(fourOnFour);
      expect(fourOnFour).toEqual(createRng(seed).shuffle([0, 1, 2, 3]));
    }
  });

  it('a mapping changes the keys only: the same draws give the same trials', () => {
    for (const L of LEVELS) {
      const p = szmr.params(L);
      const mapped = szmr.generateBlock(withMapping(p, 9), createRng(L + 3), 'keyboard', 60);
      const canonical = szmr.generateBlock(p, createRng(L + 3), 'keyboard', 60);
      expect(mapped.map((t) => ({ ...t, expected: undefined }))).toEqual(canonical.map((t) => ({ ...t, expected: undefined })));
    }
  });

  it('the trials take the keys of the mapping; inversion flips the segment mapping', () => {
    for (const L of LEVELS) {
      for (const seed of [3, 30, 300]) {
        const p = withMapping(szmr.params(L), seed);
        const keys = layoutKeys('keyboard', p.nKeys).keys;
        for (const t of szmr.generateBlock(p, createRng(seed), 'keyboard', 120)) {
          const s = shape(t);
          const k = p.mapping?.[COLORS.indexOf(s.color)] as number;
          expect(key(t)).toBe(keys[s.frame === 'white' ? p.nKeys - 1 - k : k]);
        }
      }
    }
  });

  it('the instruction names the key every trial expects', () => {
    for (const layout of ['keyboard', 'pult', 'mouse'] as const) {
      for (const L of [0, 8, 12, 20, 24]) {
        for (const seed of [5, 50, 500, 5000]) {
          const p = withMapping(szmr.params(L), seed);
          const text = szmr.instruction(layout, p);
          for (const t of szmr.generateBlock(p, createRng(seed), layout, 60)) {
            const { color } = shape(t);
            // A key two colours share is named once, for the pair in colour order: «красный и жёлтый — F».
            const sharing = COLORS.slice(0, p.nColors).filter((_, c) => p.mapping?.[c] === p.mapping?.[COLORS.indexOf(color)]);
            expect(text, `${layout} L ${String(L)} seed ${String(seed)}`).toContain(
              `${sharing.map((c) => COLOR_NAMES[c]).join(' и ')} — ${keyLabel(key(t))}`,
            );
          }
        }
      }
    }
    // The canonical grouping, as the diagnostic and the old blocks say it.
    expect(szmr.instruction('keyboard', szmr.params(8))).toContain('красный и жёлтый — F');
  });

  it('an example: 3 colours on 2 keys with green and yellow sharing J', () => {
    const p = { ...szmr.params(8), mapping: [0, 1, 1] };
    expect(szmr.instruction('keyboard', p)).toBe('Нажимай клавишу по цвету: красный — F, зелёный и жёлтый — J. Отвечай как можно быстрее.');
    const p4 = { ...szmr.params(12), mapping: [2, 0, 3, 1] };
    expect(szmr.instruction('keyboard', p4)).toBe(
      'Каждому цвету соответствует своя клавиша: зелёный — D, синий — F, красный — J, жёлтый — K. Нажимай нужную как можно быстрее.',
    );
  });
});
