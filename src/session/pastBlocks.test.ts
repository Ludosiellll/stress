import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import { block, session } from '../data/repository.contract';
import type { BlockRow } from '../data/rows';
import { appendPast, cleanHitsByBand, pastBlocks, readCleanHits, warmupDays } from './pastBlocks';

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

describe('cleanHitsByBand', () => {
  const sessions = [
    session('t', '2026-10-10T09:00:00'),
    session('f', '2026-10-11T09:00:00', { kind: 'free' }),
    session('d', '2026-10-12T09:00:00', { kind: 'diagnostic' }),
  ];
  /** A block played on load band `band` (as paramsJson stores it) with these clean hit RTs. */
  const played = (id: string, sessionId: string, startedAt: string, band: unknown, rts: unknown, over: Partial<BlockRow> = {}): BlockRow =>
    block(id, sessionId, startedAt, { paramsJson: JSON.stringify({ band, windowMs: 500 }), summaryJson: hits(rts), ...over });

  it('cleanHitsByBand follows the source rules (F3): training and free blocks of the module by band, in startedAt order', async () => {
    const repo = new MemoryRepository();
    for (const s of sessions) await repo.createSession(s);
    // Added out of order: listBlocks gives them by startedAt.
    const rows = [
      played('b', 'f', '2026-10-11T09:02:00', 0, [302, 303]),
      played('a', 't', '2026-10-10T09:01:00', 0, [301], { flags: ['calibration'] }),
      played('e', 'f', '2026-10-11T09:04:00', 1, [312], { flags: ['fatigued'] }),
      played('c', 't', '2026-10-10T09:03:00', 1, [311], { flags: ['warmup'] }),
      // Left out: overload and timing_unreliable blocks, a diagnostic, a block without a band, another module.
      played('g', 't', '2026-10-10T09:05:00', 1, [901], { flags: ['overload'] }),
      played('h', 't', '2026-10-10T09:06:00', 0, [902], { flags: ['timing_unreliable', 'fatigued'] }),
      played('i', 'd', '2026-10-12T09:01:00', 0, [903]),
      block('j', 't', '2026-10-10T09:07:00', { summaryJson: hits([904]) }),
      played('k', 't', '2026-10-10T09:08:00', 0, [905], { module: 'szmr' }),
    ];
    for (const row of rows) await repo.addBlock(row, [], []);
    const past = pastBlocks(await repo.listBlocks(), await repo.listSessions());
    expect(cleanHitsByBand(past, 'pzmr')).toEqual(
      new Map([
        [0, [301, 302, 303]],
        [1, [311, 312]],
      ]),
    );
    expect(cleanHitsByBand(past, 'szmr')).toEqual(new Map([[0, [905]]]));
    expect(cleanHitsByBand(past, 'rdo')).toEqual(new Map());
    // A block of this session joins once it is stored.
    appendPast(past, played('n', 'now', '2026-10-15T09:01:00', 1, [313]), 'training');
    expect(cleanHitsByBand(past, 'pzmr').get(1)).toEqual([311, 312, 313]);
  });

  it('a band keeps its last FLOOR_HITS (60) hits, all the floor reads', () => {
    const rts = (from: number): number[] => Array.from({ length: 25 }, (_, i) => from + i);
    const past = pastBlocks(
      [
        played('a', 't', '2026-10-10T09:01:00', 0, rts(100)),
        played('b', 't', '2026-10-10T09:02:00', 0, rts(200)),
        played('c', 't', '2026-10-10T09:03:00', 1, rts(300)),
        played('e', 't', '2026-10-10T09:04:00', 0, rts(400)),
      ],
      sessions,
    );
    const byBand = cleanHitsByBand(past, 'pzmr');
    expect(byBand.get(0)).toEqual([...rts(100).slice(-10), ...rts(200), ...rts(400)]);
    expect(byBand.get(1)).toEqual(rts(300));
  });

  it('damaged summaries are left out of the floor', () => {
    const past = pastBlocks(
      [
        played('a', 't', '2026-10-10T09:01:00', 0, [300]),
        played('b', 't', '2026-10-10T09:02:00', 0, [301], { summaryJson: 'not json' }),
        played('c', 't', '2026-10-10T09:03:00', 0, ['x']),
        played('e', 't', '2026-10-10T09:04:00', 0, [302], { paramsJson: 'not json' }),
        // A band that is no band: text, a fraction, below 0.
        played('g', 't', '2026-10-10T09:05:00', '0', [303]),
        played('h', 't', '2026-10-10T09:06:00', 0.5, [304]),
        played('i', 't', '2026-10-10T09:07:00', -1, [305]),
        played('k', 't', '2026-10-10T09:08:00', 0, [306]),
      ],
      sessions,
    );
    expect(cleanHitsByBand(past, 'pzmr')).toEqual(new Map([[0, [300, 306]]]));
  });
});
