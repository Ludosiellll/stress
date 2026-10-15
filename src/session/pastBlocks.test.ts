import { describe, expect, it } from 'vitest';
import { block, session } from '../data/repository.contract';
import type { BlockRow } from '../data/rows';
import { appendPast, pastBlocks, readCleanHits, warmupDays } from './pastBlocks';

const hits = (rts: unknown): string => JSON.stringify({ meanRt: 300, cleanHitRts: rts });

describe('readCleanHits', () => {
  it('reads cleanHitRts; null when absent or damaged', () => {
    expect(readCleanHits(hits([290.5, 300, 310]))).toEqual([290.5, 300, 310]);
    expect(readCleanHits(hits([]))).toEqual([]);
    expect(readCleanHits('{"meanRt":300}')).toBeNull();
    expect(readCleanHits('not json')).toBeNull();
    expect(readCleanHits('[1, 2]')).toBeNull();
    expect(readCleanHits(hits('300'))).toBeNull();
    expect(readCleanHits(hits([300, '310']))).toBeNull();
    expect(readCleanHits(hits([300, null]))).toBeNull();
    expect(readCleanHits('{"cleanHitRts":[300,1e999]}')).toBeNull();
  });
});

describe('pastBlocks', () => {
  const sessions = [session('t', '2026-10-10T09:00:00'), session('f', '2026-10-11T09:00:00', { kind: 'free' })];

  it('keeps the blocks of known sessions with their session kinds; appendPast adds a stored block', () => {
    const a = block('a', 't', '2026-10-10T09:01:00');
    const b = block('b', 'unknown', '2026-10-10T09:02:00');
    const past = pastBlocks([a, b], sessions);
    expect(past.blocks).toEqual([a]);
    expect(past.kinds.get('f')).toBe('free');
    const c = block('c', 'now', '2026-10-15T09:01:00');
    appendPast(past, c, 'training');
    expect(past.blocks).toEqual([a, c]);
    expect(past.kinds.get('now')).toBe('training');
  });

  it('copies its input: appending never touches the list it was built from', () => {
    const rows: BlockRow[] = [block('a', 't', '2026-10-10T09:01:00')];
    appendPast(pastBlocks(rows, sessions), block('c', 't', '2026-10-15T09:01:00'), 'training');
    expect(rows).toHaveLength(1);
  });
});

describe('warmupDays', () => {
  const sessions = [
    session('t', '2026-10-12T09:00:00'),
    session('f', '2026-10-13T23:00:00', { kind: 'free' }),
    session('d', '2026-10-13T09:00:00', { kind: 'diagnostic' }),
  ];
  const warm = (id: string, sessionId: string, startedAt: string, over: Partial<BlockRow> = {}): BlockRow =>
    block(id, sessionId, startedAt, { flags: ['warmup'], lBefore: 5, lAfter: 5, summaryJson: hits([290, 300]), ...over });

  it('warm-up blocks of training and free sessions, by local day and the ПЗМР band of lBefore (⌊lBefore/4⌋)', () => {
    const past = pastBlocks(
      [
        warm('a', 't', '2026-10-12T09:01:00'),
        warm('b', 'f', '2026-10-13T23:59:00', { lBefore: 8, lAfter: 8, summaryJson: hits([250]) }),
        warm('c', 'd', '2026-10-13T09:01:00'),
        block('e', 't', '2026-10-12T09:05:00', { summaryJson: hits([200]) }),
        warm('g', 't', '2026-10-12T09:02:00', { flags: ['warmup', 'timing_unreliable'], lBefore: 3.5, lAfter: 3.5 }),
      ],
      sessions,
    );
    expect(warmupDays(past)).toEqual([
      { day: '2026-10-12', band: 1, rts: [290, 300] },
      { day: '2026-10-13', band: 2, rts: [250] },
      { day: '2026-10-12', band: 0, rts: [290, 300] },
    ]);
  });

  it('the band stops at the last band of the ПЗМР ladder (Р15): 12 from L 48 on', () => {
    const past = pastBlocks(
      [
        warm('a', 't', '2026-10-12T09:01:00', { lBefore: 47.5, lAfter: 47.5 }),
        warm('b', 't', '2026-10-12T09:02:00', { lBefore: 48, lAfter: 48 }),
        warm('c', 't', '2026-10-12T09:03:00', { lBefore: 63, lAfter: 63 }),
      ],
      sessions,
    );
    expect(warmupDays(past).map((d) => d.band)).toEqual([11, 12, 12]);
  });

  it('blocks without cleanHitRts or with a damaged summary or date are left out', () => {
    const past = pastBlocks(
      [
        warm('a', 't', '2026-10-12T09:01:00', { summaryJson: '{"meanRt":300}' }),
        warm('b', 't', '2026-10-12T09:02:00', { summaryJson: 'not json' }),
        warm('c', 't', 'yesterday'),
        warm('g', 't', '2026-10-12T09:03:00', { summaryJson: hits([]) }),
      ],
      sessions,
    );
    expect(warmupDays(past)).toEqual([{ day: '2026-10-12', band: 1, rts: [] }]);
  });
});
