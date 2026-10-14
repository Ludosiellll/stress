import { render, within } from '@testing-library/react';
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

describe('niceTicks', () => {
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
