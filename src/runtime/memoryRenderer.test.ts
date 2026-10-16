import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryTrial } from '../modules/memory/generate';
import { BACKGROUND } from './canvasRenderer';
import { createMemoryRenderer, gridCell, LIT_CELL } from './memoryRenderer';

interface Call {
  name: string;
  args: unknown[];
  fillStyle: unknown;
  font: unknown;
  textAlign: unknown;
  textBaseline: unknown;
}

/** A real canvas element whose 2D context records every call with the style in effect at that moment. */
function setup(w = 800, h = 600) {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        const name = String(prop);
        if (name in state) return state[name];
        return (...args: unknown[]) => {
          calls.push({ name, args, fillStyle: state.fillStyle, font: state.font, textAlign: state.textAlign, textBaseline: state.textBaseline });
        };
      },
      set: (_t, prop, value) => {
        state[String(prop)] = value;
        return true;
      },
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: w });
  Object.defineProperty(canvas, 'clientHeight', { value: h });
  const r = createMemoryRenderer(canvas);
  calls.length = 0;
  return { r, calls, canvas };
}

const named = (calls: Call[], name: string) => calls.filter((c) => c.name === name);
/** The drawing calls (state changes such as setTransform left out). */
const drawing = (calls: Call[]) => calls.filter((c) => c.name !== 'setTransform' && c.name !== 'beginPath');

const trial = (over: Partial<MemoryTrial>): MemoryTrial => ({
  mode: 'digits',
  items: ['4', '7', '1', '9'],
  gridSide: 0,
  rows: 0,
  itemMs: 630,
  gapMs: 158,
  cardMs: 2520,
  sound: false,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('memoryRenderer', () => {
  it('item for digits: the one digit in the centre, 0.3 of the shorter side high', () => {
    const { r, calls } = setup(800, 600);
    r.item(trial({}), 1);
    const texts = named(calls, 'fillText');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.args).toEqual(['7', 400, 300]);
    expect(String(texts[0]?.font)).toMatch(/^bold 180px /);
    expect(texts[0]?.textAlign).toBe('center');
    expect(texts[0]?.textBaseline).toBe('middle');
    // The background is painted first.
    expect(drawing(calls)[0]).toMatchObject({ name: 'fillRect', args: [0, 0, 800, 600], fillStyle: BACKGROUND });
  });

  it('item for letters: the letter, sized from the shorter side of a tall window', () => {
    const { r, calls } = setup(500, 900);
    r.item(trial({ mode: 'letters', items: ['Ж', 'Т'] }), 0);
    const texts = named(calls, 'fillText');
    expect(texts.map((c) => c.args)).toEqual([['Ж', 250, 450]]);
    expect(String(texts[0]?.font)).toMatch(/^bold 150px /);
  });

  it('item for positions: a gridSide × gridSide grid with one lit cell at the index', () => {
    const { r, calls } = setup(800, 600);
    const t = trial({ mode: 'positions', items: ['2', '7', '0', '15'], gridSide: 4 });
    r.item(t, 1);
    expect(named(calls, 'strokeRect')).toHaveLength(16);
    const lit = named(calls, 'fillRect').filter((c) => c.fillStyle === LIT_CELL);
    expect(lit).toHaveLength(1);
    const cell = gridCell(800, 600, 4, 7);
    expect(lit[0]?.args).toEqual([cell.x, cell.y, cell.size, cell.size]);
    // Cell 7 of a 4 × 4 grid: row 1, column 3.
    expect(cell).toEqual(gridCell(800, 600, 4, 4 + 3));
    expect(cell.x).toBeGreaterThan(gridCell(800, 600, 4, 6).x);
    expect(cell.y).toBeGreaterThan(gridCell(800, 600, 4, 3).y);
    expect(named(calls, 'fillText')).toHaveLength(0);
  });

  it('the 3×3 card: 3 columns, the digits row by row from the left, the rest of the last row empty (F13)', () => {
    const { r, calls } = setup(800, 600);
    const t = trial({ mode: 'card3x3', items: ['3', '1', '4', '1', '5'], gridSide: 3, rows: 2 });
    r.card(t);
    const texts = named(calls, 'fillText');
    expect(texts.map((c) => c.args[0])).toEqual(['3', '1', '4', '1', '5']);
    texts.forEach((c, i) => {
      const cell = gridCell(800, 600, 3, i, 2);
      expect(c.args.slice(1)).toEqual([cell.x + cell.size / 2, cell.y + cell.size / 2]);
    });
    // Two rows of 3 cells: the sixth stays empty.
    const cells = named(calls, 'strokeRect').map((c) => c.args);
    expect(cells).toEqual([0, 1, 2, 3, 4, 5].map((i) => {
      const cell = gridCell(800, 600, 3, i, 2);
      return [cell.x, cell.y, cell.size, cell.size];
    }));
    // Digits 4 and 5 open the second row.
    expect(gridCell(800, 600, 3, 3, 2)).toMatchObject({ x: gridCell(800, 600, 3, 0, 2).x });
    expect(gridCell(800, 600, 3, 3, 2).y).toBeGreaterThan(gridCell(800, 600, 3, 0, 2).y);
  });

  it('a card of 4 rows is 3 wide and 4 high, centred, its cells square and inside 0.8 of the shorter side', () => {
    const { r, calls } = setup(800, 600);
    r.card(trial({ mode: 'card3x3', items: Array.from({ length: 12 }, (_, i) => String(i % 10)), gridSide: 3, rows: 4 }));
    expect(named(calls, 'fillText')).toHaveLength(12);
    const cells = named(calls, 'strokeRect').map((c) => c.args as number[]);
    expect(cells).toHaveLength(12);
    const size = (0.8 * 600) / 4;
    for (const [, , w, h] of cells) expect([w, h]).toEqual([size, size]);
    const xs = cells.map(([x]) => x as number);
    const ys = cells.map(([, y]) => y as number);
    expect(Math.min(...xs) + Math.max(...xs) + size).toBeCloseTo(800, 9);
    expect(Math.min(...ys) + Math.max(...ys) + size).toBeCloseTo(600, 9);
    // A square grid keeps its old cells.
    expect(gridCell(800, 600, 3, 4)).toEqual(gridCell(800, 600, 3, 4, 3));
  });

  it('fixation: a plus in the centre', () => {
    const { r, calls } = setup(800, 600);
    r.fixation();
    expect(named(calls, 'fillText').map((c) => c.args)).toEqual([['+', 400, 300]]);
  });

  it('clear: the background only', () => {
    const { r, calls } = setup(800, 600);
    r.clear();
    expect(drawing(calls)).toEqual([expect.objectContaining({ name: 'fillRect', args: [0, 0, 800, 600], fillStyle: BACKGROUND })]);
  });

  it('sizes the backing store to the element and the device pixel ratio', () => {
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
    const { r, canvas, calls } = setup(400, 300);
    r.clear();
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(named(calls, 'setTransform')[0]?.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('a missing 2D context is an error', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => createMemoryRenderer(document.createElement('canvas'))).toThrow(/2D context/);
  });
});
