import type { MemoryTrial } from '../modules/memory/generate';
import { BACKGROUND } from './canvasRenderer';

/** What a memory trial puts on the canvas; every call repaints the whole canvas. */
export interface MemoryRenderer {
  /** The fixation cross in the centre. */
  fixation(): void;
  /** Item k: the digit or letter in the centre, or the grid with cell k lit (positions). */
  item(t: MemoryTrial, k: number): void;
  /** Every digit of the card in its cell, row by row. */
  card(t: MemoryTrial): void;
  /** The background only. */
  clear(): void;
}

/** A lit grid cell. */
export const LIT_CELL = '#e8e8e8';
const INK = '#e8e8e8';
const GRID_LINE = '#5a5a5a';
const GRID_LINE_PX = 2;
/** Digit, letter and cross height as a share of the shorter side. */
const ITEM_SIZE = 0.3;
/** Grid and card side as a share of the shorter side. */
const GRID_SIZE = 0.8;
/** Card digits fill this share of their cell. */
const CARD_DIGIT = 0.6;
const FONT = "'Segoe UI', Arial, sans-serif";

/** Cell `index` (row by row from 0) of a `side` × `side` grid centred in a w × h canvas, in CSS pixels. */
export function gridCell(w: number, h: number, side: number, index: number): { x: number; y: number; size: number } {
  const total = GRID_SIZE * Math.min(w, h);
  const size = total / side;
  const row = Math.floor(index / side);
  const col = index % side;
  return { x: (w - total) / 2 + col * size, y: (h - total) / 2 + row * size, size };
}

/** Draws memory trials on a full-screen canvas, in the colours of the reaction screen. */
export function createMemoryRenderer(canvas: HTMLCanvasElement): MemoryRenderer {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('createMemoryRenderer: 2D context is not available');

  /** Sizes the backing store, paints the background and returns the CSS size. */
  const background = (): { w: number; h: number; side: number } => {
    const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);
    return { w, h, side: Math.min(w, h) };
  };

  const text = (s: string, x: number, y: number, px: number): void => {
    ctx.font = `bold ${String(px)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    ctx.fillText(s, x, y);
  };

  const grid = (w: number, h: number, side: number): void => {
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = GRID_LINE_PX;
    for (let i = 0; i < side * side; i++) {
      const c = gridCell(w, h, side, i);
      ctx.strokeRect(c.x, c.y, c.size, c.size);
    }
  };

  return {
    fixation() {
      const { w, h, side } = background();
      text('+', w / 2, h / 2, ITEM_SIZE * side);
    },
    item(t, k) {
      const { w, h, side } = background();
      const item = t.items[k];
      if (item === undefined) throw new RangeError(`memoryRenderer: no item ${String(k)}`);
      if (t.mode !== 'positions') {
        text(item, w / 2, h / 2, ITEM_SIZE * side);
        return;
      }
      grid(w, h, t.gridSide);
      const c = gridCell(w, h, t.gridSide, Number(item));
      ctx.fillStyle = LIT_CELL;
      ctx.fillRect(c.x, c.y, c.size, c.size);
    },
    card(t) {
      const { w, h } = background();
      grid(w, h, t.gridSide);
      t.items.forEach((digit, i) => {
        const c = gridCell(w, h, t.gridSide, i);
        text(digit, c.x + c.size / 2, c.y + c.size / 2, CARD_DIGIT * c.size);
      });
    },
    clear() {
      background();
    },
  };
}
