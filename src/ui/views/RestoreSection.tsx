import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { parseExportBundle, type ExportBundle } from '../../data/bundleSchema';
import { previewImport, type ImportPreview, type ImportReport } from '../../data/importBundle';
import { useApp } from '../AppContext';
import { previewText, progressText, reasonText, reportLines, RestoreBackupError, runRestore } from '../restore';

export interface RestoreSectionProps {
  /** Another action of the settings screen runs: choosing a file and «Восстановить» wait. */
  busy: boolean;
  /** true while a restore writes (the settings screen locks everything else), false when it ends. */
  onBusy: (on: boolean) => void;
}

const EXPLANATION =
  'Загрузит сессии из файла, который сохранила кнопка «Экспорт данных». Записи на этом компьютере не меняются и не удаляются: те, что уже есть, из файла пропускаются.';
const BACKUP_NOTE = ' Перед загрузкой делается резервная копия базы.';
const INTERRUPTED_TAIL = 'Записанное сохранено; запусти восстановление ещё раз — добавленное пропустится.';

type State =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'invalid'; message: string }
  | { kind: 'preview'; bundle: ExportBundle; preview: ImportPreview }
  /** `total` null: the backup is being made, no block written yet. */
  | { kind: 'running'; done: number; total: number | null }
  | { kind: 'done'; report: ImportReport; backupPath: string | null }
  | { kind: 'failed'; message: string };

/** «Восстановление из файла экспорта»: file → check → preview → backup → write with progress → result. */
export default function RestoreSection({ busy, onBusy }: RestoreSectionProps) {
  const { repo, platform } = useApp();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);

  const readFile = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Cleared, so choosing the same file again (after a fix or a stop) is a change again.
    input.value = '';
    if (file === undefined) return;
    setState({ kind: 'reading' });
    try {
      const parsed = parseExportBundle(await file.text());
      if (!parsed.ok) {
        setState({ kind: 'invalid', message: parsed.error });
        return;
      }
      setState({ kind: 'preview', bundle: parsed.bundle, preview: await previewImport(repo, parsed.bundle) });
    } catch (err) {
      setState({ kind: 'invalid', message: `Не удалось прочитать файл: ${reasonText(err)}.` });
    }
  };

  const restore = async (bundle: ExportBundle): Promise<void> => {
    onBusy(true);
    setState({ kind: 'running', done: 0, total: null });
    try {
      const { report, backupPath } = await runRestore({
        repo,
        platform,
        bundle,
        onProgress: (done, total) => {
          setState({ kind: 'running', done, total });
        },
      });
      setState({ kind: 'done', report, backupPath });
    } catch (err) {
      const message = err instanceof RestoreBackupError ? err.message : `Восстановление прервано: ${reasonText(err)}. ${INTERRUPTED_TAIL}`;
      setState({ kind: 'failed', message });
    } finally {
      onBusy(false);
    }
  };

  const chooser = (
    <div className="actions">
      <button type="button" disabled={busy || state.kind === 'reading'} onClick={() => fileInput.current?.click()}>
        Восстановить из файла экспорта
      </button>
    </div>
  );

  let body: ReactNode;
  switch (state.kind) {
    case 'idle':
      body = chooser;
      break;
    case 'reading':
      body = (
        <>
          {chooser}
          <p role="status">Чтение файла…</p>
        </>
      );
      break;
    case 'invalid':
    case 'failed':
      body = (
        <>
          <p role="alert">{state.message}</p>
          {chooser}
        </>
      );
      break;
    case 'preview': {
      const { bundle } = state;
      body = (
        <>
          <p>{previewText(state.preview)}</p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void restore(bundle)}>
              Восстановить
            </button>
            <button type="button" onClick={() => { setState({ kind: 'idle' }); }}>
              Отмена
            </button>
          </div>
        </>
      );
      break;
    }
    case 'running':
      body =
        state.total === null ? (
          <p role="status">Резервная копия…</p>
        ) : (
          <>
            <p role="status">{progressText(state.done, state.total)}</p>
            <progress max={state.total} value={state.done} aria-label="Записано блоков" />
          </>
        );
      break;
    case 'done': {
      const { alert, lines } = reportLines(state.report);
      body = (
        <>
          {alert !== null && <p role="alert">{alert}</p>}
          <div role="status">
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          {state.backupPath !== null && <p className="muted">Резервная копия базы: {state.backupPath}</p>}
          {chooser}
        </>
      );
      break;
    }
  }

  return (
    <section className="restore">
      <h3>Восстановление из файла экспорта</h3>
      <p className="muted">
        {EXPLANATION}
        {platform.kind === 'tauri' && BACKUP_NOTE}
      </p>
      <input
        ref={fileInput}
        type="file"
        accept=".json"
        hidden
        aria-label="Файл экспорта"
        disabled={busy}
        onChange={(e) => void readFile(e)}
      />
      {body}
    </section>
  );
}
