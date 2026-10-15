import type { BlockRow } from '../data/rows';
import { localDayIso } from '../engine/dates';
import type { FormDay } from '../engine/dayForm';
import { isCountedSession } from '../engine/derive';
import type { SessionKind } from '../engine/types';
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
