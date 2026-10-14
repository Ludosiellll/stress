import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../data/repository';
import type { LogRow } from '../data/rows';
import type { Platform } from '../platform';

const REPORT_LOG_ROWS = 200;
/** The same error inside this window is written once (a render loop would otherwise flood the log). */
const DUPLICATE_WINDOW_MS = 5000;

/** Best-effort write to app_log: a broken log must never raise a second error. */
export async function logEvent(repo: Repository, level: LogRow['level'], message: string, detail = ''): Promise<void> {
  try {
    await repo.appendLog({ id: uuidv4(), at: new Date().toISOString(), level, message, detail });
  } catch {
    // Nothing else to do: the log is the last place errors go.
  }
}

function describeReason(reason: unknown): { message: string; detail: string } {
  if (reason instanceof Error) return { message: reason.message, detail: reason.stack ?? String(reason) };
  if (typeof reason === 'string') return { message: reason, detail: '' };
  try {
    return { message: 'Необработанное отклонение', detail: JSON.stringify(reason) };
  } catch {
    return { message: 'Необработанное отклонение', detail: String(reason) };
  }
}

/** Writes uncaught errors and unhandled promise rejections to app_log. Returns the function that removes the listeners. */
export function installErrorLog(repo: Repository, w: Window): () => void {
  let lastKey = '';
  let lastAt = Number.NEGATIVE_INFINITY;
  const record = (message: string, detail: string): void => {
    const key = `${message}\n${detail}`;
    const now = performance.now();
    if (key === lastKey && now - lastAt < DUPLICATE_WINDOW_MS) return;
    lastKey = key;
    lastAt = now;
    void logEvent(repo, 'error', message, detail);
  };
  const onError = (e: Event): void => {
    const ev = e as ErrorEvent;
    const { message, detail } = ev.error instanceof Error ? describeReason(ev.error) : { message: ev.message, detail: '' };
    record(message, detail);
  };
  const onRejection = (e: Event): void => {
    const { message, detail } = describeReason((e as PromiseRejectionEvent).reason);
    record(message, detail);
  };
  w.addEventListener('error', onError);
  w.addEventListener('unhandledrejection', onRejection);
  return () => {
    w.removeEventListener('error', onError);
    w.removeEventListener('unhandledrejection', onRejection);
  };
}

/** The version for files: a failing getVersion must not block an export or the error report. */
export async function safeAppVersion(platform: Platform): Promise<string> {
  try {
    return await platform.appVersion();
  } catch {
    return 'unknown';
  }
}

function parseOrText(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * JSON for «Сохранить отчёт об ошибке»: version, platform, the last timing self-check and the newest
 * log rows. Wellbeing data and training history are never included (spec §10).
 */
export async function buildReport(repo: Repository, platform: Platform): Promise<string> {
  const [settings, log] = await Promise.all([repo.getSettings(), repo.listLog(REPORT_LOG_ROWS)]);
  return JSON.stringify(
    {
      appVersion: await safeAppVersion(platform),
      platform: platform.kind,
      generatedAt: new Date().toISOString(),
      lastSelfCheck: parseOrText(settings.lastSelfCheckJson),
      log,
    },
    null,
    2,
  );
}
