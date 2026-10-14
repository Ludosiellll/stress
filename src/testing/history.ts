import { MemoryRepository } from '../data/memoryRepository';
import type { Repository } from '../data/repository';
import type { WellbeingRow } from '../data/rows';
import { planDiagnostic } from '../engine/diagnostic';
import { currentPhase } from '../engine/phases';
import { planFree, planTraining, type SessionPlan } from '../engine/planner';
import { SessionController } from '../session/controller';
import { perfectMemoryAnswers, perfectPlayer, perfectSeriesAnswers, perfectTableRun, playTimeline } from './sessionPlayers';

/** A small real history for data-layer tests, recorded through SessionController with the perfect players. */

const DAY_MS = 86_400_000;
/** Every block moves the clock this far on (budgets at the e2e scale are shorter: one block per segment). */
const BLOCK_MS = 30_000;

/** Plays a whole session; a training ends with `wellbeing` (null: skipped). */
async function playToEnd(ctl: SessionController, advance: (ms: number) => void, wellbeing: Omit<WellbeingRow, 'id' | 'date'> | null): Promise<void> {
  for (let guard = 0; guard < 1000; guard++) {
    const step = ctl.step;
    switch (step.kind) {
      case 'instruction':
        ctl.ackInstruction();
        break;
      case 'reaction_block':
        advance(BLOCK_MS);
        await ctl.submitReaction(playTimeline(step.specs, perfectPlayer));
        break;
      case 'table_block':
        advance(BLOCK_MS);
        await ctl.submitTable(perfectTableRun(step));
        break;
      case 'numseries_block':
        advance(BLOCK_MS);
        await ctl.submitNumSeries(perfectSeriesAnswers(step.items));
        break;
      case 'memory_block':
        advance(BLOCK_MS);
        await ctl.submitMemory(perfectMemoryAnswers(step.trials));
        break;
      case 'summary':
        await ctl.continueAfterSummary();
        break;
      case 'fatigue_prompt':
        await ctl.answerFatigue(true);
        break;
      case 'wellbeing':
        await ctl.submitWellbeing(wellbeing);
        break;
      case 'save_error':
        throw new Error(`unexpected save error: ${step.message}`);
      case 'done':
        return;
    }
  }
  throw new Error('session did not finish');
}

/**
 * Records into `repo` (a fresh MemoryRepository by default), at the e2e scale, from `startIso` (local time):
 * day 1 the first-day training (reaction blocks, Gorbov, memory, number series) with a wellbeing entry;
 * day 2 control diagnostic 1; day 3 free Струп; day 4 a second training with another wellbeing entry.
 */
export async function recordHistory(repo: Repository = new MemoryRepository(), startIso = '2026-10-01T09:00:00'): Promise<Repository> {
  let nowMs = new Date(startIso).getTime();
  const now = (): Date => new Date(nowMs);
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  const run = async (plan: SessionPlan, wellbeing: Omit<WellbeingRow, 'id' | 'date'> | null = null): Promise<void> => {
    const ctl = await SessionController.start({ repo, plan, layout: 'keyboard', now, appVersion: '0.2.0', scale: 0.02, sleep: () => Promise.resolve() });
    await playToEnd(ctl, advance, wellbeing);
  };
  const training = async (seed: number): Promise<SessionPlan> => {
    const [states, sessions] = await Promise.all([repo.getModuleStates(), repo.listSessions()]);
    const today = now().toISOString();
    return planTraining(states, today, seed, currentPhase({ firstSessionAt: sessions[0]?.startedAt ?? null, today, testDate: null, states }));
  };

  await run(await training(1), { sleepH: 7.5, caffeine: true, mood: 4 });
  advance(DAY_MS);
  await run(planDiagnostic(1));
  advance(DAY_MS);
  await run(planFree('stroop', 3));
  advance(DAY_MS);
  await run(await training(4), { sleepH: 6, caffeine: false, mood: 2 });
  return repo;
}
