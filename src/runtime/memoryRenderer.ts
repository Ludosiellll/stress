import type { MemoryTrial } from '../modules/memory/generate';
import { BACKGROUND } from './canvasRenderer';

/** What a memory trial puts on the canvas; every call repaints the whole canvas. */
export interface MemoryRenderer {
  /** The fixation cross in the centre. */
  fixation(): void;
  /** Item k: the digit or letter in the centre, or the grid with cell k lit (positions). */
  item(t: MemoryTrial, k: number): void;
  /** Every digit of the card in its cell, row by row: 3 columns, t.rows rows, the rest of the last row empty (F13). */
  card(t: MemoryTrial): void;
  /** The background only. */
  clear(): void;
}

/** A lit grid cell. */
export const LIT_CELL = '#e8e8e8';
const INK = '#e8e8e8';
/** Grid lines: 3.30:1 on the background, above the 3:1 of WCAG 1.4.11. */
export const GRID_LINE = '#7a7a7a';
const GRID_LINE_PX = 2;
/** Digit, letter and cross height as a share of the shorter side. */
const ITEM_SIZE = 0.3;
/** The larger side of a grid or card as a share of the shorter side of the canvas. */
const GRID_SIZE = 0.8;
/** Card digits fill this share of their cell. */
const CARD_DIGIT = 0.6;
const FONT = "'Segoe UI', Arial, sans-serif";

/**
 * Cell `index` (row by row from 0) of a grid `side` cells wide and `rows` high (square by default) centred in a w × h
 * canvas, in CSS pixels; the cells are square and the larger side of the grid takes GRID_SIZE of the shorter canvas side.
 */
export function gridCell(w: number, h: number, side: number, index: number, rows = side): { x: number; y: number; size: number } {
  const size = (GRID_SIZE * Math.min(w, h)) / Math.max(side, rows);
  const row = Math.floor(index / side);
  const col = index % side;
  return { x: (w - side * size) / 2 + col * size, y: (h - rows * size) / 2 + row * size, size };
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

  const grid = (w: number, h: number, side: number, rows = side): void => {
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = GRID_LINE_PX;
    for (let i = 0; i < side * rows; i++) {
      const c = gridCell(w, h, side, i, rows);
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
      grid(w, h, t.gridSide, t.rows);
      t.items.forEach((digit, i) => {
        const c = gridCell(w, h, t.gridSide, i, t.rows);
        text(digit, c.x + c.size / 2, c.y + c.size / 2, CARD_DIGIT * c.size);
      });
    },
    clear() {
      background();
    },
  };
}
