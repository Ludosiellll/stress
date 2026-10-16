import type { BlockRow } from '../data/rows';
import { localDayIso } from '../engine/dates';
import type { FormDay } from '../engine/dayForm';
import { isCountedSession, storedBand } from '../engine/derive';
import type { BlockFlag, ReactionModuleId, SessionKind } from '../engine/types';
import { FLOOR_HITS } from '../engine/windowFloor';
import { bandIndex } from '../modules/reaction/common';
import { pzmr } from '../modules/reaction/pzmr';
import { parseObject } from './blockHistory';

/**
 * The block history the controller read at start (assessment О11, with the same listBlocks + listSessions as the
 * assessment history), plus every block of the session once it is stored. Rows may be old or imported: whatever is
 * read from their JSON is read defensively.
 */
export interface PastBlocks {
  /** In listBlocks order (by startedAt), then the blocks of this session as they are stored. */
  blocks: BlockRow[];
  /** Session id → kind, for every block above. */
  kinds: Map<string, SessionKind>;
}

/** The blocks of known sessions; a block of an unknown session is left out (as in buildBlockHistory). */
export function pastBlocks(blocks: readonly BlockRow[], sessions: readonly { id: string; kind: SessionKind }[]): PastBlocks {
  const past: PastBlocks = { blocks: [], kinds: new Map(sessions.map((s) => [s.id, s.kind])) };
  for (const row of blocks) if (past.kinds.has(row.sessionId)) past.blocks.push(row);
  return past;
}

/** A block of this session, once it is stored. */
export function appendPast(past: PastBlocks, row: BlockRow, kind: SessionKind): void {
  past.kinds.set(row.sessionId, kind);
  past.blocks.push(row);
}

/**
 * The history as it will be once `row` is stored, `past` left as it is: what the block about to be stored changes for
 * the next block (its window floor, T-R50) is told in its summary before the commit.
 */
export function withBlock(past: PastBlocks, row: BlockRow, kind: SessionKind): PastBlocks {
  const next: PastBlocks = { blocks: [...past.blocks], kinds: new Map(past.kinds) };
  appendPast(next, row, kind);
  return next;
}

/** summaryJson.cleanHitRts (the clean hit RTs of a reaction block, F5); null when absent or damaged. */
export function readCleanHits(summaryJson: string): number[] | null {
  const rts = parseObject(summaryJson)?.['cleanHitRts'];
  if (!Array.isArray(rts)) return null;
  const values: unknown[] = rts;
  return values.every((x): x is number => typeof x === 'number' && Number.isFinite(x)) ? values : null;
}

/** The local day of a stored date; null when it cannot be read. */
function localDay(iso: string): string | null {
  try {
    return localDayIso(iso);
  } catch {
    return null;
  }
}

/**
 * The warm-up blocks of training and free sessions for «Форма дня» (F5): one FormDay per block, by its local day and
 * the ПЗМР band of lBefore (⌊lBefore/4⌋ up to the ladder's last band, Р15), with its cleanHitRts. Blocks without
 * readable RTs or a readable date are left out.
 */
export function warmupDays(past: PastBlocks): FormDay[] {
  const days: FormDay[] = [];
  for (const row of past.blocks) {
    const kind = past.kinds.get(row.sessionId);
    if (!row.flags.includes('warmup') || kind === undefined || !isCountedSession(kind)) continue;
    const rts = readCleanHits(row.summaryJson);
    const day = localDay(row.startedAt);
    if (rts !== null && day !== null) days.push({ day, band: bandIndex(pzmr, row.lBefore), rts });
  }
  return days;
}

/**
 * Blocks whose hits never feed the window floor (F3, Справочник): overload blocks play another band's load, and a
 * timing_unreliable block measured nothing. Warm-up, fatigued and calibration blocks do feed it. `test_format`
 * (Task 10) and `discarded` (Task 13) join this list with their flags.
 */
const NOT_FLOOR_FLAGS: readonly BlockFlag[] = ['overload', 'timing_unreliable'];

/** The load band a block played (paramsJson.band, a whole number from 0) and its clean hits; null: either is unreadable. */
interface BandHits {
  band: number;
  rts: readonly number[];
}

/** Rows are never changed once stored: each is read once (the floor is asked for before every block). */
const bandHitsRead = new WeakMap<BlockRow, BandHits | null>();

function bandHitsOf(row: BlockRow): BandHits | null {
  const known = bandHitsRead.get(row);
  if (known !== undefined) return known;
  const band = storedBand(row.paramsJson);
  const rts = readCleanHits(row.summaryJson);
  const read = band !== null && rts !== null ? { band, rts } : null;
  bandHitsRead.set(row, read);
  return read;
}

/**
 * The clean hits of `module` per load band, the source of the window floor (F3, Справочник): blocks of training and
 * free sessions with a numeric paramsJson.band and readable cleanHitRts, without NOT_FLOOR_FLAGS; in block order (by
 * startedAt), within a block in trial order. Only the last FLOOR_HITS of a band are kept: all the floor reads.
 */
export function cleanHitsByBand(past: PastBlocks, module: ReactionModuleId): Map<number, number[]> {
  // From the latest block back, until a band has FLOOR_HITS.
  const chunks = new Map<number, Array<readonly number[]>>();
  const counts = new Map<number, number>();
  for (let i = past.blocks.length - 1; i >= 0; i--) {
    const row = past.blocks[i] as BlockRow;
    if (row.module !== module || row.flags.some((f) => NOT_FLOOR_FLAGS.includes(f))) continue;
    const kind = past.kinds.get(row.sessionId);
    if (kind === undefined || !isCountedSession(kind)) continue;
    const hits = bandHitsOf(row);
    if (hits === null) continue;
    const have = counts.get(hits.band) ?? 0;
    if (have >= FLOOR_HITS) continue;
    counts.set(hits.band, have + hits.rts.length);
    const list = chunks.get(hits.band);
    if (list === undefined) chunks.set(hits.band, [hits.rts]);
    else list.push(hits.rts);
  }
  return new Map([...chunks].map(([band, list]) => [band, list.reverse().flat().slice(-FLOOR_HITS)]));
}
