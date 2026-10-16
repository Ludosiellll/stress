import { render, within } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import LineChart, { niceTicks } from './LineChart';

const three = [
  { x: '№1', y: 312 },
  { x: '№2', y: 300 },
  { x: '№3', y: 290 },
];

function renderChart(props: Partial<Parameters<typeof LineChart>[0]> = {}) {
  return render(<LineChart series={[{ name: 'ПЗМР', points: three }]} yLabel="мс" {...props} />);
}

describe('LineChart', () => {
  it('draws one path and a circle per point', () => {
    const { container } = renderChart();
    expect(container.querySelectorAll('path.chart-line')).toHaveLength(1);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
  });

  it('puts the value and the x label into a <title> of every point', () => {
    const { container } = renderChart();
    const titles = [...container.querySelectorAll('circle > title')].map((t) => t.textContent);
    expect(titles).toEqual(['№1: 312', '№2: 300', '№3: 290']);
  });

  it('says «Нет данных» for an empty series and for series with no values', () => {
    const empty = render(<LineChart series={[{ name: 'a', points: [] }]} yLabel="мс" />);
    expect(within(empty.container).getByText('Нет данных')).toBeTruthy();
    expect(empty.container.querySelector('svg')).toBeNull();
    const nulls = render(<LineChart series={[{ name: 'a', points: [{ x: '№1', y: null }] }]} yLabel="мс" />);
    expect(within(nulls.container).getByText('Нет данных')).toBeTruthy();
    const none = render(<LineChart series={[]} yLabel="мс" />);
    expect(within(none.container).getByText('Нет данных')).toBeTruthy();
  });

  it('breaks the line at a null and draws no circle there', () => {
    const { container } = render(
      <LineChart
        series={[{ name: 'a', points: [{ x: '1', y: 10 }, { x: '2', y: null }, { x: '3', y: 12 }, { x: '4', y: 14 }] }]}
        yLabel="мс"
      />,
    );
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    const d = container.querySelector('path.chart-line')?.getAttribute('d') ?? '';
    expect(d.match(/M/g)).toHaveLength(2);
    // The empty slot keeps its place on the x axis.
    expect([...container.querySelectorAll('text.x-tick')].map((t) => t.textContent)).toEqual(['1', '2', '3', '4']);
  });

  it('is a responsive image with a first→last summary', () => {
    const { container } = renderChart({ lowerIsBetter: true });
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('width')).toBe('100%');
    expect(svg?.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);
    const label = svg?.getAttribute('aria-label') ?? '';
    expect(label).toContain('мс');
    expect(label).toContain('№1');
    expect(label).toContain('312');
    expect(label).toContain('№3');
    expect(label).toContain('290');
    expect(label).toContain('меньше — лучше');
  });

  it('says «больше — лучше» when higher is better', () => {
    const { container } = renderChart({ lowerIsBetter: false });
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('больше — лучше');
  });

  it('draws the reference line with its label', () => {
    const { container, getByText } = renderChart({ refLine: { y: 14, label: '≈ формат теста' } });
    expect(container.querySelector('line.chart-ref')?.getAttribute('stroke-dasharray')).not.toBeNull();
    expect(getByText('≈ формат теста')).toBeTruthy();
    // The scale reaches the reference line even though every value is below it.
    const ticks = [...container.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent.replace(',', '.')));
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(14);
  });

  describe('a marker (F3, spec §3.1.6)', () => {
    const levels = [
      { x: '1', y: 14 },
      { x: '2', y: 15 },
      { x: '3', y: 9 },
      { x: '4', y: 10 },
    ];
    const LABEL = '0.3.0: уровень — это нагрузка';
    const num = (el: Element | null | undefined, attr: string): number => Number(el?.getAttribute(attr));
    const draw = (props: Partial<Parameters<typeof LineChart>[0]>) =>
      render(<LineChart series={[{ name: 'Уровень', points: levels }]} yLabel="уровень" refLine={{ y: 8, label: '≈ формат теста' }} {...props} />);

    it('marker draws a dashed vertical line at slot x with its label; the reference line steps there', () => {
      const { container, getByText } = draw({ marker: { x: '3', label: LABEL, refYBefore: 14 } });
      const marker = container.querySelector('line.chart-marker');
      expect(marker?.getAttribute('stroke-dasharray')).not.toBeNull();
      const circles = [...container.querySelectorAll('circle')];
      const x = num(marker, 'x1');
      expect(num(marker, 'x2')).toBe(x);
      // Between the last session before it and slot «3»: the point of slot 3 is the first after the line.
      expect(x).toBeGreaterThan(num(circles[1], 'cx'));
      expect(x).toBeLessThan(num(circles[2], 'cx'));
      // Top to bottom of the plot.
      expect(num(marker, 'y2')).toBeGreaterThan(num(marker, 'y1'));
      expect(getByText(LABEL)).toBeTruthy();
      // Left of the line the reference is at refYBefore (14, the y of the first point), right of it at refLine.y (8).
      const [before, after] = [...container.querySelectorAll('line.chart-ref')];
      expect(num(before, 'x2')).toBe(x);
      expect(num(after, 'x1')).toBe(x);
      expect(num(before, 'x1')).toBeLessThan(x);
      expect(num(after, 'x2')).toBeGreaterThan(x);
      expect(num(before, 'y1')).toBeCloseTo(num(circles[0], 'cy'));
      expect(num(before, 'y2')).toBeCloseTo(num(circles[0], 'cy'));
      // 9 → 8 is a fifth of 14 → 9 further down.
      const perLevel = (num(circles[2], 'cy') - num(circles[0], 'cy')) / 5;
      expect(num(after, 'y1')).toBeCloseTo(num(circles[2], 'cy') + perLevel);
      expect(num(after, 'y2')).toBeCloseTo(num(after, 'y1'));
      expect(getByText('≈ формат теста')).toBeTruthy();
      expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain(LABEL);
    });

    it('without refYBefore the reference line runs across; a marker on no slot is not drawn', () => {
      const plain = draw({ marker: { x: '3', label: LABEL } });
      expect(plain.container.querySelectorAll('line.chart-marker')).toHaveLength(1);
      expect(plain.container.querySelectorAll('line.chart-ref')).toHaveLength(1);
      plain.unmount();
      const nowhere = draw({ marker: { x: '9', label: LABEL, refYBefore: 14 } });
      expect(nowhere.container.querySelector('line.chart-marker')).toBeNull();
      expect(nowhere.container.querySelectorAll('line.chart-ref')).toHaveLength(1);
      expect(nowhere.queryByText(LABEL)).toBeNull();
    });

    it('the scale reaches refYBefore', () => {
      const { container } = draw({ marker: { x: '3', label: LABEL, refYBefore: 22 } });
      const ticks = [...container.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent));
      expect(Math.max(...ticks)).toBeGreaterThanOrEqual(22);
    });
  });

  it('has at least three y ticks on nice numbers', () => {
    const { container } = renderChart();
    const ticks = [...container.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent.replace(',', '.')));
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...ticks)).toBeLessThanOrEqual(290);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(312);
    for (const t of ticks) expect(t % 5).toBe(0);
  });

  it('shows a legend for several series and none for one', () => {
    const one = renderChart();
    expect(one.container.querySelector('.chart-legend')).toBeNull();
    const two = render(
      <LineChart
        series={[
          { name: 'V', points: three },
          { name: 'P', points: three },
        ]}
        yLabel="с"
      />,
    );
    expect(two.container.querySelectorAll('.chart-legend li')).toHaveLength(2);
    expect(two.container.querySelectorAll('path.chart-line')).toHaveLength(2);
  });

  it('draws a single point as a lone circle', () => {
    const { container } = render(<LineChart series={[{ name: 'a', points: [{ x: '№1', y: 5 }] }]} yLabel="мс" />);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('№1');
  });

  it('thins the x labels of a long series but keeps the last one', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ x: String(i + 1), y: i }));
    const { container } = render(<LineChart series={[{ name: 'a', points }]} yLabel="уровень" />);
    const labels = [...container.querySelectorAll('text.x-tick')].map((t) => t.textContent);
    expect(labels.length).toBeLessThanOrEqual(12);
    expect(labels.at(-1)).toBe('100');
    expect(container.querySelectorAll('circle')).toHaveLength(100);
  });

  it('draws a flat series on a scale with room around it', () => {
    const { container } = render(
      <LineChart series={[{ name: 'a', points: [{ x: '1', y: 7 }, { x: '2', y: 7 }] }]} yLabel="мс" />,
    );
    const ticks = [...container.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent.replace(',', '.')));
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...ticks)).toBeLessThan(7);
    expect(Math.max(...ticks)).toBeGreaterThan(7);
  });
});

describe('LineChart number format', () => {
  const texts = (c: HTMLElement, sel: string): string[] => [...c.querySelectorAll(sel)].map((t) => t.textContent);

  it('never writes «−0,0» and uses the typographic minus for negatives (point titles, legend, summary)', () => {
    const series = [
      { name: 'V', points: [{ x: '№1', y: -0.04 }, { x: '№2', y: 12.5 }] },
      { name: 'Π', points: [{ x: '№1', y: -12 }, { x: '№2', y: -3.25 }] },
    ];
    const { container } = render(<LineChart series={series} yLabel="с" />);
    const all = [...texts(container, 'circle > title'), ...texts(container, '.chart-legend li'), container.querySelector('svg')?.getAttribute('aria-label') ?? ''];
    expect(all.join(' ')).not.toMatch(/-/);
    expect(all.join(' ')).not.toMatch(/−0,0|−0(?![,\d])/);
    expect(texts(container, 'circle > title')).toEqual(['№1: 0 (V)', '№2: 12,5 (V)', '№1: −12 (Π)', '№2: −3,3 (Π)']);
    expect(texts(container, '.chart-legend li')).toEqual(['V: 0 (№1) → 12,5 (№2)', 'Π: −12 (№1) → −3,3 (№2)']);
    expect(texts(container, 'text.y-tick').some((t) => t.startsWith('−'))).toBe(true);
    expect(texts(container, 'text.y-tick').join(' ')).not.toMatch(/-/);
  });
});

describe('LineChart whole units (B6)', () => {
  const texts = (c: HTMLElement, sel: string): string[] => [...c.querySelectorAll(sel)].map((t) => t.textContent);
  const zeros = [
    { x: '№1', y: 0 },
    { x: '№2', y: 0 },
  ];

  it('millisecond values are rounded as in the results table, and the ticks are whole', () => {
    const points = [
      { x: '№1', y: 0.1 },
      { x: '№2', y: -0.4 },
      { x: '№3', y: 1.6 },
    ];
    const { container } = render(<LineChart series={[{ name: 'Струп', points }]} yLabel="мс" whole />);
    expect(texts(container, 'circle > title')).toEqual(['№1: 0', '№2: 0', '№3: 2']);
    expect(texts(container, '.chart-summary')).toEqual(['0 (№1) → 2 (№3)']);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('мс. №1: 0, №3: 2');
    for (const t of texts(container, 'text.y-tick')) expect(t).toMatch(/^−?\d+$/);
  });

  it('every value 0: whole ticks, with or without a lower bound', () => {
    for (const domain of [{}, { min: 0 }]) {
      const { container, unmount } = render(<LineChart series={[{ name: 'a', points: zeros }]} yLabel="мс" domain={domain} whole />);
      const ticks = texts(container, 'text.y-tick');
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      for (const t of ticks) expect(t).toMatch(/^−?\d+$/);
      expect(texts(container, '.chart-summary')).toEqual(['0 (№1) → 0 (№2)']);
      unmount();
    }
  });

  it('niceTicks in whole units: never a step below 1 (property)', () => {
    expect(niceTicks(0, 0, {}, true)).toEqual([-1, 0, 1]);
    expect(niceTicks(0, 0, { min: 0 }, true)).toEqual([0, 1]);
    expect(niceTicks(0.1, 1.6, {}, true)).toEqual([0, 1, 2]);
    expect(niceTicks(290, 312, { min: 0 }, true)).toEqual(niceTicks(290, 312, { min: 0 }));
    const value = fc.integer({ min: -100_000, max: 100_000 }).map((n) => n / 10);
    fc.assert(
      fc.property(value, value, fc.boolean(), (a, b, bounded) => {
        const lo = Math.min(a, b);
        const ticks = niceTicks(lo, Math.max(a, b), bounded && lo >= 0 ? { min: 0 } : {}, true);
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        for (const t of ticks) expect(Number.isInteger(t)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('LineChart domain', () => {
  const ticksOf = (c: HTMLElement): number[] =>
    [...c.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent.replace(',', '.').replace('−', '-')));

  it('a flat series at 0 with a lower bound of 0 gets a 0..1 axis, not −1..1', () => {
    const { container } = render(
      <LineChart series={[{ name: 'a', points: [{ x: '1', y: 0 }, { x: '2', y: 0 }] }]} yLabel="уровень" domain={{ min: 0 }} />,
    );
    const ticks = ticksOf(container);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBe(1);
  });

  it('100 % with a 0..100 domain stays at or below 100', () => {
    const { container } = render(
      <LineChart series={[{ name: 'a', points: [{ x: '№1', y: 100 }, { x: '№2', y: 100 }] }]} yLabel="%" domain={{ min: 0, max: 100 }} />,
    );
    const ticks = ticksOf(container);
    expect(ticks.at(-1)).toBe(100);
    expect(ticks[0]).toBeGreaterThanOrEqual(80);
    expect(ticks[0]).toBeLessThan(100);
  });

  it('values far from the bounds are not stretched to them', () => {
    const { container } = render(<LineChart series={[{ name: 'a', points: three }]} yLabel="мс" domain={{ min: 0 }} />);
    expect(Math.min(...ticksOf(container))).toBeGreaterThan(200);
  });
});

describe('niceTicks', () => {
  it('clamps the padding of a flat range to the domain', () => {
    expect(niceTicks(0, 0, { min: 0 })).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(100, 100, { min: 0, max: 100 })).toEqual([90, 92, 94, 96, 98, 100]);
    expect(niceTicks(0, 0)).toEqual([-1, -0.5, 0, 0.5, 1]);
  });

  it('a bound off the tick grid closes the axis so the data stay covered', () => {
    expect(niceTicks(0, 7, { max: 7 })).toEqual([0, 2, 4, 6, 7]);
    expect(niceTicks(3, 10, { min: 3 })).toEqual([3, 4, 6, 8, 10]);
  });

  it('data a rounding step outside the domain are clamped into it, not a reason to drop it', () => {
    // 1 ULP above 7 and 1 ULP below 3: the bounds still close the axis.
    expect(niceTicks(0, 7 + 2 ** -50, { max: 7 })).toEqual([0, 2, 4, 6, 7]);
    expect(niceTicks(3 - 2 ** -51, 10, { min: 3 })).toEqual([3, 4, 6, 8, 10]);
    // −1e-13 from a difference of RTs around 300 ms is noise below a non-negative metric's 0.
    expect(niceTicks(-1e-13, 300, { min: 0 })).toEqual(niceTicks(0, 300, { min: 0 }));
    // Data really outside the domain still make it ignored.
    expect(niceTicks(0, 7.5, { max: 7 })).toEqual(niceTicks(0, 7.5));
    expect(niceTicks(-0.001, 10, { min: 0 })).toEqual(niceTicks(-0.001, 10));
  });

  it('never inserts an infinite bound when a value sits just below a tick (R39)', () => {
    expect(niceTicks(20 - 1e-12, 119)).toEqual([20, 40, 60, 80, 100, 120]);
    expect(niceTicks(1, 100 + 1e-12)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('keeps finite, increasing ticks that cover the data inside the domain (property)', () => {
    const milli = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }).map((n) => n / 1000);
    const input = fc
      .record({
        a: milli,
        gap: fc.oneof(fc.constant(0), fc.integer({ min: 10, max: 2_000_000_000 }).map((n) => n / 1000)),
        shiftMin: fc.constantFrom(0, 0, 1e-12, -1e-12),
        shiftMax: fc.constantFrom(0, 0, 1e-12, -1e-12),
        domain: fc.boolean(),
        below: fc.integer({ min: 1, max: 1000 }).map((n) => n / 10),
        above: fc.integer({ min: 1, max: 1000 }).map((n) => n / 10),
      })
      .map((r) => {
        // Nudging only makes sense for a real range: a flat one stays flat (the padded case has its own test).
        const nudged = r.gap > 0;
        const min = nudged ? r.a + r.shiftMin : r.a;
        const max = nudged ? Number((r.a + r.gap).toFixed(3)) + r.shiftMax : r.a; // three decimals, as measured values are
        const domain = r.domain ? { min: min - r.below, max: max + r.above } : undefined; // a real domain: it contains [min, max] and has room around it
        return { lo: min, hi: max, domain };
      });
    fc.assert(
      fc.property(input, ({ lo, hi, domain }) => {
        const ticks = niceTicks(lo, hi, domain);
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        for (const t of ticks) expect(Number.isFinite(t)).toBe(true);
        for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]).toBeGreaterThan(ticks[i - 1] as number);
        const step = (ticks[1] as number) - (ticks[0] as number);
        expect(ticks[0]).toBeLessThanOrEqual(lo + 1e-9 * step);
        expect(ticks.at(-1)).toBeGreaterThanOrEqual(hi - 1e-9 * step);
        if (domain !== undefined) {
          for (const t of ticks) {
            expect(t).toBeGreaterThanOrEqual(domain.min);
            expect(t).toBeLessThanOrEqual(domain.max);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('terminates with finite, increasing ticks for degenerate and non-finite input (property)', () => {
    const num = fc.oneof(
      fc.double({ noNaN: false }), // includes ±Infinity, NaN, ±0 and subnormals
      fc.double({ min: -1e12, max: 1e12 }),
      fc.constantFrom(0, 1, -1, 5, 1e15, -1e15, 1e300, Number.MAX_VALUE, Number.MIN_VALUE, 1e9 + 1e-6),
    );
    const bound = fc.option(num, { nil: undefined });
    const domain = fc.option(fc.record({ min: bound, max: bound }), { nil: undefined });
    // The same value on both sides makes min === max, a zero-width domain; swapped values make an inverted one.
    const pair = fc.oneof(fc.tuple(num, num), num.map((v) => [v, v] as const));
    fc.assert(
      fc.property(pair, domain, ([a, b], d) => {
        const ticks = niceTicks(a, b, d === undefined ? undefined : { ...(d.min === undefined ? {} : { min: d.min }), ...(d.max === undefined ? {} : { max: d.max }) });
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        for (const t of ticks) expect(Number.isFinite(t)).toBe(true);
        for (let i = 1; i < ticks.length; i += 1) expect(ticks[i]).toBeGreaterThan(ticks[i - 1] as number);
      }),
      { numRuns: 1000 },
    );
  });

  it('handles a zero-width or inverted domain, swapped bounds and non-finite values', () => {
    expect(niceTicks(5, 5, { min: 5, max: 5 })).toEqual(niceTicks(5, 5));
    expect(niceTicks(0, 10, { min: 8, max: 2 })).toEqual(niceTicks(0, 10));
    expect(niceTicks(10, 0)).toEqual(niceTicks(0, 10));
    expect(niceTicks(Number.NaN, Number.NaN)).toEqual(niceTicks(0, 0));
    expect(niceTicks(Number.NEGATIVE_INFINITY, 10)).toEqual(niceTicks(10, 10));
    expect(niceTicks(1e16, 1e16 + 2).length).toBeGreaterThanOrEqual(2); // clamped to the axis limit, then padded
    expect(niceTicks(0, 1e-12)).toEqual([5e-13 - 1, 5e-13 + 1]); // finer than a label can show: mid ± 1
    expect(niceTicks(0, 10, { min: 2, max: 8 })).toEqual(niceTicks(0, 10)); // a domain that misses the data is ignored
  });

  it('never returns −0', () => {
    for (const t of niceTicks(-0.4, 0.4)) expect(Object.is(t, -0)).toBe(false);
  });


  it('rounds to 1, 2 or 5 times a power of ten', () => {
    expect(niceTicks(288, 314)).toEqual([280, 290, 300, 310, 320]);
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0.31, 0.74)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  });

  it('always returns at least three ticks covering the range', () => {
    for (const [lo, hi] of [[0, 1], [3.2, 3.8], [-5, 5], [12, 12.4], [1000, 1900]] as const) {
      const t = niceTicks(lo, hi);
      expect(t.length).toBeGreaterThanOrEqual(3);
      expect(t[0]).toBeLessThanOrEqual(lo);
      expect(t.at(-1)).toBeGreaterThanOrEqual(hi);
    }
  });
});

describe('LineChart noise bands (F7)', () => {
  const two = [
    { name: 'V', points: [{ x: '№1', y: 40 }, { x: '№2', y: 42 }, { x: '№3', y: 41 }] },
    { name: 'P', points: [{ x: '№1', y: 80 }, { x: '№2', y: 82 }, { x: '№3', y: 81 }] },
  ];
  const band = (lo: number, hi: number) => ['№1', '№2', '№3'].map((x) => ({ x, lo, hi }));

  it('bands draw one polygon per series in its colour, under the lines', () => {
    const { container } = render(<LineChart series={two} yLabel="с" bands={[band(38, 44), band(78, 84)]} />);
    const polygons = [...container.querySelectorAll('polygon.chart-band')];
    expect(polygons).toHaveLength(2);
    expect(polygons.map((p) => p.parentElement?.getAttribute('class'))).toEqual(['s1', 's2']);
    // Three slots: three points along the top edge and three back along the bottom.
    expect(polygons[0]?.getAttribute('points')?.split(' ')).toHaveLength(6);
    // The bands come before the first line, so the lines draw over them.
    const svg = container.querySelector('svg') as SVGElement;
    const order = [...svg.querySelectorAll('polygon.chart-band, path.chart-line')].map((e) => e.tagName);
    expect(order).toEqual(['polygon', 'polygon', 'path', 'path']);
  });

  it('the y axis includes the band edges', () => {
    const { container } = render(<LineChart series={[{ name: 'ПЗМР', points: three }]} yLabel="мс" bands={[band(250, 350)]} />);
    const ticks = [...container.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent));
    expect(Math.min(...ticks)).toBeLessThanOrEqual(250);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(350);
  });

  it('a band stays inside the domain; one on fewer than two slots or on unknown slots is not drawn', () => {
    const near0 = [{ name: 'a', points: [{ x: '1', y: 2 }, { x: '2', y: 1 }, { x: '3', y: 3 }] }];
    const { container } = render(<LineChart series={near0} yLabel="мс" domain={{ min: 0 }} whole bands={[[{ x: '1', lo: -5, hi: 6 }, { x: '2', lo: -5, hi: 6 }, { x: '3', lo: -5, hi: 6 }]]} />);
    const ticks = [...container.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent));
    expect(Math.min(...ticks)).toBe(0);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(6);
    const lone = render(<LineChart series={near0} yLabel="мс" whole bands={[[{ x: '1', lo: -50, hi: 60 }, { x: 'нет', lo: -50, hi: 60 }]]} />);
    expect(lone.container.querySelector('polygon')).toBeNull();
    // Nor does it stretch the axis.
    expect(Math.max(...[...lone.container.querySelectorAll('text.y-tick')].map((t) => Number(t.textContent)))).toBeLessThan(60);
  });

  it('two points with one label (two runs on one day) take one slot each', () => {
    const sameDay = [{ name: 'a', points: [{ x: '01.10', y: 10 }, { x: '01.10', y: 12 }, { x: '02.10', y: 11 }] }];
    const { container } = render(
      <LineChart series={sameDay} yLabel="мс" bands={[[{ x: '01.10', lo: 8, hi: 14 }, { x: '01.10', lo: 8, hi: 14 }, { x: '02.10', lo: 8, hi: 14 }]]} />,
    );
    const xs = (container.querySelector('polygon')?.getAttribute('points') ?? '').split(' ').map((p) => p.split(',')[0]);
    expect(new Set(xs.slice(0, 3)).size).toBe(3);
  });
});
