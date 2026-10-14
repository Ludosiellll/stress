import type { ExportBundle } from './bundleSchema';
import { rebuildCaches } from './export';
import type { HistoryTable, Repository } from './repository';
import type { LogicItemRow, Settings, TrialRow } from './rows';

/**
 * Restore from an export file (W2-R1): rows are merged by id, so history is only ever appended. A row whose id is
 * already stored is skipped; a second run of the same file adds nothing and goes on where a stopped run ended.
 * Order: sessions in batches, then each block with its trials and items in one transaction (addBlock), then
 * diagnostics and wellbeing in batches. The first failed write stops the restore; what was written before stays.
 */

/** Rows per batch transaction (sessions, diagnostics, wellbeing). */
export const IMPORT_CHUNK = 200;
/** Blocks between two progress reports and pauses that let the window repaint. */
export const YIELD_EVERY_BLOCKS = 20;

export interface Counted {
  total: number;
  /** Rows whose id is not stored yet. */
  fresh: number;
}

export interface ImportPreview {
  sessions: Counted;
  blocks: Counted;
  diagnostics: Counted;
  wellbeing: Counted;
  /** In the file. */
  trials: number;
  logicItems: number;
  /** The earliest and latest sessions.startedAt of the file (compared as times); null without sessions. */
  firstDate: string | null;
  lastDate: string | null;
}

export interface ImportCounts {
  imported: number;
  /** Rows of the file that were already stored. */
  skipped: number;
}

export interface ImportReport {
  sessions: ImportCounts;
  /** `failed`: the block whose write stopped the restore (0 or 1). */
  blocks: ImportCounts & { failed: number };
  diagnostics: ImportCounts;
  wellbeing: ImportCounts;
  /** Settings taken from the file: only keys never saved on this computer, and only when the value differs. */
  settingsFilled: Array<'testDate' | 'layout'>;
  /** Why the restore stopped early; null when every row was processed. */
  error: string | null;
}

export interface ImportOptions {
  /** (0, n) first, then after every YIELD_EVERY_BLOCKS blocks and at the end; n = blocks to write. */
  onProgress?: (doneBlocks: number, totalBlocks: number) => void;
  /** Awaited after every YIELD_EVERY_BLOCKS blocks; default setTimeout(0). */
  pause?: () => Promise<void>;
}

async function knownIds(repo: Repository): Promise<Record<HistoryTable, ReadonlySet<string>>> {
  const [sessions, blocks, diagnostics, wellbeing] = await Promise.all([
    repo.listIds('sessions'),
    repo.listIds('blocks'),
    repo.listIds('diagnostics'),
    repo.listIds('wellbeing'),
  ]);
  return { sessions, blocks, diagnostics, wellbeing };
}

const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** The message of a failed write, without a trailing period (the templates add their own). */
function reason(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).trim().replace(/\.+$/, '');
  return text === '' ? 'причина неизвестна' : text;
}

function byTime(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/** What a restore of `bundle` would add; writes nothing. */
export async function previewImport(repo: Repository, bundle: ExportBundle): Promise<ImportPreview> {
  const known = await knownIds(repo);
  const counted = (rows: readonly { id: string }[], ids: ReadonlySet<string>): Counted => ({
    total: rows.length,
    fresh: rows.filter((r) => !ids.has(r.id)).length,
  });
  const dates = bundle.sessions.map((s) => s.startedAt).sort(byTime);
  return {
    sessions: counted(bundle.sessions, known.sessions),
    blocks: counted(bundle.blocks, known.blocks),
    diagnostics: counted(bundle.diagnostics, known.diagnostics),
    wellbeing: counted(bundle.wellbeing, known.wellbeing),
    trials: bundle.trials.length,
    logicItems: bundle.logicItems.length,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
  };
}

function groupByBlock<T extends { blockId: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const group = groups.get(r.blockId);
    if (group === undefined) groups.set(r.blockId, [r]);
    else group.push(r);
  }
  return groups;
}

/**
 * Writes the rows of a checked bundle (parseExportBundle) that are not stored yet, then rebuilds the caches if
 * anything was added (also when the restore stopped early). Settings come last: testDate and layout are taken
 * only if never saved here. Rejects only when rebuildCaches, onProgress or pause throws; the rows written stay
 * (and the next start rebuilds the caches if this rebuild failed).
 */
export async function importBundle(repo: Repository, bundle: ExportBundle, o: ImportOptions = {}): Promise<ImportReport> {
  const known = await knownIds(repo);
  const fresh = <T extends { id: string }>(rows: readonly T[], table: HistoryTable): T[] => rows.filter((r) => !known[table].has(r.id));
  const sessions = fresh(bundle.sessions, 'sessions');
  const blocks = fresh(bundle.blocks, 'blocks');
  const diagnostics = fresh(bundle.diagnostics, 'diagnostics');
  const wellbeing = fresh(bundle.wellbeing, 'wellbeing');
  const report: ImportReport = {
    sessions: { imported: 0, skipped: bundle.sessions.length - sessions.length },
    blocks: { imported: 0, skipped: bundle.blocks.length - blocks.length, failed: 0 },
    diagnostics: { imported: 0, skipped: bundle.diagnostics.length - diagnostics.length },
    wellbeing: { imported: 0, skipped: bundle.wellbeing.length - wellbeing.length },
    settingsFilled: [],
    error: null,
  };

  try {
    await writeHistory(repo, bundle, { sessions, blocks, diagnostics, wellbeing }, report, o);
    if (report.error === null) await fillSettings(repo, bundle.settings, report);
  } finally {
    // Also after an early stop, or when a callback threw: the caches follow every row written.
    const added = report.sessions.imported + report.blocks.imported + report.diagnostics.imported + report.wellbeing.imported;
    if (added > 0) await rebuildCaches(repo);
  }
  return report;
}

/** Writes `rows` in batches of IMPORT_CHUNK; when a batch fails, false and the report's error «{failure}: {reason}.». */
async function writeBatches<T>(
  rows: readonly T[],
  write: (batch: readonly T[]) => Promise<void>,
  counts: ImportCounts,
  failure: string,
  report: ImportReport,
): Promise<boolean> {
  for (let start = 0; start < rows.length; start += IMPORT_CHUNK) {
    const batch = rows.slice(start, start + IMPORT_CHUNK);
    try {
      await write(batch);
    } catch (e) {
      report.error = `${failure}: ${reason(e)}.`;
      return false;
    }
    counts.imported += batch.length;
  }
  return true;
}

async function writeHistory(
  repo: Repository,
  bundle: ExportBundle,
  fresh: Pick<ExportBundle, 'sessions' | 'blocks' | 'diagnostics' | 'wellbeing'>,
  report: ImportReport,
  o: ImportOptions,
): Promise<void> {
  if (!(await writeBatches(fresh.sessions, (b) => repo.addSessions(b), report.sessions, 'Не удалось записать сессии', report))) return;

  // Grouped once: a month of history holds ~100 000 trials.
  const trials = groupByBlock<TrialRow>(bundle.trials);
  const items = groupByBlock<LogicItemRow>(bundle.logicItems);
  const pause = o.pause ?? nextTask;
  const total = fresh.blocks.length;
  o.onProgress?.(0, total);
  for (const [k, b] of fresh.blocks.entries()) {
    const blockTrials = (trials.get(b.id) ?? []).sort((x, y) => x.idx - y.idx);
    try {
      await repo.addBlock(b, blockTrials, items.get(b.id) ?? []);
    } catch (e) {
      report.blocks.failed = 1;
      report.error =
        `Блок ${String(k + 1)} из ${String(total)} не записан: ${reason(e)}. ` +
        'Записанное раньше сохранено; запусти восстановление ещё раз — добавленное пропустится.';
      return;
    }
    report.blocks.imported++;
    if ((k + 1) % YIELD_EVERY_BLOCKS === 0) {
      o.onProgress?.(k + 1, total);
      await pause();
    }
  }
  if (total % YIELD_EVERY_BLOCKS !== 0) o.onProgress?.(total, total);

  const diagnosticsFailure = 'Не удалось записать контрольные диагностики';
  if (!(await writeBatches(fresh.diagnostics, (b) => repo.addDiagnostics(b), report.diagnostics, diagnosticsFailure, report))) return;
  await writeBatches(fresh.wellbeing, (b) => repo.addWellbeingRows(b), report.wellbeing, 'Не удалось сохранить записи самочувствия', report);
}

/** testDate and layout from the file, for the keys never saved here, when the value differs from the local one. */
async function fillSettings(repo: Repository, file: ExportBundle['settings'], report: ImportReport): Promise<void> {
  const [stored, current] = await Promise.all([repo.storedSettingKeys(), repo.getSettings()]);
  const patch: Partial<Settings> = {};
  if (file.testDate !== undefined && !stored.has('testDate') && file.testDate !== current.testDate) {
    patch.testDate = file.testDate;
    report.settingsFilled.push('testDate');
  }
  if (file.layout !== undefined && !stored.has('layout') && file.layout !== current.layout) {
    patch.layout = file.layout;
    report.settingsFilled.push('layout');
  }
  if (report.settingsFilled.length === 0) return;
  try {
    await repo.saveSettings(patch);
  } catch (e) {
    report.settingsFilled = [];
    report.error = `Не удалось записать настройки: ${reason(e)}.`;
  }
}
