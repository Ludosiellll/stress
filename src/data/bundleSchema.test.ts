import { describe, expect, it } from 'vitest';
import { localDayNumber } from '../engine/dates';
import { recordHistory } from '../testing/history';
import { parseExportBundle, type ExportBundle } from './bundleSchema';
import { exportBundle } from './export';
import { MemoryRepository } from './memoryRepository';
import type { Repository } from './repository';
import { block, item, session, trial } from './repository.contract';

const T1 = '2026-10-01T08:00:00.000Z';

/** A small valid export as plain JSON, every table filled. */
function minimal(): Record<string, unknown> {
  return {
    appVersion: '0.2.0',
    exportedAt: '2026-10-14T10:00:00.000Z',
    sessions: [session('s1', T1, { endedAt: '2026-10-01T08:30:00.000Z' }), session('s2', '2026-10-02T08:00:00.000Z', { kind: 'diagnostic' })],
    blocks: [block('b1', 's1', T1, { flags: ['calibration'] }), block('b2', 's1', '2026-10-01T08:05:00.000Z', { module: 'numseries' })],
    trials: [trial('t1', 'b1', 0), trial('t2', 'b1', 1)],
    logicItems: [item('i1', 'b2', '2026-10-01T08:06:00.000Z', { timeLimitMs: 11_900 })],
    diagnostics: [{ id: 'd1', sessionId: 's2', number: 1, at: '2026-10-02T08:30:00.000Z', resultsJson: '{}' }],
    wellbeing: [{ id: 'w1', date: '2026-10-01', sleepH: 7, caffeine: false, mood: 3 }],
    settings: { layout: 'keyboard', testDate: '2026-12-01', lastSelfCheckJson: null, stressVolume: 60 },
  };
}

/** `minimal()` with `edit` applied to it. */
function variant(edit: (b: Record<string, unknown> & { [table: string]: unknown }) => void): string {
  const b = minimal();
  edit(b);
  return JSON.stringify(b);
}

/** The rows of table `t` in a plain bundle. */
const rows = (b: Record<string, unknown>, t: string): Record<string, unknown>[] => b[t] as Record<string, unknown>[];

function parsed(text: string): ExportBundle {
  const r = parseExportBundle(text);
  if (!r.ok) throw new Error(`expected a valid bundle, got: ${r.error}`);
  return r.bundle;
}

const errorOf = (text: string): string | null => {
  const r = parseExportBundle(text);
  return r.ok ? null : r.error;
};

async function listsOf(repo: Repository) {
  return {
    sessions: await repo.listSessions(),
    blocks: await repo.listBlocks(),
    trials: await repo.listAllTrials(),
    logicItems: await repo.listLogicItems(),
    diagnostics: await repo.listDiagnostics(),
    wellbeing: await repo.listWellbeing(),
  };
}

describe('parseExportBundle: valid files', () => {
  it('parses a bundle written by exportBundle', async () => {
    const repo = await recordHistory();
    const lists = await listsOf(repo);
    // The history has what the restore must carry: reaction and series blocks, a diagnostic, wellbeing.
    const modules = new Set(lists.blocks.map((b) => b.module));
    for (const m of ['pzmr', 'stroop', 'gorbov', 'memory', 'numseries'] as const) expect(modules.has(m), m).toBe(true);
    expect(lists.trials.length).toBeGreaterThan(50);
    expect(lists.logicItems.length).toBeGreaterThan(0);
    expect(lists.diagnostics).toHaveLength(1);
    expect(lists.wellbeing).toHaveLength(2);
    await repo.saveSettings({ testDate: '2026-12-01', layout: 'pult' });

    const bundle = parsed(await exportBundle(repo, '0.2.0'));
    expect(bundle).toEqual({
      appVersion: '0.2.0',
      exportedAt: expect.any(String) as unknown,
      ...lists,
      settings: { testDate: '2026-12-01', layout: 'pult' },
      settingsSkipped: [],
    });
  });

  it('a 0.1.0 export without timeLimitMs reads as null', () => {
    const text = variant((b) => {
      b.appVersion = '0.1.0';
      for (const i of rows(b, 'logicItems')) delete i.timeLimitMs;
    });
    expect(parsed(text).logicItems).toEqual([item('i1', 'b2', '2026-10-01T08:06:00.000Z', { timeLimitMs: null })]);
  });

  it('extra fields are dropped', () => {
    const text = variant((b) => {
      b.cloudToken = 'secret';
      Object.assign(rows(b, 'sessions')[0] ?? {}, { device: 'laptop' });
      Object.assign(rows(b, 'trials')[1] ?? {}, { note: 1 });
    });
    const bundle = parsed(text);
    expect(Object.keys(bundle).sort()).toEqual([
      'appVersion',
      'blocks',
      'diagnostics',
      'exportedAt',
      'logicItems',
      'sessions',
      'settings',
      'settingsSkipped',
      'trials',
      'wellbeing',
    ]);
    expect(bundle.sessions[0]).toEqual(session('s1', T1, { endedAt: '2026-10-01T08:30:00.000Z' }));
    expect(bundle.trials[1]).toEqual(trial('t2', 'b1', 1));
  });

  it('settings: only testDate and layout are read; absent settings or keys stay absent', () => {
    expect(parsed(JSON.stringify(minimal())).settings).toEqual({ testDate: '2026-12-01', layout: 'keyboard' });
    expect(parsed(variant((b) => delete b.settings)).settings).toEqual({});
    expect(parsed(variant((b) => (b.settings = { testDate: null }))).settings).toEqual({ testDate: null });
    expect(parsed(variant((b) => (b.settings = { stressVolume: 'loud' }))).settings).toEqual({});
  });

  it('W2-R32: a bad testDate or layout is dropped and named; it never vetoes the history', () => {
    const skipped = (settings: unknown) => {
      const b = parsed(variant((x) => (x.settings = settings)));
      expect(b.sessions).toHaveLength(2);
      return { settings: b.settings, settingsSkipped: b.settingsSkipped };
    };
    expect(skipped({ testDate: '01.12.2026', layout: 'pult' })).toEqual({ settings: { layout: 'pult' }, settingsSkipped: ['testDate'] });
    expect(skipped({ testDate: null, layout: 'gamepad' })).toEqual({ settings: { testDate: null }, settingsSkipped: ['layout'] });
    expect(skipped({ testDate: '2026-02-30', layout: 7 })).toEqual({ settings: {}, settingsSkipped: ['testDate', 'layout'] });
    // Settings that are not an object at all: neither value can be read.
    for (const settings of ['pult', null, ['keyboard']]) {
      expect(skipped(settings)).toEqual({ settings: {}, settingsSkipped: ['testDate', 'layout'] });
    }
    expect(parsed(variant((b) => delete b.settings)).settingsSkipped).toEqual([]);
  });

  it('W2-R32: fractional levels up to 1000 are valid', () => {
    const b = parsed(variant((x) => Object.assign(rows(x, 'blocks')[0] ?? {}, { lBefore: 0, lAfter: 1000 })));
    expect(b.blocks[0]).toMatchObject({ lBefore: 0, lAfter: 1000 });
    expect(parsed(variant((x) => Object.assign(rows(x, 'blocks')[0] ?? {}, { lBefore: 2.5, lAfter: 3.25 }))).blocks[0]).toMatchObject({
      lBefore: 2.5,
      lAfter: 3.25,
    });
  });

  it('W2-R32: well-formed strings, including characters outside the BMP, are kept', () => {
    const b = parsed(variant((x) => Object.assign(rows(x, 'sessions')[0] ?? {}, { phase: 'база 🙂' })));
    expect(b.sessions[0]?.phase).toBe('база 🙂');
  });

  it('an empty history is a valid file', async () => {
    const bundle = parsed(await exportBundle(new MemoryRepository(), '0.2.0'));
    expect(bundle).toMatchObject({ sessions: [], blocks: [], trials: [], logicItems: [], diagnostics: [], wellbeing: [] });
  });
});

describe('parseExportBundle: errors (the first one found)', () => {
  it('not JSON', () => {
    expect(errorOf('{"sessions": [')).toBe('Файл не читается как JSON.');
    expect(errorOf('')).toBe('Файл не читается как JSON.');
  });

  it('not an export: a list is missing', () => {
    expect(errorOf(variant((b) => delete b.sessions))).toBe('Это не файл экспорта тренажёра: нет списка sessions.');
    expect(errorOf('[]')).toBe('Это не файл экспорта тренажёра: нет списка sessions.');
    expect(errorOf('null')).toBe('Это не файл экспорта тренажёра: нет списка sessions.');
    expect(errorOf(variant((b) => (b.wellbeing = {})))).toBe('Это не файл экспорта тренажёра: нет списка wellbeing.');
    expect(errorOf(variant((b) => delete b.appVersion))).toBe('Это не файл экспорта тренажёра: нет поля appVersion.');
  });

  it('a field of the wrong type names the table, index, field and what was expected', () => {
    expect(errorOf(variant((b) => Object.assign(rows(b, 'blocks')[0] ?? {}, { score: 'x' })))).toBe(
      'Запись blocks[0]: поле score должно быть числом.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'blocks')[1] ?? {}, { lAfter: null })))).toBe(
      'Запись blocks[1]: поле lAfter должно быть числом от 0 до 1000.',
    );
    expect(errorOf(variant((b) => delete rows(b, 'sessions')[1]?.phase))).toBe('Запись sessions[1]: поле phase должно быть строкой.');
    expect(errorOf(variant((b) => Object.assign(rows(b, 'trials')[1] ?? {}, { frameDropped: 0 })))).toBe(
      'Запись trials[1]: поле frameDropped должно быть true или false.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'trials')[0] ?? {}, { rtMs: 'fast' })))).toBe(
      'Запись trials[0]: поле rtMs должно быть числом или null.',
    );
    expect(errorOf(variant((b) => (rows(b, 'diagnostics')[0] = 'd1' as unknown as Record<string, unknown>)))).toBe(
      'Запись diagnostics[0] должна быть объектом JSON.',
    );
  });

  it('unknown module, kind and family; flags outside BlockFlag; mood outside 1…5', () => {
    expect(errorOf(variant((b) => Object.assign(rows(b, 'blocks')[0] ?? {}, { module: 'tetris' })))).toBe(
      'Запись blocks[0]: поле module должно быть одним из: pzmr, szmr, gonogo, rdo, gorbov, schulte, stroop, taskswitch, pomeh, memory, numseries.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'blocks')[0] ?? {}, { flags: ['bad'] })))).toBe(
      'Запись blocks[0]: поле flags должно быть списком из: fatigued, timing_unreliable, calibration, overload.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'blocks')[0] ?? {}, { flags: 'calibration' })))).toBe(
      'Запись blocks[0]: поле flags должно быть списком из: fatigued, timing_unreliable, calibration, overload.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'sessions')[0] ?? {}, { kind: 'cloud' })))).toBe(
      'Запись sessions[0]: поле kind должно быть одним из: training, diagnostic, free.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'logicItems')[0] ?? {}, { family: 'primes' })))).toBe(
      'Запись logicItems[0]: поле family должно быть одним из: arith, geom, second, alt, fib, linrec, powers, opcycle.',
    );
    for (const mood of [7, 0, 2.5, '3']) {
      expect(errorOf(variant((b) => Object.assign(rows(b, 'wellbeing')[0] ?? {}, { mood })))).toBe(
        'Запись wellbeing[0]: поле mood должно быть целым числом от 1 до 5.',
      );
    }
  });

  it('numbers must be finite; a per-item limit positive or null', () => {
    // JSON has no NaN or Infinity, but 1e999 parses to Infinity.
    expect(errorOf(JSON.stringify(minimal()).replace('"sleepH":7', '"sleepH":1e999'))).toBe('Запись wellbeing[0]: поле sleepH должно быть числом.');
    expect(errorOf(variant((b) => Object.assign(rows(b, 'logicItems')[0] ?? {}, { timeLimitMs: 0 })))).toBe(
      'Запись logicItems[0]: поле timeLimitMs должно быть положительным числом или null.',
    );
  });

  it('W2-R32: levels are numbers from 0 to 1000 (a huge lAfter would become L_saved for good)', () => {
    const level = (field: string, value: number): string | null =>
      errorOf(variant((b) => Object.assign(rows(b, 'blocks')[0] ?? {}, { [field]: value })));
    expect(level('lAfter', 1e9)).toBe('Запись blocks[0]: поле lAfter должно быть числом от 0 до 1000.');
    expect(level('lAfter', 1000.5)).toBe('Запись blocks[0]: поле lAfter должно быть числом от 0 до 1000.');
    expect(level('lBefore', -1)).toBe('Запись blocks[0]: поле lBefore должно быть числом от 0 до 1000.');
    expect(errorOf(JSON.stringify(minimal()).replace('"lBefore":3', '"lBefore":1e999'))).toBe(
      'Запись blocks[0]: поле lBefore должно быть числом от 0 до 1000.',
    );
  });

  it('W2-R32: date-times are written as toISOString writes them (lists sort by text)', () => {
    const iso = 'должно быть датой и временем ISO, например 2026-10-14T09:00:00.000Z';
    const at = (table: string, i: number, field: string, value: string): string | null =>
      errorOf(variant((b) => Object.assign(rows(b, table)[i] ?? {}, { [field]: value })));
    for (const value of ['2026-10-01T08:00:00Z', '2026-10-01T11:00:00.000+03:00', '2026-10-01', '2026-10-01T08:00:00.000']) {
      expect(Number.isNaN(Date.parse(value)), value).toBe(false);
      expect(at('sessions', 0, 'startedAt', value), value).toBe(`Запись sessions[0]: поле startedAt ${iso}.`);
    }
    expect(at('sessions', 0, 'endedAt', '2026-10-01T08:30:00Z')).toBe(`Запись sessions[0]: поле endedAt ${iso}, или null.`);
    expect(at('blocks', 1, 'startedAt', '2026-10-01T08:05Z')).toBe(`Запись blocks[1]: поле startedAt ${iso}.`);
    expect(at('logicItems', 0, 'at', '2026-10-01T08:06:00Z')).toBe(`Запись logicItems[0]: поле at ${iso}.`);
    expect(at('diagnostics', 0, 'at', '2026-10-02T08:30:00.000+00:00')).toBe(`Запись diagnostics[0]: поле at ${iso}.`);
    expect(errorOf(variant((b) => (b.exportedAt = '2026-10-14')))).toBe(`Файл экспорта: поле exportedAt ${iso}.`);
    expect(errorOf(variant((b) => (b.exportedAt = 5)))).toBe('Это не файл экспорта тренажёра: нет поля exportedAt.');
  });

  it('W2-R32: a lone surrogate (serde_json refuses it on the Tauri bridge) is not a string', () => {
    const broken = 'должно быть строкой без повреждённых символов.';
    const set = (table: string, i: number, field: string, value: string): string | null =>
      errorOf(variant((b) => Object.assign(rows(b, table)[i] ?? {}, { [field]: value })));
    // JSON.stringify writes a lone surrogate as \ud83d and JSON.parse gives it back.
    expect(JSON.parse(JSON.stringify('\ud83d'))).toBe('\ud83d');
    expect(set('trials', 1, 'stimulusJson', '{"w":"\ud83d"}')).toBe(`Запись trials[1]: поле stimulusJson ${broken}`);
    expect(set('sessions', 0, 'id', 's\udc00')).toBe(`Запись sessions[0]: поле id ${broken}`);
    expect(set('blocks', 0, 'summaryJson', 'ok 😀 \ud83d')).toBe(`Запись blocks[0]: поле summaryJson ${broken}`);
    expect(set('blocks', 0, 'summaryJson', 'ok 😀')).toBeNull();
  });

  it('dates: ISO date-times that Home can read; wellbeing.date as YYYY-MM-DD', () => {
    const iso = 'должно быть датой и временем ISO, например 2026-10-14T09:00:00.000Z.';
    expect(errorOf(variant((b) => Object.assign(rows(b, 'sessions')[0] ?? {}, { startedAt: 'вчера' })))).toBe(`Запись sessions[0]: поле startedAt ${iso}`);
    expect(errorOf(variant((b) => Object.assign(rows(b, 'sessions')[0] ?? {}, { endedAt: 5 })))).toBe(
      'Запись sessions[0]: поле endedAt должно быть датой и временем ISO, например 2026-10-14T09:00:00.000Z, или null.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'logicItems')[0] ?? {}, { at: '2026-13-01T00:00:00Z' })))).toBe(`Запись logicItems[0]: поле at ${iso}`);
    expect(errorOf(variant((b) => Object.assign(rows(b, 'diagnostics')[0] ?? {}, { at: '' })))).toBe(`Запись diagnostics[0]: поле at ${iso}`);
    for (const date of ['2026-10-1', '2026-02-30', '2026-10-01T08:00:00.000Z']) {
      expect(errorOf(variant((b) => Object.assign(rows(b, 'wellbeing')[0] ?? {}, { date })))).toBe(
        'Запись wellbeing[0]: поле date должно быть датой в виде ГГГГ-ММ-ДД.',
      );
    }
  });

  it('W2-R29: a date Date.parse accepts but localDayNumber (the parser Home uses) rejects', () => {
    const date = '2026/10/14 09:00';
    expect(Number.isNaN(Date.parse(date))).toBe(false);
    expect(() => localDayNumber(date)).toThrow(RangeError);
    expect(errorOf(variant((b) => Object.assign(rows(b, 'blocks')[1] ?? {}, { startedAt: date })))).toBe(
      'Запись blocks[1]: поле startedAt должно быть датой и временем ISO, например 2026-10-14T09:00:00.000Z.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'sessions')[1] ?? {}, { startedAt: 'Wed, 14 Oct 2026 09:00:00 GMT' })))).toBe(
      'Запись sessions[1]: поле startedAt должно быть датой и временем ISO, например 2026-10-14T09:00:00.000Z.',
    );
  });

  it('an id repeated within a table', () => {
    expect(errorOf(variant((b) => Object.assign(rows(b, 'sessions')[1] ?? {}, { id: 's1' })))).toBe('Запись sessions[1]: id s1 повторяется.');
    expect(errorOf(variant((b) => Object.assign(rows(b, 'trials')[1] ?? {}, { id: 't1' })))).toBe('Запись trials[1]: id t1 повторяется.');
  });

  it('a row that names a session or block not in the file', () => {
    expect(errorOf(variant((b) => rows(b, 'trials').push({ ...trial('t3', 'b9', 0) })))).toBe('Запись trials[2]: блок b9 не найден в файле.');
    expect(errorOf(variant((b) => Object.assign(rows(b, 'logicItems')[0] ?? {}, { blockId: 'b9' })))).toBe(
      'Запись logicItems[0]: блок b9 не найден в файле.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'blocks')[1] ?? {}, { sessionId: 's9' })))).toBe(
      'Запись blocks[1]: сессия s9 не найдена в файле.',
    );
    expect(errorOf(variant((b) => Object.assign(rows(b, 'diagnostics')[0] ?? {}, { sessionId: 's9' })))).toBe(
      'Запись diagnostics[0]: сессия s9 не найдена в файле.',
    );
  });

  it('reports the first error in file order', () => {
    const text = variant((b) => {
      Object.assign(rows(b, 'wellbeing')[0] ?? {}, { mood: 9 });
      Object.assign(rows(b, 'blocks')[1] ?? {}, { score: 'x' });
      Object.assign(rows(b, 'blocks')[0] ?? {}, { module: 'tetris' });
    });
    expect(errorOf(text)).toMatch(/^Запись blocks\[0\]: поле module/);
  });
});
