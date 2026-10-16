import { describe, expect, it } from 'vitest';
import { parseExportBundle } from '../data/bundleSchema';
import { exportBundle } from '../data/export';
import { importBundle } from '../data/importBundle';
import { MemoryRepository } from '../data/memoryRepository';
import { block, session } from '../data/repository.contract';
import type { DiagnosticRow } from '../data/rows';
import { EMPTY_RESULTS, diagnosticSegmentSeed, type DiagnosticResults } from '../engine/diagnostic';
import type { PhaseInfo } from '../engine/phases';
import type { Segment, SessionPlan } from '../engine/planner';
import { readiness } from '../engine/readiness';
import { MODULE_IDS, type ModuleId } from '../engine/types';
import { loadHomeModel, phaseTexts, planLine, readinessOf } from './homeModel';

const EMPTY: DiagnosticResults = EMPTY_RESULTS;

function row(number: number, results: Partial<DiagnosticResults> | string): DiagnosticRow {
  const resultsJson = typeof results === 'string' ? results : JSON.stringify({ ...EMPTY, ...results });
  return { id: `d${String(number)}`, sessionId: `s${String(number)}`, number, at: `2026-10-0${String(number)}T10:00:00.000Z`, resultsJson };
}

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

  it('leaves out the parts the latest diagnostic is the baseline of, and says so (W2-R31)', () => {
    const w1 = { pzmrMedianRt: 300, gonogoScore: 80, numseriesCorrect: 10 };
    const r = readinessOf([row(1, w1), row(2, { ...w1, pzmrMedianRt: 240, memorySpan: 6, stroopInterferenceMs: 100 })]);
    expect(r).toEqual({ ...readiness({ ...EMPTY, ...w1, pzmrMedianRt: 240 }, { ...EMPTY, ...w1 }), unreliable: [], deferred: true });
    expect(readinessOf([row(1, { ...w1, memorySpan: 6 })])?.deferred).toBe(false);
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
      deferred: false,
    });
  });
});

describe('loadHomeModel', () => {
  const TODAY = '2026-10-14';

  it('after restoring older diagnostics next to a newer №1, baseline, latest and due follow the dates (W2-R33)', async () => {
    const diag = async (repo: MemoryRepository, id: string, number: number, at: string, pzmrMedianRt: number) => {
      await repo.createSession(session(`s-${id}`, at, { kind: 'diagnostic' }));
      await repo.addDiagnostic({ id, sessionId: `s-${id}`, number, at, resultsJson: JSON.stringify({ ...EMPTY, pzmrMedianRt }) });
    };
    // The old computer: two diagnostics in September. The fresh install: its own №1 today.
    const old = new MemoryRepository();
    await diag(old, 'old-1', 1, '2026-09-01T10:00:00.000Z', 400);
    await diag(old, 'old-2', 2, '2026-09-15T10:00:00.000Z', 300);
    const target = new MemoryRepository();
    await diag(target, 'new-1', 1, `${TODAY}T08:00:00.000Z`, 280);
    const file = parseExportBundle(await exportBundle(old, '0.2.0'));
    if (!file.ok) throw new Error(file.error);
    expect((await importBundle(target, file.bundle, { pause: () => Promise.resolve() })).error).toBeNull();

    const model = await loadHomeModel(target, TODAY);
    // Due is read from today's diagnostic, not from the restored one of 2026-09-15.
    expect(model.diagnosticDue).toBe(false);
    // The baseline is the restored №1 (400 ms), the latest is today's 280 ms.
    expect(model.readiness?.abilities.reaction).toBe(readiness({ ...EMPTY, pzmrMedianRt: 280 }, { ...EMPTY, pzmrMedianRt: 400 }).abilities.reaction);
    expect(model.readiness?.abilities.reaction).toBe(100);
  });

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

  it('loadHomeModel plans a test-format run from the dates of the stored runs (F4)', async () => {
    const repo = new MemoryRepository();
    // Day 1 was 2026-09-24: today is day 21. One ПЗМР run 10 days ago: the next format is СЗМР, and it is due.
    await repo.createSession(session('s1', '2026-09-24T10:00:00'));
    await repo.createSession(session('s2', '2026-10-04T10:00:00'));
    await repo.addBlock(block('b1', 's1', '2026-09-24T10:01:00', { module: 'szmr' }), [], []);
    await repo.addBlock(block('r1', 's2', '2026-10-04T10:01:00', { module: 'pzmr', flags: ['test_format'] }), [], []);
    const plan = (await loadHomeModel(repo, TODAY)).plan;
    expect(plan.segments[0]).toEqual({ module: 'szmr', budgetMs: 0, purpose: 'test_format', trialCount: 70, practiceTrials: 5 });
    expect(planLine(plan.segments[0] as Segment)).toBe('Прогон в формате теста: СЗМР, 70 сигналов (около 3 мин)');
    // A run two days ago: none today.
    await repo.createSession(session('s3', '2026-10-12T10:00:00'));
    await repo.addBlock(block('r2', 's3', '2026-10-12T10:01:00', { module: 'szmr', flags: ['test_format'] }), [], []);
    expect((await loadHomeModel(repo, TODAY)).plan.segments.map((s) => s.purpose)).not.toContain('test_format');
  });

  it('a run counted as 0 after Esc uses up its slot and its turn of the formats (F11, T-R10)', async () => {
    const repo = new MemoryRepository();
    // Day 21, as above: the ПЗМР run of 10 days ago makes СЗМР due.
    await repo.createSession(session('s1', '2026-09-24T10:00:00'));
    await repo.createSession(session('s2', '2026-10-04T10:00:00'));
    await repo.addBlock(block('b1', 's1', '2026-09-24T10:01:00', { module: 'szmr' }), [], []);
    await repo.addBlock(block('r1', 's2', '2026-10-04T10:01:00', { module: 'pzmr', flags: ['test_format'] }), [], []);
    // Two days ago the СЗМР run was interrupted after 45 %: it still was a run.
    await repo.createSession(session('s3', '2026-10-12T10:00:00'));
    const summaryJson = JSON.stringify({ discarded: { reason: 'user', progress: 0.45 } });
    await repo.addBlock(block('r2', 's3', '2026-10-12T10:01:00', { module: 'szmr', flags: ['test_format', 'discarded'], score: 0, summaryJson }), [], []);
    expect((await loadHomeModel(repo, TODAY)).plan.segments.map((s) => s.purpose)).not.toContain('test_format');
    // Five days later the next run is Go/No-Go, not СЗМР again.
    const later = (await loadHomeModel(repo, '2026-10-19')).plan.segments[0];
    expect(later).toMatchObject({ module: 'gonogo', purpose: 'test_format' });
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
    // Day 21 without runs: the plan opens with a ПЗМР run (F4); the one reaction slot left is 6 minutes long.
    expect(m.plan.segments[0]).toMatchObject({ module: 'pzmr', purpose: 'test_format' });
    expect(m.plan.segments.filter((s) => s.purpose === 'reaction').map((s) => s.budgetMs)).toEqual([360000]);
    // No module has 3 blocks yet: the plan has no finisher, and the reason does not promise one.
    expect(m.plan.segments.some((s) => s.purpose === 'finisher')).toBe(false);
    expect(m.phaseWhy).toBe('До теста 20 дн.: модули реакции по 6 мин.');
    // The reason already counts the days: no second countdown under the plan.
    expect(m.testLine).toBeNull();

    // A date far off: the reason does not mention it, the line under the plan does.
    await repo.saveSettings({ testDate: '2026-11-23' });
    m = await loadHomeModel(repo, TODAY);
    expect(m.phase).toMatchObject({ phase: 'base', reason: 'calibration', daysToTest: 40 });
    expect(m.testLine).toBe('До теста: 40 дн.');

    // A date in the past is ignored by the phase, and the line under the plan asks to update it.
    await repo.saveSettings({ testDate: '2026-10-13' });
    m = await loadHomeModel(repo, TODAY);
    expect(m.phase).toMatchObject({ phase: 'base', reason: 'calibration', daysToTest: null });
    expect(m.testLine).toBe('Дата теста прошла — обнови её в настройках.');

    await repo.saveSettings({ testDate: '2026-10-19' });
    m = await loadHomeModel(repo, TODAY);
    expect(m.phase).toMatchObject({ phase: 'taper', daysToTest: 5 });
    expect(m.plan.phase).toBe('taper');
    expect(m.testLine).toBeNull();
    // Nothing was ever trained, so the taper plan is made of new modules and the reason does not deny it (B2).
    expect(m.phaseWhy).toBe('До теста 5 дн.: объём меньше на 40 %, без финишера.');
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

  const seg = (module: Segment['module'], purpose: Segment['purpose'], budgetMs: number, over: Partial<Segment> = {}): Segment => ({
    module,
    budgetMs,
    purpose,
    ...over,
  });
  /** The overload-phase plan: reaction modules 6 min each, with or without the 5-minute finisher. */
  const overloadPlan = (finisher: boolean): Pick<SessionPlan, 'segments'> => ({
    segments: [
      seg('pzmr', 'warmup', 120000),
      seg('szmr', 'reaction', 360000),
      seg('gonogo', 'reaction', 360000),
      seg('gorbov', 'attention', 300000),
      seg('memory', 'attention', 300000),
      seg('numseries', 'logic', 600000),
      ...(finisher ? [seg('rdo', 'finisher', 300000, { overload: 'finisher' })] : []),
    ],
  });
  const NO_PLAN: Pick<SessionPlan, 'segments'> = { segments: [] };
  const NONE_NEW: ReadonlySet<ModuleId> = new Set();

  it('gives the title, the reason and the taper hints', () => {
    expect(phaseTexts(info({ dayNumber: 3 }), NO_PLAN, NONE_NEW)).toEqual({
      title: 'Фаза: база',
      why: 'День 3 из 14: калибровка уровней и стартовая диагностика.',
      hints: [],
    });
    expect(phaseTexts(info({ reason: 'calibration', dayNumber: 25, uncalibrated: ['stroop', 'taskswitch', 'pomeh', 'memory'] }), NO_PLAN, NONE_NEW)).toEqual({
      title: 'Фаза: база',
      why: 'Нужно откалибровать (по 3 блока): Струп, Переключение правил, Помехоустойчивость, Память.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'development', reason: 'weak_spots', dayNumber: 30 }), NO_PLAN, NONE_NEW)).toEqual({
      title: 'Фаза: развитие',
      why: 'Больше времени отстающим модулям и тем, что давно не тренировались.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'overload', reason: 'test_soon', daysToTest: 20 }), overloadPlan(true), NONE_NEW)).toEqual({
      title: 'Фаза: перегрузка',
      why: 'До теста 20 дн.: финишер 5 мин, модули реакции по 6 мин.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'overload', reason: 'day_60', dayNumber: 64 }), overloadPlan(true), NONE_NEW)).toEqual({
      title: 'Фаза: перегрузка',
      why: '64-й день тренировок, дата теста не задана: финишер 5 мин, модули реакции по 6 мин.',
      hints: [],
    });
    expect(phaseTexts(info({ phase: 'taper', reason: 'taper', daysToTest: 5 }), NO_PLAN, NONE_NEW)).toEqual({
      title: 'Фаза: подводка',
      why: 'До теста 5 дн.: объём меньше на 40 %, без финишера и новых модулей.',
      hints: ['Тренируйся утром, в то же время, на которое назначен тест.', 'Перед тестом спи не меньше 8 часов.'],
    });
  });

  it('the overload reason mentions the finisher only when the plan has one', () => {
    expect(phaseTexts(info({ phase: 'overload', reason: 'test_soon', daysToTest: 20 }), overloadPlan(false), NONE_NEW).why).toBe(
      'До теста 20 дн.: модули реакции по 6 мин.',
    );
    expect(phaseTexts(info({ phase: 'overload', reason: 'day_60', dayNumber: 64 }), overloadPlan(false), NONE_NEW).why).toBe(
      '64-й день тренировок, дата теста не задана: модули реакции по 6 мин.',
    );
  });

  it('the taper reason says «без новых модулей» only when the plan has none (B2)', () => {
    const taper = info({ phase: 'taper', reason: 'taper', daysToTest: 5 });
    const plan = { segments: [seg('pzmr', 'warmup', 60000), seg('szmr', 'reaction', 180000), seg('gonogo', 'reaction', 180000)] };
    // Go/No-Go was never trained and fills a slot the trained modules could not: the plan has a new module.
    expect(phaseTexts(taper, plan, new Set<ModuleId>(['gonogo', 'stroop'])).why).toBe('До теста 5 дн.: объём меньше на 40 %, без финишера.');
    // Струп was never trained and was left out: the plan has none.
    expect(phaseTexts(taper, plan, new Set<ModuleId>(['stroop'])).why).toBe(
      'До теста 5 дн.: объём меньше на 40 %, без финишера и новых модулей.',
    );
  });

  it('the test day says the test is today', () => {
    expect(phaseTexts(info({ phase: 'taper', reason: 'taper', daysToTest: 0 }), NO_PLAN, NONE_NEW).why).toBe(
      'Сегодня тест: объём меньше на 40 %, без финишера и новых модулей.',
    );
    expect(phaseTexts(info({ phase: 'taper', reason: 'taper', daysToTest: 1 }), NO_PLAN, NONE_NEW).why).toBe(
      'До теста 1 дн.: объём меньше на 40 %, без финишера и новых модулей.',
    );
  });
});

describe('planLine', () => {
  it('a test-format run: its format, its size and about how long it takes (F4)', () => {
    expect(planLine({ module: 'szmr', budgetMs: 0, purpose: 'test_format', trialCount: 70, practiceTrials: 5 })).toBe(
      'Прогон в формате теста: СЗМР, 70 сигналов (около 3 мин)',
    );
    expect(planLine({ module: 'pzmr', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 })).toBe(
      'Прогон в формате теста: ПЗМР, 50 сигналов (около 2 мин)',
    );
    expect(planLine({ module: 'rdo', budgetMs: 0, purpose: 'test_format', trialCount: 50, practiceTrials: 5 })).toBe(
      'Прогон в формате теста: РДО, 50 сигналов (около 3 мин)',
    );
  });

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
