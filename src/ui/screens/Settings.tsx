import { useEffect, useState } from 'react';
import { exportBundle, toCsv } from '../../data/export';
import type { LayoutId } from '../../engine/types';
import { measureRefresh } from '../../engine/timing';
import { useApp } from '../AppContext';
import { buildReport, logEvent } from '../errorLog';
import { decimal, localDate, localStamp } from '../format';
import { collectFrameTimestamps } from '../frameSampler';

export interface SettingsProps {
  onBack: () => void;
  /** Frame timestamps for the timing check; tests replace the 3-second sampler. */
  measureFrames?: () => Promise<number[]>;
}

const LAYOUTS: readonly (readonly [LayoutId, string])[] = [
  ['keyboard', 'Клавиатура'],
  ['mouse', 'Мышь'],
  ['pult', 'Пульт (стрелки и цифры)'],
];

const CHECK_MS = 3000;
const DROPPED_WARNING_RATIO = 0.05;
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

function SelfCheckResult({ check }: { check: SelfCheck }) {
  const droppedPercent = Math.round(check.droppedRatio * 1000) / 10;
  const warn = check.charging === false || check.droppedRatio > DROPPED_WARNING_RATIO;
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
      {warn && <p role="alert" className="warning">{POWER_WARNING}</p>}
    </div>
  );
}

export default function Settings({ onBack, measureFrames = () => collectFrameTimestamps(CHECK_MS) }: SettingsProps) {
  const { platform, repo } = useApp();
  const [layout, setLayout] = useState<LayoutId>('keyboard');
  const [testDate, setTestDate] = useState('');
  const [check, setCheck] = useState<SelfCheck | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'export' | 'report' | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<{ ok: boolean; text: string; paths: string[] } | null>(null);
  const [reportMessage, setReportMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([repo.getSettings(), platform.appVersion()]).then(([s, v]) => {
      if (!live) return;
      setLayout(s.layout);
      setTestDate(s.testDate ?? '');
      setCheck(parseSelfCheck(s.lastSelfCheckJson));
      setVersion(v);
    });
    return () => {
      live = false;
    };
  }, [repo, platform]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onBack]);

  const chooseLayout = (next: LayoutId): void => {
    setLayout(next);
    void repo.saveSettings({ layout: next });
  };

  const changeDate = (value: string): void => {
    setTestDate(value);
    void repo.saveSettings({ testDate: value === '' ? null : value });
  };

  const runCheck = async (): Promise<void> => {
    setBusy('check');
    setCheckError(null);
    try {
      const [frames, charging] = await Promise.all([measureFrames(), platform.powerCharging()]);
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
      setCheck(result);
    } catch (e) {
      setCheckError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const exportData = async (): Promise<void> => {
    setBusy('export');
    setExportMessage(null);
    try {
      const date = localDate();
      const paths = [
        await platform.exportFile(`trainer-export-${date}.json`, await exportBundle(repo, await platform.appVersion())),
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

  if (version === null) return <p>Загрузка…</p>;

  return (
    <div className="settings">
      <h2>Настройки</h2>
      {platform.kind === 'web' && (
        <p className="muted">Веб-версия: данные хранятся только до закрытия страницы.</p>
      )}

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
        <button type="button" disabled={busy !== null} onClick={() => void runCheck()}>
          Проверить тайминги (3 с)
        </button>
        {busy === 'check' && <p>Идёт замер, не нажимай клавиши…</p>}
        {checkError !== null && <p role="alert">Не удалось выполнить замер: {checkError}</p>}
        {check !== null && <SelfCheckResult check={check} />}
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

      <p>Версия приложения: {version}</p>
      <div className="actions">
        <button type="button" onClick={onBack}>
          Назад
        </button>
      </div>
    </div>
  );
}
