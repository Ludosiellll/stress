import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import { block, session } from '../data/repository.contract';
import type { BlockRow } from '../data/rows';
import {
  appendPast,
  cleanHitsByBand,
  pastBlocks,
  rdoCycleCount,
  readCleanHits,
  testFormatRuns,
  testFormatRunsAt,
  warmupDays,
  withBlock,
} from './pastBlocks';
import type { TestFormatMetrics } from './testFormat';

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

  it('withBlock: the history with a block about to be stored, the history itself unchanged (T-R50)', () => {
    const a = block('a', 't', '2026-10-10T09:01:00');
    const past = pastBlocks([a], sessions);
    const c = block('c', 'now', '2026-10-15T09:01:00');
    const next = withBlock(past, c, 'free');
    expect(next.blocks).toEqual([a, c]);
    expect(next.kinds.get('now')).toBe('free');
    expect(past.blocks).toEqual([a]);
    expect(past.kinds.has('now')).toBe(false);
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
      // Left out: overload, timing_unreliable, test-format and counted Esc blocks, a diagnostic, a block without a band,
      // another module. A test-format run plays the frozen diagnostic parameters (F4): its band field is the format's
      // band 0. A counted Esc block (F11, T-R4) stores no hits; were any there, they would not count either.
      played('g', 't', '2026-10-10T09:05:00', 1, [901], { flags: ['overload'] }),
      played('p', 'f', '2026-10-11T09:06:00', 1, [907], { flags: ['discarded'] }),
      played('h', 't', '2026-10-10T09:06:00', 0, [902], { flags: ['timing_unreliable', 'fatigued'] }),
      played('m', 'f', '2026-10-11T09:05:00', 0, [906], { flags: ['test_format'] }),
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

describe('testFormatRuns', () => {
  const sessions = [
    session('t', '2026-10-10T09:00:00'),
    session('f', '2026-10-11T09:00:00', { kind: 'free' }),
    session('d', '2026-10-12T09:00:00', { kind: 'diagnostic' }),
  ];
  const metrics = (mean: number): TestFormatMetrics => ({ mean, sd: 30, errors: 1, falseStarts: 0, thirds: [mean, mean, mean] });
  const run = (id: string, sessionId: string, startedAt: string, summary: unknown, over: Partial<BlockRow> = {}): BlockRow =>
    block(id, sessionId, startedAt, { flags: ['test_format'], summaryJson: JSON.stringify(summary), ...over });

  it('the stored runs of a format in block order: training and free blocks with the flag and a readable summary', () => {
    const past = pastBlocks(
      [
        run('a', 't', '2026-10-10T09:01:00', { meanRt: 250, testFormat: metrics(250) }),
        run('b', 'f', '2026-10-11T09:01:00', { testFormat: metrics(240) }, { flags: ['test_format', 'timing_unreliable'] }),
        // Left out: another format, a diagnostic, a block without the flag, a damaged summary.
        run('c', 't', '2026-10-10T09:02:00', { testFormat: metrics(300) }, { module: 'szmr' }),
        run('e', 'd', '2026-10-12T09:01:00', { testFormat: metrics(200) }),
        run('g', 't', '2026-10-10T09:03:00', { testFormat: metrics(210) }, { flags: [] }),
        run('h', 't', '2026-10-10T09:04:00', { testFormat: { mean: 'x' } }),
        block('i', 't', '2026-10-10T09:05:00', { flags: ['test_format'], summaryJson: 'not json' }),
        // A run counted as 0 after Esc (F11) is no one's best (T-R10): it stores no metrics, and the flag keeps it out anyway.
        run('k', 't', '2026-10-10T09:06:00', { testFormat: metrics(100) }, { flags: ['test_format', 'discarded'] }),
      ],
      sessions,
    );
    expect(testFormatRuns(past, 'pzmr')).toEqual([metrics(250), metrics(240)]);
    expect(testFormatRunsAt(past, 'pzmr').map((r) => r.at)).toEqual(['2026-10-10T09:01:00', '2026-10-11T09:01:00']);
    expect(testFormatRuns(past, 'szmr')).toEqual([metrics(300)]);
    expect(testFormatRuns(past, 'rdo')).toEqual([]);
  });
});

describe('rdoCycleCount (T-R61)', () => {
  const sessions = [
    session('t', '2026-10-10T09:00:00'),
    session('f', '2026-10-11T09:00:00', { kind: 'free' }),
    session('d', '2026-10-12T09:00:00', { kind: 'diagnostic' }),
  ];
  const rdo = (id: string, sessionId: string, over: Partial<BlockRow> = {}): BlockRow =>
    block(id, sessionId, '2026-10-10T09:01:00', { module: 'rdo', ...over });

  it('counts the РДО blocks of training and free sessions that played a speed of the cycle', () => {
    const past = pastBlocks(
      [
        rdo('a', 't'),
        rdo('b', 'f', { flags: ['calibration'] }),
        // An overload block of a mix or a finisher plays the speed of its slot; frames dropped or not, it played it.
        rdo('c', 't', { flags: ['overload'] }),
        rdo('e', 'f', { flags: ['timing_unreliable', 'fatigued'] }),
        // Left out: a test-format run (3000 ms), a block counted as 0 after Esc, a diagnostic, another module, an
        // unknown session.
        rdo('g', 't', { flags: ['test_format'] }),
        rdo('h', 'f', { flags: ['discarded'] }),
        rdo('i', 'd'),
        block('k', 't', '2026-10-10T09:02:00', { module: 'pzmr' }),
        rdo('m', 'gone'),
      ],
      sessions,
    );
    expect(rdoCycleCount(past)).toBe(4);
    appendPast(past, rdo('n', 'now'), 'free');
    expect(rdoCycleCount(past)).toBe(5);
    expect(rdoCycleCount(pastBlocks([], sessions))).toBe(0);
  });
});
