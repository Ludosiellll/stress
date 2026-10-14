import type { ExportBundle, RestoredSetting } from '../data/bundleSchema';
import { importBundle, type ImportCounts, type ImportPreview, type ImportReport } from '../data/importBundle';
import type { Repository } from '../data/repository';
import type { Platform } from '../platform';
import { plural } from '../session/steps';
import { logEvent } from './errorLog';
import { thousands } from './format';
import { ruDate } from './progressModel';

/**
 * «Восстановить из файла экспорта» (Task 14): a fresh copy of the database first, then the rows of the file.
 * Without the copy nothing is written, not even a log row.
 */

/** The copy before a restore failed; the message is the text for the user. */
export class RestoreBackupError extends Error {
  constructor(reason: string) {
    super(`Не удалось сделать резервную копию: ${reason}. Восстановление не начато.`);
    this.name = 'RestoreBackupError';
  }
}

export interface RestoreResult {
  report: ImportReport;
  /** Where the copy went; null where there is no database file (web). */
  backupPath: string | null;
}

/** The text of a rejection (an Error, or the plain string a Tauri command rejects with), without a trailing period. */
export function reasonText(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).trim().replace(/\.+$/, '');
  return text === '' ? 'причина неизвестна' : text;
}

const counts = (c: ImportCounts): string => thousands(c.imported);

function logText(r: ImportReport, backupPath: string | null): string {
  const tables = (n: (c: ImportCounts) => number): string =>
    `сессий ${String(n(r.sessions))}, блоков ${String(n(r.blocks))}, диагностик ${String(n(r.diagnostics))}, записей самочувствия ${String(n(r.wellbeing))}`;
  const added = `добавлено ${tables((c) => c.imported)}`;
  const skipped = `пропущено ${tables((c) => c.skipped)}`;
  const copy = `Резервная копия: ${backupPath ?? 'не делалась (нет файла базы)'}`;
  const stop = r.error === null ? '' : ` Остановлено: ${r.error}`;
  return `Восстановление из файла: ${added}; ${skipped}. ${copy}${stop}`;
}

/**
 * Makes the copy (platform.backupNow), then writes the file (importBundle) and logs the counts. A failed copy
 * rejects with RestoreBackupError before anything is written. A stop is in the report; a rejected import is logged
 * and passed on.
 */
export async function runRestore(o: {
  repo: Repository;
  platform: Platform;
  bundle: ExportBundle;
  onProgress: (doneBlocks: number, totalBlocks: number) => void;
}): Promise<RestoreResult> {
  let backupPath: string | null;
  try {
    backupPath = await o.platform.backupNow();
  } catch (e) {
    throw new RestoreBackupError(reasonText(e));
  }
  let report: ImportReport;
  try {
    report = await importBundle(o.repo, o.bundle, { onProgress: o.onProgress });
  } catch (e) {
    await logEvent(o.repo, 'error', `Восстановление из файла прервано: ${reasonText(e)}`);
    throw e;
  }
  await logEvent(o.repo, report.error === null ? 'info' : 'error', logText(report, backupPath), JSON.stringify(report));
  return { report, backupPath };
}

/** «В файле: 42 сессии с 01.10.2026 по 14.11.2026. Новых: 40, уже есть: 2. Блоков: 1 234, новых 1 200. …» */
export function previewText(p: ImportPreview): string {
  const n = p.sessions.total;
  let span = '';
  if (p.firstDate !== null && p.lastDate !== null) {
    const [first, last] = [ruDate(p.firstDate), ruDate(p.lastDate)];
    span = first === last ? ` за ${first}` : ` с ${first} по ${last}`;
  }
  return (
    `В файле: ${thousands(n)} ${plural(n, 'сессия', 'сессии', 'сессий')}${span}. ` +
    `Новых: ${thousands(p.sessions.fresh)}, уже есть: ${thousands(n - p.sessions.fresh)}. ` +
    `Блоков: ${thousands(p.blocks.total)}, новых ${thousands(p.blocks.fresh)}. ` +
    `Контрольных диагностик: ${thousands(p.diagnostics.total)}, новых ${thousands(p.diagnostics.fresh)}.`
  );
}

/** «Записано блоков: 120 из 1 200» */
export function progressText(done: number, total: number): string {
  return `Записано блоков: ${thousands(done)} из ${thousands(total)}`;
}

const SETTING_NAMES: Readonly<Record<RestoredSetting, string>> = { testDate: 'дата теста', layout: 'раскладка' };

function skippedSettingsText(keys: readonly RestoredSetting[]): string | null {
  const names = keys.map((k) => `«${SETTING_NAMES[k]}»`);
  if (names.length === 0) return null;
  return names.length === 1
    ? `Настройка ${names.join('')} из файла не подошла и пропущена.`
    : `Настройки ${names.join(' и ')} из файла не подошли и пропущены.`;
}

/**
 * The result of a restore: `alert` is why it stopped (null when it went through), `lines` what was added, the
 * settings taken from the file and those the file could not give.
 */
export function reportLines(r: ImportReport): { alert: string | null; lines: string[] } {
  const added =
    `Добавлено сессий: ${counts(r.sessions)}, блоков: ${counts(r.blocks)}, ` +
    `диагностик: ${counts(r.diagnostics)}, записей самочувствия: ${counts(r.wellbeing)}.`;
  let summary: string;
  if (r.error === null) {
    const skipped =
      r.sessions.skipped + r.blocks.skipped > 0
        ? ` Пропущено (уже были): сессий ${thousands(r.sessions.skipped)}, блоков ${thousands(r.blocks.skipped)}.`
        : '';
    const taken = r.settingsFilled.length > 0 ? ` Из файла взяты: ${r.settingsFilled.map((k) => SETTING_NAMES[k]).join(', ')}.` : '';
    summary = `Готово. ${added}${skipped}${taken}`;
  } else {
    summary = added;
  }
  const skippedSettings = skippedSettingsText(r.settingsSkipped);
  return { alert: r.error, lines: skippedSettings === null ? [summary] : [summary, skippedSettings] };
}
