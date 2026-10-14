import { deriveModuleStates, deriveRatings, MODULE_IDS } from '../engine/derive';
import type { Repository } from './repository';
import type { TrialRow } from './rows';

/**
 * Recomputes the caches (module_state, ratings) from history and saves them.
 * Diagnostic sessions never count: deriveModuleStates skips their blocks, and logic items
 * are passed on only when their block belongs to a non-diagnostic session (Ruling R19).
 */
export async function rebuildCaches(repo: Repository): Promise<void> {
  const [sessions, blocks, items] = await Promise.all([repo.listSessions(), repo.listBlocks(), repo.listLogicItems()]);
  const kindBySession = new Map(sessions.map((s) => [s.id, s.kind]));
  const countedBlocks = new Set(
    blocks.filter((b) => {
      const kind = kindBySession.get(b.sessionId);
      return kind !== undefined && kind !== 'diagnostic';
    }).map((b) => b.id),
  );

  const states = deriveModuleStates(sessions, blocks);
  for (const m of MODULE_IDS) await repo.saveModuleState(states[m]);
  await repo.saveRatings(deriveRatings(items.filter((i) => countedBlocks.has(i.blockId))));
}

/** JSON of every history table plus settings (caches are left out: rebuildCaches restores them). */
export async function exportBundle(repo: Repository, appVersion: string): Promise<string> {
  const sessions = await repo.listSessions();
  const blocks = await repo.listBlocks();
  const trials: TrialRow[] = [];
  for (const b of blocks) trials.push(...(await repo.listTrials(b.id)));
  const bundle = {
    appVersion,
    exportedAt: new Date().toISOString(),
    sessions,
    blocks,
    trials,
    logicItems: await repo.listLogicItems(),
    diagnostics: await repo.listDiagnostics(),
    wellbeing: await repo.listWellbeing(),
    settings: await repo.getSettings(),
  };
  return JSON.stringify(bundle, null, 2);
}

const NEEDS_QUOTES = /[;"\r\n]/;

function csvText(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(v);
    case 'object':
      return v === null ? '' : JSON.stringify(v);
    default:
      return ''; // undefined, functions, symbols
  }
}

function csvField(v: unknown): string {
  const s = csvText(v);
  return NEEDS_QUOTES.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** RFC 4180 with ';' as separator (Excel in Russian locales): CRLF between records, no trailing CRLF. */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const header: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        header.push(k);
      }
    }
  }
  const lines = [header.map(csvField).join(';'), ...rows.map((r) => header.map((k) => csvField(r[k])).join(';'))];
  return lines.join('\r\n');
}
