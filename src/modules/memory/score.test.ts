import { describe, expect, it } from 'vitest';
import { createRng } from '../../engine/rng';
import type { MemoryTrial } from './generate';
import { spanProtocolTrials } from './generate';
import { memorySpan, scoreMemoryBlock, scoreMemoryTrial, spanProtocolStops, type MemoryAnswer } from './score';

const trial = (items: string[]): MemoryTrial => ({
  mode: 'digits',
  items,
  gridSide: 0,
  rows: 0,
  itemMs: 1000,
  gapMs: 250,
  cardMs: items.length * 1000,
  sound: false,
});
const answer = (given: string[]): MemoryAnswer => ({ given, timeMs: 3000 });

const T = trial(['3', '8', '1', '5', '9', '2']);

describe('scoreMemoryTrial', () => {
  it('an exact answer', () => {
    expect(scoreMemoryTrial(T, answer(['3', '8', '1', '5', '9', '2']))).toEqual({ exact: true, positionsCorrect: 6 });
  });

  it('two items swapped: not exact, length − 2 in place', () => {
    expect(scoreMemoryTrial(T, answer(['3', '1', '8', '5', '9', '2']))).toEqual({ exact: false, positionsCorrect: 4 });
  });

  it('a short answer counts the positions it has', () => {
    expect(scoreMemoryTrial(T, answer(['3', '8', '1']))).toEqual({ exact: false, positionsCorrect: 3 });
    expect(scoreMemoryTrial(T, answer([]))).toEqual({ exact: false, positionsCorrect: 0 });
  });

  it('extra items make it not exact', () => {
    expect(scoreMemoryTrial(T, answer(['3', '8', '1', '5', '9', '2', '7']))).toEqual({ exact: false, positionsCorrect: 6 });
  });
});

describe('scoreMemoryBlock (F13)', () => {
  it('s is the share of positions right over every row shown; the exact rows are counted on the side', () => {
    const rows = [trial(['1', '2', '3', '4']), trial(['5', '6', '7', '8']), trial(['9', '0'])];
    const answers = [answer(['1', '2', '3', '4']), answer(['5', '6', '8', '7']), answer(['9'])];
    expect(scoreMemoryBlock(rows, answers)).toEqual({ exact: 1, positionsCorrect: 7, partial: 0.7 });
  });

  it('fewer answers than rows: only the rows answered count; none answered is 0', () => {
    const rows = [trial(['1', '2']), trial(['3', '4'])];
    expect(scoreMemoryBlock(rows, [answer(['1', '2'])])).toEqual({ exact: 1, positionsCorrect: 2, partial: 1 });
    expect(scoreMemoryBlock(rows, [])).toEqual({ exact: 0, positionsCorrect: 0, partial: 0 });
    expect(() => scoreMemoryBlock(rows.slice(0, 1), [answer([]), answer([])])).toThrow(RangeError);
  });
});

/** Trials of the span protocol with lengths 3, 3, 4, 4 (the first four). */
const SPAN = spanProtocolTrials(createRng(3));
const right = (t: MemoryTrial): MemoryAnswer => answer([...t.items]);
const wrong = (t: MemoryTrial): MemoryAnswer => answer(t.items.slice(1));

describe('span protocol', () => {
  it('[right, wrong, wrong, wrong] on 3, 3, 4, 4: stops after the 4th answer, span 3', () => {
    const answers = [right, wrong, wrong, wrong].map((f, i) => f(SPAN[i] as MemoryTrial));
    expect(spanProtocolStops(SPAN, answers.slice(0, 1))).toBe(false);
    expect(spanProtocolStops(SPAN, answers.slice(0, 2))).toBe(false);
    expect(spanProtocolStops(SPAN, answers.slice(0, 3))).toBe(false);
    expect(spanProtocolStops(SPAN, answers)).toBe(true);
    expect(memorySpan(SPAN, answers)).toBe(3);
  });

  it('both wrong at length 3: stop after the second answer, span 0', () => {
    const answers = SPAN.slice(0, 2).map(wrong);
    expect(spanProtocolStops(SPAN, answers)).toBe(true);
    expect(memorySpan(SPAN, answers)).toBe(0);
  });

  it('all 20 right: never stops, span 12', () => {
    const answers = SPAN.map(right);
    for (let n = 1; n <= answers.length; n++) expect(spanProtocolStops(SPAN, answers.slice(0, n))).toBe(false);
    expect(memorySpan(SPAN, answers)).toBe(12);
  });

  it('one right of the pair keeps going; no answers: no stop, span 0', () => {
    expect(spanProtocolStops(SPAN, [wrong(SPAN[0] as MemoryTrial), right(SPAN[1] as MemoryTrial)])).toBe(false);
    expect(spanProtocolStops(SPAN, [])).toBe(false);
    expect(memorySpan(SPAN, [])).toBe(0);
  });

  it('more answers than trials is a caller error', () => {
    expect(() => spanProtocolStops(SPAN.slice(0, 1), SPAN.slice(0, 2).map(right))).toThrow(RangeError);
    expect(() => memorySpan(SPAN.slice(0, 1), SPAN.slice(0, 2).map(right))).toThrow(RangeError);
  });
});
