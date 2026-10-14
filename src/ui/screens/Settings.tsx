import { useEffect, useRef, useState } from 'react';
import { exportBundle, toCsv } from '../../data/export';
import type { Settings as SettingsRow } from '../../data/rows';
import type { LayoutId } from '../../engine/types';
import { measureRefresh } from '../../engine/timing';
import { useApp } from '../AppContext';
import { buildReport, logEvent, safeAppVersion } from '../errorLog';
import { decimal, localDate, localStamp } from '../format';
import { collectFrameTimestamps } from '../frameSampler';

export interface SettingsProps {
  onBack: () => void;
  /** Frame timestamps for the timing check; tests replace the 3-second sampler. Must reject when `signal` aborts. */
  measureFrames?: (signal: AbortSignal) => Promise<number[]>;
}

const LAYOUTS: readonly (readonly [LayoutId, string])[] = [
  ['keyboard', 'Клавиатура'],
  ['mouse', 'Мышь'],
  ['pult', 'Пульт (стрелки и цифры)'],
];

const CHECK_MS = 3000;
const DROPPED_WARNING_PERCENT = 5;
/** Excel reads UTF-8 CSV as Cyrillic only with a BOM. */
const BOM = '﻿';

const TIMING_NOTE =
  'Клавиатура ноутбука добавляет задержку по сравнению с кнопкой прибора. Сравнивай результаты со своими прошлыми, а нормы считай ориентировочными.';
const POWER_WARNING = 'Подключи зарядку и включи режим максимальной производительности';

interface SelfCheck {
  at: string;
  hz: number;
  intervalMs: number;
  jitterMs: number;
  droppedRatio: number;
  charging: boolean | null;
}

function parseSelfCheck(json: string | null): SelfCheck | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as Partial<Record<keyof SelfCheck, unknown>> | null;
    if (
      v !== null &&
      typeof v.at === 'string' &&
      typeof v.hz === 'number' &&
      typeof v.intervalMs === 'number' &&
      typeof v.jitterMs === 'number' &&
      typeof v.droppedRatio === 'number' &&
      (v.charging === null || typeof v.charging === 'boolean')
    ) {
      return { at: v.at, hz: v.hz, intervalMs: v.intervalMs, jitterMs: v.jitterMs, droppedRatio: v.droppedRatio, charging: v.charging };
    }
  } catch {
    // A damaged value is treated as "no check yet".
  }
  return null;
}

function powerText(charging: boolean | null): string {
  if (charging === null) return 'неизвестно';
  return charging ? 'от сети' : 'от батареи';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Share of dropped frames in percent, one decimal: the number that is shown and judged. */
function droppedPercentOf(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

function SelfCheckResult({ check, fresh }: { check: SelfCheck; fresh: boolean }) {
  const droppedPercent = droppedPercentOf(check.droppedRatio);
  const warn = check.charging === false || droppedPercent > DROPPED_WARNING_PERCENT;
  return (
    <div>
      <ul>
        <li>Частота: {Math.round(check.hz)} Гц</li>
        <li>Разброс кадров: {decimal(check.jitterMs)} мс</li>
        <li>Пропущенные кадры: {String(droppedPercent).replace('.', ',')} %</li>
        <li>Питание: {powerText(check.charging)}</li>
      </ul>
      <p>Погрешность ≈ 1 кадр ({decimal(check.intervalMs)} мс)</p>
      <p className="muted">Замер от {new Date(check.at).toLocaleString('ru-RU')}</p>
      {warn && (
        <p role={fresh ? 'alert' : 'status'} className="warning">
          {POWER_WARNING}
        </p>
      )}
    </div>
  );
}

type Busy = 'check' | 'export' | 'report' | null;

export default function Settings({ onBack, measureFrames = (signal) => collectFrameTimestamps(CHECK_MS, signal) }: SettingsProps) {
  const { platform, repo } = useApp();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutId>('keyboard');
  const [testDate, setTestDate] = useState('');
  const [check, setCheck] = useState<{ result: SelfCheck; fresh: boolean } | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<{ ok: boolean; text: string; paths: string[] } | null>(null);
  const [reportMessage, setReportMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Aborted when the screen closes, so a running measurement stops and saves nothing.
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const { signal } = controller;
    void (async () => {
      try {
        const [s, v] = await Promise.all([
          repo.getSettings(),
          platform.appVersion().catch((e: unknown) => {
            void logEvent(repo, 'warn', `Не удалось узнать версию приложения: ${errorText(e)}`);
            return null;
          }),
        ]);
        if (signal.aborted) return;
        setLayout(s.layout);
        setTestDate(s.testDate ?? '');
        const previous = parseSelfCheck(s.lastSelfCheckJson);
        setCheck(previous === null ? null : { result: previous, fresh: false });
        setVersion(v);
        setLoaded(true);
      } catch (e) {
        if (signal.aborted) return;
        setLoadError(errorText(e));
        await logEvent(repo, 'error', `Настройки: не удалось загрузить: ${errorText(e)}`);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [repo, platform]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // The measurement must not be disturbed, and Escape would also hide the result.
      if (e.key === 'Escape' && busy !== 'check') onBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onBack, busy]);

  /** Saves one setting; on failure puts the previous value back, shows the failure and logs it. */
  const save = async (what: string, patch: Partial<SettingsRow>, rollback: () => void): Promise<void> => {
    setSaveError(null);
    try {
      await repo.saveSettings(patch);
    } catch (e) {
      rollback();
      setSaveError(`Не удалось сохранить: ${what}. ${errorText(e)}`);
      await logEvent(repo, 'error', `Настройки: не удалось сохранить ${what}: ${errorText(e)}`);
    }
  };

  const chooseLayout = (next: LayoutId): void => {
    const previous = layout;
    setLayout(next);
    void save('раскладка', { layout: next }, () => { setLayout(previous); });
  };

  const changeDate = (value: string): void => {
    const previous = testDate;
    setTestDate(value);
    void save('дата теста', { testDate: value === '' ? null : value }, () => { setTestDate(previous); });
  };

  const runCheck = async (): Promise<void> => {
    const signal = lifetime.current?.signal;
    if (signal === undefined) return;
    const stale = (): boolean => signal.aborted; // not a plain read: TypeScript would narrow it after the first check
    setBusy('check');
    setCheckError(null);
    try {
      const [frames, charging] = await Promise.all([measureFrames(signal), platform.powerCharging()]);
      if (stale()) return;
      const stats = measureRefresh(frames);
      const result: SelfCheck = {
        at: new Date().toISOString(),
        hz: stats.hz,
        intervalMs: stats.intervalMs,
        jitterMs: stats.jitterMs,
        droppedRatio: stats.droppedRatio,
        charging,
      };
      await repo.saveSettings({ lastSelfCheckJson: JSON.stringify(result) });
      if (stale()) return;
      setCheck({ result, fresh: true });
    } catch (e) {
      if (!stale()) setCheckError(errorText(e));
    } finally {
      if (!stale()) setBusy(null);
    }
  };

  const exportData = async (): Promise<void> => {
    setBusy('export');
    setExportMessage(null);
    try {
      const date = localDate();
      const paths = [
        await platform.exportFile(`trainer-export-${date}.json`, await exportBundle(repo, await safeAppVersion(platform))),
        await platform.exportFile(`blocks-${date}.csv`, BOM + toCsv((await repo.listBlocks()).map((r) => ({ ...r })))),
        await platform.exportFile(`trials-${date}.csv`, BOM + toCsv((await repo.listAllTrials()).map((r) => ({ ...r })))),
      ];
      setExportMessage({ ok: true, text: 'Сохранено:', paths });
    } catch (e) {
      setExportMessage({ ok: false, text: `Не удалось сохранить: ${errorText(e)}`, paths: [] });
      await logEvent(repo, 'error', `Экспорт данных: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const saveReport = async (): Promise<void> => {
    setBusy('report');
    setReportMessage(null);
    try {
      const path = await platform.exportFile(`report-${localStamp()}.json`, await buildReport(repo, platform));
      setReportMessage({ ok: true, text: `Отчёт сохранён: ${path}` });
    } catch (e) {
      setReportMessage({ ok: false, text: `Не удалось сохранить отчёт: ${errorText(e)}` });
      await logEvent(repo, 'error', `Отчёт об ошибке: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (loadError !== null) {
    return (
      <div className="settings">
        <h2>Настройки</h2>
        <p role="alert">Не удалось загрузить настройки: {loadError}</p>
        <div className="actions">
          <button type="button" onClick={onBack}>
            Назад
          </button>
        </div>
      </div>
    );
  }
  if (!loaded) return <p>Загрузка…</p>;

  return (
    <div className="settings">
      <h2>Настройки</h2>
      {platform.kind === 'web' && (
        <p className="muted">Веб-версия: данные хранятся только до закрытия страницы.</p>
      )}
      {saveError !== null && <p role="alert">{saveError}</p>}

      <fieldset>
        <legend>Раскладка</legend>
        {LAYOUTS.map(([id, label]) => (
          <label key={id} className="choice">
            <input type="radio" name="layout" checked={layout === id} onChange={() => { chooseLayout(id); }} /> {label}
          </label>
        ))}
      </fieldset>

      <section>
        <div className="row">
          <label>
            Дата теста
            <input type="date" value={testDate} onChange={(e) => { changeDate(e.target.value); }} />
          </label>
          <button type="button" onClick={() => { changeDate(''); }}>
            Очистить
          </button>
        </div>
      </section>

      <section>
        <h3>Проверка таймингов</h3>
        <button type="button" disabled={busy === 'check'} onClick={() => void runCheck()}>
          Проверить тайминги (3 с)
        </button>
        {busy === 'check' && <p>Идёт замер, не нажимай клавиши…</p>}
        {checkError !== null && <p role="alert">Не удалось выполнить замер: {checkError}</p>}
        {check !== null && <SelfCheckResult check={check.result} fresh={check.fresh} />}
        <p className="muted">{TIMING_NOTE}</p>
      </section>

      <section>
        <h3>Данные</h3>
        <div className="actions">
          <button type="button" disabled={busy !== null} onClick={() => void exportData()}>
            Экспорт данных (JSON и CSV)
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void saveReport()}>
            Сохранить отчёт об ошибке
          </button>
        </div>
        {exportMessage !== null && (
          <div role={exportMessage.ok ? 'status' : 'alert'}>
            <p>{exportMessage.text}</p>
            {exportMessage.paths.length > 0 && (
              <ul>
                {exportMessage.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {reportMessage !== null && <p role={reportMessage.ok ? 'status' : 'alert'}>{reportMessage.text}</p>}
      </section>

      <p>Версия приложения: {version ?? 'неизвестна'}</p>
      <div className="actions">
        <button type="button" onClick={onBack}>
          Назад
        </button>
      </div>
    </div>
  );
}
