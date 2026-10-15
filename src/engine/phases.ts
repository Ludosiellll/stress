import { daysBetween, localDayNumber, signedDaysBetween } from './dates';
import type { ModuleState } from './planner';
import { MODULE_IDS, type ModuleId } from './types';

/** Training phases (§7.2): база, развитие, перегрузка, подводка. */
export type PhaseId = 'base' | 'development' | 'overload' | 'taper';
export type PhaseReason = 'first_days' | 'calibration' | 'weak_spots' | 'test_soon' | 'day_60' | 'taper';

export interface PhaseInfo {
  phase: PhaseId;
  reason: PhaseReason;
  /** Local calendar day of the training course: the day of the first session of any kind is day 1. */
  dayNumber: number;
  /** Days left to the test date; null without a date or once it has passed. */
  daysToTest: number | null;
  /** Modules with fewer than CALIBRATION_BLOCKS blocks, in MODULE_IDS order (whatever the phase). */
  uncalibrated: ModuleId[];
}

/** «База» lasts at least this many days. */
export const BASE_DAYS = 14;
/** A module is calibrated after this many blocks (training and free); the finisher takes calibrated modules only. */
export const CALIBRATION_BLOCKS = 3;
/** The taper: the 9 days before the test and the test day itself (daysToTest 9…0, 10 calendar days). */
export const TAPER_DAYS = 9;
/** The overload phase: 28 days before the test… */
export const OVERLOAD_DAYS = 28;
/** …or from this day on when no test date is set. */
export const OVERLOAD_FROM_DAY = 60;

export function isCalibrated(s: ModuleState): boolean {
  return s.lifetimeBlocks >= CALIBRATION_BLOCKS;
}

/**
 * The start of the earliest session of any kind (by local calendar day; the first listed on ties), the
 * `firstSessionAt` of currentPhase; null without sessions. Structural: SessionRow fits.
 */
export function firstSessionAt(sessions: readonly { readonly startedAt: string }[]): string | null {
  let first: { readonly startedAt: string } | null = null;
  for (const s of sessions) {
    if (first === null || localDayNumber(s.startedAt) < localDayNumber(first.startedAt)) first = s;
  }
  return first?.startedAt ?? null;
}

/**
 * The phase of `today` (local YYYY-MM-DD), checked in this order:
 * 1. 0–9 days to the test → taper; 2. 10–28 days → overload; 3. no date (or a past one) and day ≥ 60 → overload;
 * 4. day ≤ 14 → base; 5. a module under 3 blocks → base (calibration); 6. otherwise development.
 * Days are local calendar days, so the phase changes at local midnight and never with a DST shift.
 */
export function currentPhase(i: {
  firstSessionAt: string | null;
  today: string;
  testDate: string | null;
  states: Record<ModuleId, ModuleState>;
}): PhaseInfo {
  const dayNumber = i.firstSessionAt === null ? 1 : daysBetween(i.firstSessionAt, i.today) + 1;
  const toTest = i.testDate === null ? null : signedDaysBetween(i.today, i.testDate);
  const daysToTest = toTest !== null && toTest >= 0 ? toTest : null;
  const uncalibrated = MODULE_IDS.filter((m) => !isCalibrated(i.states[m]));
  const info = (phase: PhaseId, reason: PhaseReason): PhaseInfo => ({ phase, reason, dayNumber, daysToTest, uncalibrated });

  if (daysToTest !== null && daysToTest <= TAPER_DAYS) return info('taper', 'taper');
  if (daysToTest !== null && daysToTest <= OVERLOAD_DAYS) return info('overload', 'test_soon');
  if (daysToTest === null && dayNumber >= OVERLOAD_FROM_DAY) return info('overload', 'day_60');
  if (dayNumber <= BASE_DAYS) return info('base', 'first_days');
  if (uncalibrated.length > 0) return info('base', 'calibration');
  return info('development', 'weak_spots');
}
