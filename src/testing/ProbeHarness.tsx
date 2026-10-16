import { useEffect, useState } from 'react';
import { MemoryRepository } from '../data/memoryRepository';
import type { TrialSpec } from '../engine/reaction/types';
import { createRng } from '../engine/rng';
import { measureRefresh } from '../engine/timing';
import { NO_STRESSORS } from '../modules/reaction/common';
import { createWebPlatform } from '../platform/web';
import { createAudioOut } from '../runtime/audio/audioOut';
import type { StepOf } from '../session/steps';
import { AppContext, type AppServices } from '../ui/AppContext';
import { collectFrameTimestamps, FALLBACK_FRAME_MS } from '../ui/frameSampler';
import ReactionView from '../ui/views/ReactionView';

/**
 * Timing probe for the browser e2e test (`?e2e=1&probe=pzmr`, Task 17): one ПЗМР block with fixed
 * parameters, played through the real ReactionView (canvas, frame clock, input, focus guard). The page
 * shows the measured frame interval in `data-frame-ms`; the test presses at a known delay after each
 * onset and reads the resolved results from `window.__trainer.lastResults`.
 */

export const PROBE_TRIALS = 10;
const PROBE_SEED = 17;
const MEASURE_MS = 1000;

/** 10 red circles, one key (Space), window 1000 ms, ISI 600–800 ms; the same block every time. */
export function probeSpecs(): TrialSpec[] {
  const rng = createRng(PROBE_SEED);
  return Array.from({ length: PROBE_TRIALS }, () => ({
    isiMs: rng.int(600, 800),
    windowMs: 1000,
    stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
    expected: { kind: 'press', key: 'Space' },
  }));
}

const STEP: StepOf<'reaction_block'> = {
  kind: 'reaction_block',
  module: 'pzmr',
  L: 0,
  specs: probeSpecs(),
  keys: ['Space'],
  layout: 'keyboard',
  legend: null,
  layers: { ...NO_STRESSORS, seed: PROBE_SEED },
};

/** The probe page has no app around it: a browser host, an empty repository and no sound (the block has none). */
const PROBE_APP: AppServices = { platform: createWebPlatform(), repo: new MemoryRepository(), audio: createAudioOut(null) };

const sampleFrames = (): Promise<number[]> => collectFrameTimestamps(MEASURE_MS);

export interface ProbeHarnessProps {
  /** About 60 rAF timestamps (1 s); tests pass a fake. */
  measureFrames?: () => Promise<number[]>;
}

type Status = 'ready' | 'running' | 'done' | 'aborted' | 'error';

export default function ProbeHarness({ measureFrames = sampleFrames }: ProbeHarnessProps) {
  const [frameMs, setFrameMs] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>('ready');

  useEffect(() => {
    let live = true;
    void measureFrames()
      .then((stamps) => measureRefresh(stamps).intervalMs)
      .catch(() => FALLBACK_FRAME_MS)
      .then((ms) => {
        if (live) setFrameMs(ms);
      });
    return () => {
      live = false;
    };
  }, [measureFrames]);

  if (frameMs === null) return <p>Замер кадра…</p>;
  if (status === 'running') {
    return (
      <AppContext.Provider value={PROBE_APP}>
        <ReactionView
          step={STEP}
          nominalFrameMs={frameMs}
          canStop={() => true}
          onDone={() => { setStatus('done'); }}
          onAbort={() => { setStatus('aborted'); }}
          onError={() => { setStatus('error'); }}
        />
      </AppContext.Provider>
    );
  }
  return (
    <main>
      <h1>Замер точности времени</h1>
      <p data-frame-ms={frameMs} data-probe-status={status}>
        Кадр: {frameMs.toFixed(2)} мс. Статус: {status}
      </p>
      {status === 'ready' && (
        <button type="button" onClick={() => { setStatus('running'); }}>
          Начать замер
        </button>
      )}
    </main>
  );
}
