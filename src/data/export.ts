import { deriveModuleStates, deriveRatings, isCountedSession, MODULE_IDS } from '../engine/derive';
import type { Repository } from './repository';

/**
 * Recomputes the caches (module_state, ratings) from history and saves them. Reads the light block rows of
 * each module (listBlockLevels), never the full block history (M6).
 * Only counted sessions (isCountedSession: training, free) feed the caches: deriveModuleStates
 * skips other blocks, and logic items are passed on only when their block belongs to a counted session (R19).
 */
export async function rebuildCaches(repo: Repository): Promise<void> {
  const [sessions, perModule, items] = await Promise.all([
    repo.listSessions(),
    Promise.all(MODULE_IDS.map((m) => repo.listBlockLevels(m))),
    repo.listLogicItems(),
  ]);
  const blocks = perModule.flat();
  const kindBySession = new Map(sessions.map((s) => [s.id, s.kind]));
  const countedBlocks = new Set(
    blocks.filter((b) => {
      const kind = kindBySession.get(b.sessionId);
      return kind !== undefined && isCountedSession(kind);
    }).map((b) => b.id),
  );

  const states = deriveModuleStates(sessions, blocks);
  for (const m of MODULE_IDS) await repo.saveModuleState(states[m]);
  await repo.saveRatings(deriveRatings(items.filter((i) => countedBlocks.has(i.blockId))));
}

/** JSON of every history table plus settings (caches are left out: rebuildCaches restores them). */
export async function exportBundle(repo: Repository, appVersion: string): Promise<string> {
  const bundle = {
    appVersion,
    exportedAt: new Date().toISOString(),
    sessions: await repo.listSessions(),
    blocks: await repo.listBlocks(),
    trials: await repo.listAllTrials(),
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

/**
 * RFC 4180 with ';' as separator (Excel in Russian locales): CRLF between records, no trailing CRLF.
 * No BOM here (pure text); the export UI (Task 14) prepends '\uFEFF' when it writes a .csv file so Excel reads UTF-8.
 */
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
