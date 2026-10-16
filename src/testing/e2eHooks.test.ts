import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Stimulus, TrialResult, TrialSpec } from '../engine/reaction/types';
import type { FrameClock } from '../runtime/frameClock';
import type { StimulusRenderer } from '../runtime/reactionRunner';
import { e2eHooks, installE2eHooks, instrumentBlock, type E2eHost } from './e2eHooks';

const host = (search: string): E2eHost => ({ location: { search } });

const spec = (key: string): TrialSpec => ({
  isiMs: 500,
  windowMs: 400,
  stimulus: { kind: 'shape', shape: 'circle', color: 'red' },
  expected: { kind: 'press', key },
});

afterEach(() => {
  installE2eHooks(host(''));
});

describe('e2e hooks', () => {
  it('are absent without ?e2e=1', () => {
    const hooks = installE2eHooks(window);
    expect(hooks.enabled).toBe(false);
    expect(hooks.scale).toBe(1);
    expect(hooks.probe).toBeNull();
    expect(window.__trainer).toBeUndefined();
    expect(e2eHooks()).toBe(hooks);
    expect(() => {
      hooks.emitStimulus({ module: 'pzmr', expected: { kind: 'withhold' }, onset: 1 });
      hooks.setLastResults([]);
    }).not.toThrow();
  });

  it('expose window.__trainer with the scale from the query', () => {
    const h = host('?e2e=1&scale=0.02');
    const hooks = installE2eHooks(h);
    expect(hooks.enabled).toBe(true);
    expect(hooks.scale).toBe(0.02);
    expect(h.__trainer?.scale).toBe(0.02);
    expect(h.__trainer?.lastResults).toBeNull();
    expect(e2eHooks()).toBe(hooks);
  });

  it('use scale 1 when the query has none or a bad one', () => {
    for (const search of ['?e2e=1', '?e2e=1&scale=abc', '?e2e=1&scale=0', '?e2e=1&scale=-2']) {
      expect(installE2eHooks(host(search)).scale).toBe(1);
    }
  });

  it('pass stimuli to every subscriber and keep the last results', () => {
    const h = host('?e2e=1');
    const hooks = installE2eHooks(h);
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error('subscriber bug');
    });
    h.__trainer?.onStimulus(b);
    h.__trainer?.onStimulus(a);
    const event = { module: 'szmr' as const, expected: { kind: 'press' as const, key: 'KeyF' }, onset: 1234 };
    hooks.emitStimulus(event);
    expect(a).toHaveBeenCalledWith(event);
    const results: TrialResult[] = [];
    hooks.setLastResults(results);
    expect(h.__trainer?.lastResults).toBe(results);
  });

  it('read the timing probe only in e2e mode and only for a known probe', () => {
    expect(installE2eHooks(host('?e2e=1&probe=pzmr')).probe).toBe('pzmr');
    expect(installE2eHooks(host('?e2e=1')).probe).toBeNull();
    expect(installE2eHooks(host('?e2e=1&probe=rdo')).probe).toBeNull();
    expect(installE2eHooks(host('?probe=pzmr')).probe).toBeNull();
  });

  it('remove __trainer when reinstalled without e2e', () => {
    const h = host('?e2e=1');
    installE2eHooks(h);
    h.location.search = '';
    installE2eHooks(h);
    expect(h.__trainer).toBeUndefined();
  });
});

describe('instrumentBlock', () => {
  function base() {
    const frames: Array<(ts: number) => void> = [];
    const cancel = vi.fn<FrameClock['cancel']>();
    const clock: FrameClock = { request: (cb) => frames.push(cb), cancel };
    const show = vi.fn<StimulusRenderer['show']>();
    const hide = vi.fn<StimulusRenderer['hide']>();
    const tick = vi.fn<StimulusRenderer['tick']>();
    const renderer: StimulusRenderer = { show, hide, tick };
    return { clock, renderer, frames, show, hide, tick, cancel };
  }

  it('leaves clock and renderer alone when hooks are off', () => {
    const b = base();
    const out = instrumentBlock(installE2eHooks(host('')), 'pzmr', [spec('Space')], b);
    expect(out.clock).toBe(b.clock);
    expect(out.renderer).toBe(b.renderer);
  });

  it('emits module, expected and the frame timestamp after each show', () => {
    const b = base();
    const h = host('?e2e=1');
    const hooks = installE2eHooks(h);
    const seen: unknown[] = [];
    const { show } = b;
    h.__trainer?.onStimulus((e) => {
      // Emitted after the stimulus was drawn.
      expect(show).toHaveBeenCalledTimes(seen.length + 1);
      seen.push(e);
    });
    const specs = [spec('KeyF'), spec('KeyJ')];
    const out = instrumentBlock(hooks, 'szmr', specs, b);
    out.clock.request((ts) => {
      out.renderer.show(specs[0]?.stimulus ?? { kind: 'rdo', startDeg: 0, targetDeg: 0, periodMs: 1 });
      expect(ts).toBe(1016);
    });
    b.frames[0]?.(1016);
    out.clock.request(() => {
      out.renderer.tick(5);
      out.renderer.hide();
      out.renderer.show({ kind: 'shape', shape: 'circle', color: 'green' });
    });
    b.frames[1]?.(1500);
    out.clock.cancel(7);
    expect(seen).toEqual([
      { module: 'szmr', expected: { kind: 'press', key: 'KeyF' }, onset: 1016 },
      { module: 'szmr', expected: { kind: 'press', key: 'KeyJ' }, onset: 1500 },
    ]);
    expect(b.tick).toHaveBeenCalledWith(5);
    expect(b.hide).toHaveBeenCalledTimes(1);
    expect(b.cancel).toHaveBeenCalledWith(7);
  });

  it('carries the trial condition when the spec has one, and no cond key otherwise', () => {
    const b = base();
    const h = host('?e2e=1');
    const hooks = installE2eHooks(h);
    const seen: unknown[] = [];
    h.__trainer?.onStimulus((e) => seen.push(e));
    const specs: TrialSpec[] = [{ ...spec('Space'), cond: 'quiet' }, { ...spec('Space'), cond: 'noisy' }, spec('Space')];
    const out = instrumentBlock(hooks, 'pomeh', specs, b);
    for (const s of specs) out.renderer.show(s.stimulus);
    expect(seen).toStrictEqual([
      { module: 'pomeh', expected: { kind: 'press', key: 'Space' }, onset: 0, cond: 'quiet' },
      { module: 'pomeh', expected: { kind: 'press', key: 'Space' }, onset: 0, cond: 'noisy' },
      { module: 'pomeh', expected: { kind: 'press', key: 'Space' }, onset: 0 },
    ]);
  });

  it('instrumentBlock forwards cue without emitting a stimulus event', () => {
    const b = base();
    const cue = vi.fn<NonNullable<StimulusRenderer['cue']>>();
    const h = host('?e2e=1');
    const hooks = installE2eHooks(h);
    const seen: unknown[] = [];
    h.__trainer?.onStimulus((e) => seen.push(e));
    const stimulus: Stimulus = { kind: 'switch', rule: 'color', color: 'red', shape: 'circle', size: 'large' };
    const out = instrumentBlock(hooks, 'taskswitch', [spec('KeyF')], { clock: b.clock, renderer: { ...b.renderer, cue } });
    out.renderer.cue?.(stimulus);
    expect(cue).toHaveBeenCalledWith(stimulus);
    expect(seen).toEqual([]);
    // A renderer without cue: forwarding is a no-op.
    expect(() => instrumentBlock(hooks, 'pzmr', [spec('Space')], b).renderer.cue?.(stimulus)).not.toThrow();
  });

  it('instrumentBlock forwards mark and clearMark (F15)', () => {
    const b = base();
    const mark = vi.fn<NonNullable<StimulusRenderer['mark']>>();
    const clearMark = vi.fn<NonNullable<StimulusRenderer['clearMark']>>();
    const hooks = installE2eHooks(host('?e2e=1'));
    const out = instrumentBlock(hooks, 'szmr', [spec('KeyF')], { clock: b.clock, renderer: { ...b.renderer, mark, clearMark } });
    out.renderer.mark?.('ошибка');
    out.renderer.clearMark?.();
    expect(mark).toHaveBeenCalledWith('ошибка');
    expect(clearMark).toHaveBeenCalledTimes(1);
    // A renderer without them: forwarding is a no-op.
    const plain = instrumentBlock(hooks, 'pzmr', [spec('Space')], b).renderer;
    expect(() => {
      plain.mark?.('рано');
      plain.clearMark?.();
    }).not.toThrow();
  });

  it('instrumentBlock forwards beginFrame and frame', () => {
    const b = base();
    const beginFrame = vi.fn<NonNullable<StimulusRenderer['beginFrame']>>();
    const frame = vi.fn<NonNullable<StimulusRenderer['frame']>>();
    const hooks = installE2eHooks(host('?e2e=1'));
    const out = instrumentBlock(hooks, 'pomeh', [spec('Space')], { clock: b.clock, renderer: { ...b.renderer, beginFrame, frame } });
    out.renderer.beginFrame?.(1200);
    out.renderer.frame?.(1234);
    expect(beginFrame).toHaveBeenCalledWith(1200);
    expect(frame).toHaveBeenCalledWith(1234);
    // A renderer without them: forwarding is a no-op.
    const plain = instrumentBlock(hooks, 'pzmr', [spec('Space')], b).renderer;
    expect(() => {
      plain.beginFrame?.(1);
      plain.frame?.(1);
    }).not.toThrow();
  });
});
