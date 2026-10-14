import { describe, expect, it } from 'vitest';
import { parseAnswer } from './parse';

describe('parseAnswer', () => {
  it.each([
    [' 42 ', 42],
    ['−17', -17],
    ['–5', -5],
    ['007', 7],
    ['1 000', 1000],
  ])('reads %j as %d (brief examples)', (raw, expected) => {
    expect(parseAnswer(raw)).toBe(expected);
  });

  it.each(['', 'abc', '4.5', '-'])('rejects %j (brief examples)', (raw) => {
    expect(parseAnswer(raw)).toBeNull();
  });

  it('reads an em dash as a minus', () => {
    expect(parseAnswer('—8')).toBe(-8);
  });

  it('drops no-break, thin and narrow no-break spaces inside the number', () => {
    expect(parseAnswer('1\u00a0000')).toBe(1000);
    expect(parseAnswer('12\u2009345')).toBe(12345);
    expect(parseAnswer('\u202f-1\u202f000\u202f')).toBe(-1000);
    expect(parseAnswer('\t5\n')).toBe(5);
  });

  it('keeps a minus that is separated from the digits by spaces', () => {
    expect(parseAnswer('− 5')).toBe(-5);
  });

  it('reads -0 as plain 0', () => {
    expect(Object.is(parseAnswer('-0'), 0)).toBe(true);
    expect(Object.is(parseAnswer('−000'), 0)).toBe(true);
  });

  it('accepts safe integers only (R14)', () => {
    expect(parseAnswer('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseAnswer('−9007199254740991')).toBe(-Number.MAX_SAFE_INTEGER);
    expect(parseAnswer('9007199254740992')).toBeNull();
    expect(parseAnswer('9007199254740993')).toBeNull();
    expect(parseAnswer('9'.repeat(400))).toBeNull();
  });

  it.each(['+5', '5-', '--5', '1,5', '1.000', '12a', '٣', '1e3', ' ', '\u00a0', '0x10'])(
    'rejects %j',
    (raw) => {
      expect(parseAnswer(raw)).toBeNull();
    },
  );
});
