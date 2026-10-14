import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import type { Repository } from '../../data/repository';
import type { SessionPlan } from '../../engine/planner';
import type { ModuleId } from '../../engine/types';
import { moduleTitles } from '../../modules/registry';
import type { Platform } from '../../platform';
import { SessionController, type SessionStartOptions } from '../../session/controller';
import type { BlockSummaryView } from '../../session/steps';
import { e2eHooks } from '../../testing/e2eHooks';
import { useApp } from '../AppContext';
import { logEvent } from '../errorLog';
import { collectFrameTimestamps } from '../frameSampler';
import { useKeyDown } from '../keys';
import BlockSummary from '../views/BlockSummary';
import Done from '../views/Done';
import Instruction from '../views/Instruction';
import NumSeriesView from '../views/NumSeriesView';
import { FatiguePrompt, Notice, PauseMenu, SaveError } from '../views/Prompts';
import ReactionView from '../views/ReactionView';
import TableView from '../views/TableView';
import Warnings from '../views/Warnings';
import Wellbeing from '../views/Wellbeing';

/** What the session screen uses of SessionController (tests pass a double). */
export type SessionDriver = Pick<
  SessionController,
  | 'step'
  | 'ackInstruction'
  | 'submitReaction'
  | 'submitTable'
  | 'submitNumSeries'
  | 'discardBlock'
  | 'continueAfterSummary'
  | 'answerFatigue'
  | 'retrySave'
  | 'abandonPending'
  | 'submitWellbeing'
>;

export interface SessionProps {
  plan: SessionPlan;
  onExit: () => void;
  /** Frame timestamps for the pre-session check; tests replace the 1-second sampler. */
  measureFrames?: () => Promise<number[]>;
  /** Tests pass a controller double. */
  startSession?: (o: SessionStartOptions) => Promise<SessionDriver>;
}

const CHECK_MS = 1000;
const FALLBACK_FRAME_MS = 1000 / 60;
const FOCUS_LOST = 'Окно потеряло фокус. Блок будет повторён.';
const RENDER_FAILED = 'Ошибка отрисовки. Блок будет повторён.';

const sampleFrames = (): Promise<number[]> => collectFrameTimestamps(CHECK_MS);
const startController = (o: SessionStartOptions): Promise<SessionDriver> => SessionController.start(o);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Phase =
  | { kind: 'check' }
  | { kind: 'starting' }
  | { kind: 'running'; c: SessionDriver }
  | { kind: 'failed'; message: string };

/**
 * One session: pre-session check, fullscreen, then whatever `controller.step` says, until done or exit.
 *
 * Every controller call goes through `run`: one at a time, controls disabled meanwhile, the screen re-read
 * from `controller.step` afterwards. A block view is keyed by the call count, so a discarded block mounts
 * fresh. Escape pauses (a running block is discarded first); focus loss and drawing errors discard the
 * block and explain before a fresh one starts.
 */
function SessionFlow({ plan, onExit, measureFrames = sampleFrames, startSession = startController }: SessionProps) {
  const { platform, repo } = useApp();
  const hooks = e2eHooks();
  const [phase, setPhase] = useState<Phase>({ kind: 'check' });
  const [frameMs, setFrameMs] = useState(FALLBACK_FRAME_MS);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pause, setPause] = useState<{ blockDiscarded: boolean } | null>(null);
  const [summaries, setSummaries] = useState<BlockSummaryView[]>([]);
  const [crash, setCrash] = useState<Error | null>(null);
  const busyRef = useRef(false);
  const live = useRef(true);

  const fullscreen = useCallback(
    (on: boolean): void => {
      platform.setFullscreen(on).catch((e: unknown) => logEvent(repo, 'warn', `Полноэкранный режим: ${errorText(e)}`));
    },
    [platform, repo],
  );

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      fullscreen(false);
    };
  }, [fullscreen]);

  const step = phase.kind === 'running' ? phase.c.step : null;
  const stepKind = step?.kind ?? null;

  useEffect(() => {
    if (stepKind === 'done') fullscreen(false);
  }, [stepKind, fullscreen]);

  const exit = (): void => {
    fullscreen(false);
    onExit();
  };

  const begin = (nominalFrameMs: number): void => {
    setFrameMs(nominalFrameMs);
    setPhase({ kind: 'starting' });
    fullscreen(true);
    void (async () => {
      try {
        const [settings, appVersion] = await Promise.all([repo.getSettings(), platform.appVersion()]);
        const c = await startSession({ repo, plan, layout: settings.layout, now: () => new Date(), appVersion, scale: hooks.scale });
        if (live.current) setPhase({ kind: 'running', c });
      } catch (e) {
        fullscreen(false);
        void logEvent(repo, 'error', `Не удалось начать сессию: ${errorText(e)}`);
        if (live.current) setPhase({ kind: 'failed', message: errorText(e) });
      }
    })();
  };

  /** One controller call at a time; afterwards the screen follows `controller.step`. */
  const run = (fn: (c: SessionDriver) => void | Promise<void>): void => {
    if (phase.kind !== 'running' || busyRef.current) return;
    const { c } = phase;
    busyRef.current = true;
    setBusy(true);
    void (async () => {
      try {
        await fn(c);
        const next = c.step;
        if (next.kind === 'summary') setSummaries((list) => [...list, next.view]);
      } catch (e) {
        setCrash(e instanceof Error ? e : new Error(String(e)));
      } finally {
        busyRef.current = false;
        setBusy(false);
        setVersion((v) => v + 1);
      }
    })();
  };

  const pauseBlock = (module: ModuleId): void => {
    setPause({ blockDiscarded: true });
    void logEvent(repo, 'info', 'Пауза: блок отброшен (Esc)', module);
    // The controller knows only focus_lost and error; the log says it was the user.
    run((c) => {
      c.discardBlock('error');
    });
  };

  // A running reaction block handles Escape itself; a save error must be resolved first.
  const escapePauses =
    step !== null &&
    pause === null &&
    !busy &&
    (notice !== null || (step.kind !== 'reaction_block' && step.kind !== 'save_error' && step.kind !== 'done'));
  useKeyDown((e) => {
    if (e.key !== 'Escape' || step === null) return;
    e.preventDefault();
    if (notice !== null) {
      // The block after the notice has not started yet: nothing to discard.
      setNotice(null);
      setPause({ blockDiscarded: false });
    } else if (step.kind === 'table_block') pauseBlock(step.module);
    else if (step.kind === 'numseries_block') pauseBlock('numseries');
    else setPause({ blockDiscarded: false });
  }, escapePauses);

  if (crash !== null) throw crash;

  switch (phase.kind) {
    case 'check':
      return <Warnings measureFrames={measureFrames} onReady={begin} onBack={exit} />;
    case 'starting':
      return <p className="screen-center">Загрузка…</p>;
    case 'failed':
      return (
        <div className="screen-center">
          <p role="alert">Не удалось начать сессию: {phase.message}</p>
          <div className="actions">
            <button type="button" autoFocus onClick={exit}>
              На главную
            </button>
          </div>
        </div>
      );
    case 'running':
      break;
  }

  if (step === null) return null;
  if (notice !== null) {
    return (
      <Notice
        text={notice}
        onContinue={() => {
          setNotice(null);
        }}
      />
    );
  }
  if (pause !== null) {
    return (
      <PauseMenu
        blockDiscarded={pause.blockDiscarded}
        onResume={() => {
          setPause(null);
        }}
        onExit={exit}
      />
    );
  }

  switch (step.kind) {
    case 'instruction':
      return (
        <Instruction
          title={moduleTitles[step.module]}
          text={step.text}
          keysHint={step.keysHint}
          onStart={() => {
            run((c) => {
              c.ackInstruction();
            });
          }}
        />
      );
    case 'reaction_block':
      return (
        <ReactionView
          key={version}
          step={step}
          nominalFrameMs={frameMs}
          onDone={(timeline) => {
            run((c) => c.submitReaction(timeline));
          }}
          onAbort={(reason) => {
            if (reason === 'user') {
              pauseBlock(step.module);
              return;
            }
            setNotice(FOCUS_LOST);
            run((c) => {
              c.discardBlock('focus_lost');
            });
          }}
          onError={(e) => {
            void logEvent(repo, 'error', `Ошибка отрисовки: ${errorText(e)}`, e instanceof Error ? (e.stack ?? '') : '');
            setNotice(RENDER_FAILED);
            run((c) => {
              c.discardBlock('error');
            });
          }}
        />
      );
    case 'table_block':
      return (
        <TableView
          key={version}
          step={step}
          onSubmit={(r) => {
            run((c) => c.submitTable(r));
          }}
        />
      );
    case 'numseries_block':
      return (
        <NumSeriesView
          key={version}
          step={step}
          exposeAnswer={hooks.enabled}
          onSubmit={(answers) => {
            run((c) => c.submitNumSeries(answers));
          }}
        />
      );
    case 'summary':
      return (
        <BlockSummary
          view={step.view}
          busy={busy}
          onContinue={() => {
            run((c) => c.continueAfterSummary());
          }}
        />
      );
    case 'fatigue_prompt':
      return (
        <FatiguePrompt
          busy={busy}
          onAnswer={(stop) => {
            run((c) => c.answerFatigue(stop));
          }}
        />
      );
    case 'save_error':
      return (
        <SaveError
          message={step.message}
          canAbandon={step.canAbandon}
          busy={busy}
          onRetry={() => {
            run((c) => c.retrySave());
          }}
          onAbandon={() => {
            run((c) => c.abandonPending());
          }}
        />
      );
    case 'wellbeing':
      return (
        <Wellbeing
          busy={busy}
          onSubmit={(w) => {
            run((c) => c.submitWellbeing(w));
          }}
        />
      );
    case 'done':
      return <Done diagnostic={step.diagnostic} summaries={summaries} onHome={exit} />;
  }
}

interface BoundaryProps {
  repo: Repository;
  platform: Platform;
  onExit: () => void;
  children: ReactNode;
}

/** A render error ends the session screen: logged, fullscreen off, a way home. Stored blocks stay stored. */
class SessionBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const e = error instanceof Error ? error : new Error(String(error));
    void logEvent(this.props.repo, 'error', `Сбой экрана сессии: ${e.message}`, `${e.stack ?? ''}\n${info.componentStack ?? ''}`);
    this.props.platform.setFullscreen(false).catch(() => undefined);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="screen-center">
        <p role="alert">Что-то пошло не так. Данные пройденных блоков сохранены.</p>
        <div className="actions">
          <button type="button" className="primary" autoFocus onClick={this.props.onExit}>
            На главную
          </button>
        </div>
      </div>
    );
  }
}

/** The session screen (fills the window); `onExit` goes back home. */
export default function Session(props: SessionProps) {
  const { platform, repo } = useApp();
  return (
    <section className="session" aria-label="Сессия">
      <SessionBoundary repo={repo} platform={platform} onExit={props.onExit}>
        <SessionFlow {...props} />
      </SessionBoundary>
    </section>
  );
}
