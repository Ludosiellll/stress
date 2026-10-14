import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultModuleState } from './derive';
import { currentPhase, type PhaseInfo } from './phases';
import type { ModuleState } from './planner';
import { MODULE_IDS, type ModuleId } from './types';

const TODAY = '2026-10-14';

/** The local calendar date `n` days after TODAY (negative: before). */
const day = (n: number): string => new Date(Date.UTC(2026, 9, 14 + n)).toISOString().slice(0, 10);

/** First session on the day that makes today day number `d`. */
const firstOnDay = (d: number): string => `${day(1 - d)}T10:00:00`;

const states = (blocks: number, over: Partial<Record<ModuleId, number>> = {}): Record<ModuleId, ModuleState> =>
  Object.fromEntries(
    MODULE_IDS.map((m) => [m, { ...defaultModuleState(m), lifetimeBlocks: over[m] ?? blocks }]),
  ) as Record<ModuleId, ModuleState>;

const CALIBRATED = states(3);

function phase(d: number | null, testInDays: number | null, st = CALIBRATED): PhaseInfo {
  return currentPhase({
    firstSessionAt: d === null ? null : firstOnDay(d),
    today: TODAY,
    testDate: testInDays === null ? null : day(testInDays),
    states: st,
  });
}

describe('currentPhase', () => {
  it('no sessions: base, first days, day 1', () => {
    expect(phase(null, null, states(0))).toEqual({
      phase: 'base',
      reason: 'first_days',
      dayNumber: 1,
      daysToTest: null,
      uncalibrated: [...MODULE_IDS],
    });
  });

  it('base for the first 14 days, development from day 15 when everything is calibrated', () => {
    expect(phase(14, null)).toMatchObject({ phase: 'base', reason: 'first_days', dayNumber: 14 });
    expect(phase(15, null)).toEqual({ phase: 'development', reason: 'weak_spots', dayNumber: 15, daysToTest: null, uncalibrated: [] });
  });

  it('day 20 with a module under 3 blocks stays in base for calibration', () => {
    expect(phase(20, null, states(3, { stroop: 0 }))).toEqual({
      phase: 'base',
      reason: 'calibration',
      dayNumber: 20,
      daysToTest: null,
      uncalibrated: ['stroop'],
    });
    expect(phase(20, null, states(3, { memory: 2 }))).toMatchObject({ phase: 'base', uncalibrated: ['memory'] });
  });

  it('calibration of new modules after an upgrade', () => {
    const upgraded = states(0, { pzmr: 30, szmr: 30, gonogo: 30, rdo: 30, gorbov: 30, schulte: 30, numseries: 30 });
    expect(phase(25, null, upgraded)).toEqual({
      phase: 'base',
      reason: 'calibration',
      dayNumber: 25,
      daysToTest: null,
      uncalibrated: ['stroop', 'taskswitch', 'pomeh', 'memory'],
    });
  });

  it('a test date 10–28 days away is the overload phase, 29 is not, 0–9 is taper', () => {
    expect(phase(30, 20)).toMatchObject({ phase: 'overload', reason: 'test_soon', daysToTest: 20 });
    expect(phase(30, 28)).toMatchObject({ phase: 'overload', reason: 'test_soon', daysToTest: 28 });
    expect(phase(30, 10)).toMatchObject({ phase: 'overload', reason: 'test_soon', daysToTest: 10 });
    expect(phase(30, 29)).toMatchObject({ phase: 'development', reason: 'weak_spots', daysToTest: 29 });
    expect(phase(30, 9)).toMatchObject({ phase: 'taper', reason: 'taper', daysToTest: 9 });
  });

  it('the test date outranks the first days and calibration', () => {
    expect(phase(null, 20, states(0))).toMatchObject({ phase: 'overload', reason: 'test_soon', dayNumber: 1 });
    expect(phase(3, 5, states(0))).toMatchObject({ phase: 'taper', reason: 'taper', dayNumber: 3, daysToTest: 5 });
  });

  it('test day is taper', () => {
    expect(phase(40, 0)).toMatchObject({ phase: 'taper', reason: 'taper', daysToTest: 0 });
  });

  it('past test date is ignored', () => {
    expect(phase(70, -1)).toMatchObject({ phase: 'overload', reason: 'day_60', dayNumber: 70, daysToTest: null });
    expect(phase(20, -1)).toMatchObject({ phase: 'development', reason: 'weak_spots', daysToTest: null });
  });

  it('clearing the date falls back to the day-60 rule', () => {
    expect(phase(59, 5)).toMatchObject({ phase: 'taper' });
    expect(phase(59, null)).toMatchObject({ phase: 'development', reason: 'weak_spots', dayNumber: 59 });
    expect(phase(60, null)).toMatchObject({ phase: 'overload', reason: 'day_60', dayNumber: 60 });
    // A date more than 28 days away keeps the development phase even after day 60.
    expect(phase(70, 40)).toMatchObject({ phase: 'development', reason: 'weak_spots', daysToTest: 40 });
  });

  it('counts local calendar days, whatever the time of the first session', () => {
    const at = (iso: string): number =>
      currentPhase({ firstSessionAt: iso, today: TODAY, testDate: null, states: CALIBRATED }).dayNumber;
    expect(at('2026-10-14T23:59:00')).toBe(1);
    expect(at('2026-10-13T23:59:00')).toBe(2);
    expect(at('2026-10-01T00:01:00')).toBe(14);
    expect(at(new Date(2026, 9, 1, 23, 30).toISOString())).toBe(14);
  });

  describe('across a DST change (Europe/Berlin)', () => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = 'Europe/Berlin';
    });
    afterAll(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it('day numbers and days to the test do not shift by the clock change', () => {
      const p = currentPhase({ firstSessionAt: '2026-10-24T23:30:00', today: '2026-10-26', testDate: '2026-11-04', states: CALIBRATED });
      expect(p).toMatchObject({ dayNumber: 3, daysToTest: 9, phase: 'taper' });
    });
  });
});
