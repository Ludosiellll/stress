import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode, type RefObject } from 'react';
import type { Repository } from '../../data/repository';
import type { SessionPlan } from '../../engine/planner';
import { moduleTitles } from '../../modules/registry';
import type { Platform } from '../../platform';
import { SessionController, type SessionStartOptions } from '../../session/controller';
import type { BlockSummaryView, Step } from '../../session/steps';
import { e2eHooks } from '../../testing/e2eHooks';
import { useApp } from '../AppContext';
import { logEvent } from '../errorLog';
import { collectFrameTimestamps, FALLBACK_FRAME_MS } from '../frameSampler';
import { useKeyDown } from '../keys';
import BlockSummary from '../views/BlockSummary';
import Done from '../views/Done';
import Instruction from '../views/Instruction';
import MemoryView from '../views/MemoryView';
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
  | 'submitMemory'
  | 'discardBlock'
  | 'continueAfterSummary'
  | 'answerFatigue'
  | 'retrySave'
  | 'abandonPending'
  | 'submitWellbeing'
  | 'ackNotice'
>;

export interface SessionProps {
  plan: SessionPlan;
  onExit: () => void;
  /** Frame timestamps for the pre-session check; tests replace the 1-second sampler. */
  measureFrames?: (signal: AbortSignal) => Promise<number[]>;
  /** Tests pass a controller double. */
  startSession?: (o: SessionStartOptions) => Promise<SessionDriver>;
}

const CHECK_MS = 1000;
/** After this many drawing failures in a row the notice also offers to end the session. */
const RENDER_FAILURES_TO_OFFER_EXIT = 2;
const FOCUS_LOST = 'Окно потеряло фокус. Блок будет повторён.';
const RENDER_FAILED = 'Ошибка отрисовки. Блок будет повторён.';

const sampleFrames = (signal: AbortSignal): Promise<number[]> => collectFrameTimestamps(CHECK_MS, signal);
const startController = (o: SessionStartOptions): Promise<SessionDriver> => SessionController.start(o);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A stable number per step object: a block view is keyed by it, so it mounts once per block (a discard makes a new step). */
const stepIds = new WeakMap<Step, number>();
let lastStepId = 0;
function stepId(step: Step): number {
  let id = stepIds.get(step);
  if (id === undefined) {
    id = ++lastStepId;
    stepIds.set(step, id);
  }
  return id;
}

type Phase =
  | { kind: 'check' }
  | { kind: 'starting' }
  | { kind: 'running'; c: SessionDriver }
  | { kind: 'failed'; message: string };

/**
 * One session: pre-session check, fullscreen, then whatever `controller.step` says, until done or exit.
 *
 * Every controller call goes through `run`: one at a time, controls disabled meanwhile, the screen re-read
 * from `controller.step` afterwards. A block view is keyed by its step object, so it mounts once per block
 * and a discarded block mounts fresh. Escape pauses (a running block is discarded first); focus loss and
 * drawing errors discard the block and explain before a fresh one starts. When nothing on the new screen
 * has focus, its heading gets it (screen readers announce the change).
 */
function SessionFlow({
  plan,
  onExit,
  measureFrames = sampleFrames,
  startSession = startController,
  rootRef,
}: SessionProps & { rootRef: RefObject<HTMLElement | null> }) {
  const { platform, repo, audio } = useApp();
  const hooks = e2eHooks();
  const [phase, setPhase] = useState<Phase>({ kind: 'check' });
  const [frameMs, setFrameMs] = useState(FALLBACK_FRAME_MS);
  // Bumped after every controller call: the step lives in the controller, not in React state.
  const [, setVersion] = useState(0);
  const [renderFailures, setRenderFailures] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pause, setPause] = useState<{ blockDiscarded: boolean } | null>(null);
  const [summaries, setSummaries] = useState<BlockSummaryView[]>([]);
  const [crash, setCrash] = useState<Error | null>(null);
  const busyRef = useRef(false);
  const live = useRef(true);
  /** The saved stress volume, 0..100; read with the other settings when the session starts. */
  const stressVolume = useRef(0);

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

  // The sound stays awake while the session screen is open: no suspend inside a timed block, and every block with
  // sound finds the context running after the first unlock (W2-R39). It sleeps again once the screen closes.
  useEffect(() => audio.hold(), [audio]);

  const step = phase.kind === 'running' ? phase.c.step : null;
  const stepKind = step?.kind ?? null;

  useEffect(() => {
    if (stepKind === 'done') fullscreen(false);
  }, [stepKind, fullscreen]);

  // After every render: if focus is not on something inside the session screen, put it on the heading.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && root.contains(active)) return;
    root.querySelector<HTMLElement>('h2[tabindex="-1"]')?.focus();
  });

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
        stressVolume.current = settings.stressVolume;
        const c = await startSession({ repo, plan, layout: settings.layout, now: () => new Date(), appVersion, scale: hooks.scale });
        if (live.current) setPhase({ kind: 'running', c });
      } catch (e) {
        fullscreen(false);
        void logEvent(repo, 'error', `Не удалось начать сессию: ${errorText(e)}`);
        if (live.current) setPhase({ kind: 'failed', message: errorText(e) });
      }
    })();
  };

  /**
   * One controller call at a time; afterwards the screen follows `controller.step`. `fn` starts at once, inside the
   * caller's key or click handler (the instruction's audio unlock relies on it, M4).
   */
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

  const pauseBlock = (): void => {
    setPause({ blockDiscarded: true });
    run((c) => {
      c.discardBlock('user');
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
    } else if (step.kind === 'table_block' || step.kind === 'numseries_block' || step.kind === 'memory_block') pauseBlock();
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
        onExit={renderFailures >= RENDER_FAILURES_TO_OFFER_EXIT ? exit : undefined}
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
            audio.setVolume(stressVolume.current / 100);
            run((c) => {
              c.ackInstruction();
              // Still inside the key press or click, the moment the browser lets the audio context start. Only a
              // block with sound needs it: a session without sound never creates an audio context (M4).
              const next = c.step;
              if (next.kind === 'reaction_block' && next.layers.audio !== null) void audio.unlock();
            });
          }}
        />
      );
    case 'reaction_block':
      return (
        <ReactionView
          key={stepId(step)}
          step={step}
          nominalFrameMs={frameMs}
          onDone={(timeline) => {
            setRenderFailures(0);
            run((c) => c.submitReaction(timeline));
          }}
          onAbort={(reason) => {
            if (reason === 'user') {
              pauseBlock();
              return;
            }
            setNotice(FOCUS_LOST);
            run((c) => {
              c.discardBlock('focus_lost');
            });
          }}
          onError={(e) => {
            void logEvent(repo, 'error', `Ошибка отрисовки: ${errorText(e)}`, e instanceof Error ? (e.stack ?? '') : '');
            setRenderFailures((n) => n + 1);
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
          key={stepId(step)}
          step={step}
          busy={busy}
          onSubmit={(r) => {
            run((c) => c.submitTable(r));
          }}
        />
      );
    case 'numseries_block':
      return (
        <NumSeriesView
          key={stepId(step)}
          step={step}
          exposeAnswer={hooks.enabled}
          busy={busy}
          onSubmit={(answers) => {
            run((c) => c.submitNumSeries(answers));
          }}
        />
      );
    case 'memory_block':
      return (
        <MemoryView
          key={stepId(step)}
          step={step}
          exposeAnswer={hooks.enabled}
          busy={busy}
          onSubmit={(answers) => {
            run((c) => c.submitMemory(answers));
          }}
          onFocusLost={() => {
            setNotice(FOCUS_LOST);
            run((c) => {
              c.discardBlock('focus_lost');
            });
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
    case 'notice':
      return (
        <Notice
          title="Повтор блока"
          text={step.text}
          onContinue={() => {
            run((c) => {
              c.ackNotice();
            });
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
          what={step.what}
          busy={busy}
          onExit={exit}
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
      return (
        <Done diagnostic={step.diagnostic} seriesTotal={step.seriesTotal} summaries={summaries} indexDeferred={step.indexDeferred} onHome={exit} />
      );
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
  const root = useRef<HTMLElement>(null);
  return (
    <section className="session" aria-label="Сессия" ref={root}>
      <SessionBoundary repo={repo} platform={platform} onExit={props.onExit}>
        <SessionFlow {...props} rootRef={root} />
      </SessionBoundary>
    </section>
  );
}
