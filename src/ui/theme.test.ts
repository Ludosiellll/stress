import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** WCAG 2 contrast checks of the theme colours (visual QA, Task 17). Vitest runs from the project root. */

const css = readFileSync(join(process.cwd(), 'src/ui/theme.css'), 'utf8');

function variable(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (m?.[1] === undefined) throw new Error(`--${name} not found in theme.css`);
  return m[1];
}

/** A declaration of the first rule with exactly this selector; `var(--x)` resolved. */
function declaration(selector: string, property: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (rule === undefined) throw new Error(`rule ${selector} not found`);
  const value = new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(rule)?.[1]?.trim();
  if (value === undefined) throw new Error(`${selector} has no ${property}`);
  const ref = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
  return ref === undefined ? value : variable(ref);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const expand = (hex: string): string => (hex.length === 4 ? `#${hex.slice(1).split('').map((c) => c + c).join('')}` : hex);

describe('theme contrast', () => {
  it('body and muted text reach 4.5:1 on the background and on cards', () => {
    for (const bg of [variable('bg'), variable('surface')]) {
      expect(contrast(variable('text'), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(variable('muted'), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the primary button label reaches 4.5:1 on its red (1.15rem bold is below the large-text size)', () => {
    const bg = declaration('button.primary', 'background');
    const fg = expand(declaration('button.primary', 'color'));
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring reaches 3:1 on the background', () => {
    expect(contrast(variable('accent'), variable('bg'))).toBeGreaterThanOrEqual(3);
  });
});
