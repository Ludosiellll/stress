import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../data/memoryRepository';
import { block, session } from '../data/repository.contract';
import type { DiagnosticRow } from '../data/rows';
import { diagnosticSegmentSeed, type DiagnosticResults } from '../engine/diagnostic';
import type { PhaseInfo } from '../engine/phases';
import { readiness } from '../engine/readiness';
import { MODULE_IDS } from '../engine/types';
import { loadHomeModel, mergedBaseline, parseResults, phaseTexts, planLine, readinessOf } from './homeModel';

const EMPTY: DiagnosticResults = {
  pzmrMedianRt: null,
  szmrMedianRt: null,
  gonogoScore: null,
  rdoMeanAbsErrorMs: null,
  gorbov: null,
  numseriesCorrect: null,
  unreliable: [],
};

function row(number: number, results: Partial<DiagnosticResults> | string): DiagnosticRow {
  const resultsJson = typeof results === 'string' ? results : JSON.stringify({ ...EMPTY, ...results });
  return { id: `d${String(number)}`, sessionId: `s${String(number)}`, number, at: `2026-10-0${String(number)}T10:00:00.000Z`, resultsJson };
}

describe('parseResults', () => {
  it('reads rows stored before `unreliable` existed as reliable', () => {
    const old = Object.fromEntries(Object.entries({ ...EMPTY, pzmrMedianRt: 300 }).filter(([k]) => k !== 'unreliable'));
    expect(parseResults(row(1, JSON.stringify(old)))).toEqual({ ...EMPTY, pzmrMedianRt: 300, unreliable: [] });
  });

  it('a missing metric reads as null', () => {
    expect(parseResults(row(1, '{}'))).toEqual(EMPTY);
  });

  it('keeps only reaction module ids in `unreliable`', () => {
    expect(parseResults(row(1, JSON.stringify({ ...EMPTY, unreliable: ['rdo', 'gorbov', 7, 'pzmr'] })))?.unreliable).toEqual(['rdo', 'pzmr']);
  });

  it('null for JSON that is not an object', () => {
    expect(parseResults(row(1, 'not json'))).toBeNull();
    expect(parseResults(row(1, '42'))).toBeNull();
  });
});

describe('mergedBaseline (M2)', () => {
  it('takes every metric from the first diagnostic that has it', () => {
    const merged = mergedBaseline([
      { ...EMPTY, pzmrMedianRt: 320 },
      { ...EMPTY, pzmrMedianRt: 300, rdoMeanAbsErrorMs: 40, gorbov: { V: 40, P: 80, Pi: 20 } },
      { ...EMPTY, pzmrMedianRt: 280, rdoMeanAbsErrorMs: 30, numseriesCorrect: 12 },
    ]);
    expect(merged).toEqual({
      pzmrMedianRt: 320,
      szmrMedianRt: null,
      gonogoScore: null,
      rdoMeanAbsErrorMs: 40,
      gorbov: { V: 40, P: 80, Pi: 20 },
      numseriesCorrect: 12,
    });
  });
});

describe('readinessOf', () => {
  it('null before the first diagnostic', () => {
    expect(readinessOf([])).toBeNull();
  });

  it('a metric missing in the first diagnostic gets its baseline from a later one (M2)', () => {
    const first = row(1, { pzmrMedianRt: 300 });
    const second = row(2, { pzmrMedianRt: 300, rdoMeanAbsErrorMs: 40 });
    const third = row(3, { pzmrMedianRt: 300, rdoMeanAbsErrorMs: 30 });
    const r = readinessOf([first, second, third]);
    const expected = readiness({ ...EMPTY, pzmrMedianRt: 300, rdoMeanAbsErrorMs: 30 }, { ...EMPTY, pzmrMedianRt: 300, rdoMeanAbsErrorMs: 40 });
    expect(r?.abilities).toEqual(expected.abilities);
    // rdo 30 vs its own baseline 40 → better than 60.
    expect(r?.abilities.reaction).toBeGreaterThan(60);
  });

  it('carries the unreliable modules of the latest diagnostic (I1)', () => {
    expect(readinessOf([row(1, { pzmrMedianRt: 300, unreliable: ['pzmr'] })])?.unreliable).toEqual(['pzmr']);
    expect(readinessOf([row(1, { unreliable: ['pzmr'] }), row(2, { pzmrMedianRt: 300 })])?.unreliable).toEqual([]);
  });

  it('no abilities when the latest row cannot be read', () => {
    expect(readinessOf([row(1, { pzmrMedianRt: 300 }), row(2, 'broken')])).toEqual({
      abilities: { reaction: null, attention: null, switching: null, memory: null, logic: null },
      overall: null,
      unreliable: [],
    });
  });
});

describe('loadHomeModel', () => {
  const TODAY = '2026-10-14';

  it('an abandoned diagnostic: the next one keeps its number but gets new seeds (I5)', async () => {
    const repo = new MemoryRepository();
    expect((await loadHomeModel(repo, TODAY)).diagnosticPlan).toMatchObject({ diagnosticNumber: 1, diagnosticSeedIndex: 1 });
    await repo.createSession(session('abandoned', '2026-10-13T10:00:00.000Z', { kind: 'diagnostic' }));
    const plan = (await loadHomeModel(repo, TODAY)).diagnosticPlan;
    expect(plan).toMatchObject({ diagnosticNumber: 1, diagnosticSeedIndex: 2 });
    expect(diagnosticSegmentSeed(plan.diagnosticSeedIndex ?? 0, 'gorbov')).not.toBe(diagnosticSegmentSeed(1, 'gorbov'));
    expect(diagnosticSegmentSeed(plan.diagnosticSeedIndex ?? 0, 'numseries')).not.toBe(diagnosticSegmentSeed(1, 'numseries'));
  });

  it('counts a training day whose session has stored blocks even without an end (M1)', async () => {
    const repo = new MemoryRepository();
    // Yesterday: finished normally. Today: all blocks stored, but the session end was never written.
    await repo.createSession(session('y', '2026-10-13T10:00:00', { endedAt: '2026-10-13T10:40:00' }));
    await repo.createSession(session('t', '2026-10-14T10:00:00'));
    await repo.addBlock(block('b1', 't', '2026-10-14T10:01:00', { module: 'gorbov' }), [], []);
    // A training session with no block and no end (closed on the first instruction) does not count.
    await repo.createSession(session('empty', '2026-10-12T10:00:00'));
    expect((await loadHomeModel(repo, TODAY)).streak).toBe(2);
  });

  it('loadHomeModel computes the phase from the first session and the test date', async () => {
    const repo = new MemoryRepository();
    await repo.createSession(session('t', '2026-10-11T10:00:00'));
    // The earliest session of any kind starts the count: day 1 was 2026-09-24, today is day 21.
    await repo.createSession(session('d', '2026-09-24T23:30:00', { kind: 'diagnostic' }));
    let m = await loadHomeModel(repo, TODAY);
    expect(m.phase).toEqual({ phase: 'base', reason: 'calibration', dayNumber: 21, daysToTest: null, uncalibrated: [...MODULE_IDS] });
    expect(m.plan.phase).toBe('base');
    expect(m.phaseTitle).toBe('Фаза: база');
    expect(m.phaseWhy).toMatch(/^Нужно откалибровать \(по 3 блока\): ПЗМР, /);
    expect(m.hints).toEqual([]);

    // Setting a date changes the phase and the plan at once.
    await repo.saveSettings({ testDate: '2026-11-03' });
    m = await loadHomeModel(repo, TODAY);
    expect(m.phase).toMatchObject({ phase: 'overload', reason: 'test_soon', daysToTest: 20 });
    expect(m.plan.phase).toBe('overload');
    expect(m.plan.segments.filter((s) => s.purpose === 'reaction').map((s) => s.budgetMs)).toEqual([360000, 360000]);
    expect(m.phaseWhy).toBe('До теста 20 дн.: финишер 5 мин, модули реакции по 6 мин.');
    expect(m.daysToTest).toBe(20);

    // A date in the past is ignored by the phase; the line under the plan keeps W1's «0 дн.».
    await repo.saveSettings({ testDate: '2026-10-13' });
    m = await loadHomeModel(repo, TODAY);
    expect(m.phase).toMatchObject({ phase: 'base', reason: 'calibration', daysToTest: null });
    expect(m.daysToTest).toBe(0);

    await repo.saveSettings({ testDate: '2026-10-19' });
    m = await loadHomeModel(repo, TODAY);
    expect(m.phase).toMatchObject({ phase: 'taper', daysToTest: 5 });
    expect(m.plan.phase).toBe('taper');
    expect(m.hints).toHaveLength(2);
    expect(m.rehearsalDue).toBe(true);

    // A diagnostic yesterday: the next rehearsal is not due yet.
    await repo.addDiagnostic({ id: 'dd', sessionId: 'd', number: 1, at: '2026-10-13T18:00:00', resultsJson: '{}' });
    expect((await loadHomeModel(repo, TODAY)).rehearsalDue).toBe(false);
  });
});

describe('phaseTexts', () => {
  const info = (over: Partial<PhaseInfo>): PhaseInfo => ({
    phase: 'base',
    reason: 'first_days',
    dayNumber: 1,
    daysToTest: null,
    uncalibrated: [],
    ...over,
  });

  it('gives the title, the reason and the taper hints', () => {
    expect(phaseTexts(info({ dayNumber: 3 }))).toEqual({
      title: 'Фаза: база',
      why: 'День 3 из 14: калибровка уровней и стартовая диагностика.',
      hints: [],
    });
    expect(phaseTexts(info({ reason: 'calibration', dayNumber: 25, uncalibrated: ['stroop', 'taskswitch', 'pomeh', 'memory'] }))).toEqual({
      title: 'Фаза: база',
      why: 'Нужно откалибровать (по 3 блока): Струп, Переключение правил, Помехоустойчивость, Память.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'development', reason: 'weak_spots', dayNumber: 30 }))).toEqual({
      title: 'Фаза: развитие',
      why: 'Больше времени отстающим модулям и тем, что давно не тренировались.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'overload', reason: 'test_soon', daysToTest: 20 }))).toEqual({
      title: 'Фаза: перегрузка',
      why: 'До теста 20 дн.: финишер 5 мин, модули реакции по 6 мин.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'overload', reason: 'day_60', dayNumber: 64 }))).toEqual({
      title: 'Фаза: перегрузка',
      why: '64-й день тренировок, дата теста не задана: финишер 5 мин, модули реакции по 6 мин.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'taper', reason: 'taper', daysToTest: 5 }))).toEqual({
      title: 'Фаза: подводка',
      why: 'До теста 5 дн.: объём меньше на 40 %, без финишера и новых модулей.',
      hints: ['Тренируйся утром, в то же время, на которое назначен тест.', 'Перед тестом спи не меньше 8 часов.'],
    });
  });
});

describe('planLine', () => {
  it('module, minutes and what the overload blocks are', () => {
    expect(planLine({ module: 'rdo', budgetMs: 180000, purpose: 'finisher', overload: 'finisher' })).toBe(
      'Реакция на движущийся объект — 3 мин — финишер с перегрузкой',
    );
    expect(planLine({ module: 'szmr', budgetMs: 300000, purpose: 'reaction', overload: 'mix' })).toBe(
      'Сложная реакция (СЗМР) — 5 мин — с блоками перегрузки (плато)',
    );
    expect(planLine({ module: 'gorbov', budgetMs: 210000, purpose: 'attention' })).toBe('Красно-чёрные таблицы Горбова — 3,5 мин');
    expect(planLine({ module: 'pzmr', budgetMs: 60000, purpose: 'warmup' })).toBe('ПЗМР — 1 мин');
  });
});
