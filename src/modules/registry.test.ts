import { describe, expect, it } from 'vitest';
import { L_NORM } from '../engine/planner';
import type { ReactionModuleId } from '../engine/types';
import { createRng } from '../engine/rng';
import { lNorm, moduleTitles, reactionModules } from './registry';

const IDS: ReactionModuleId[] = ['pzmr', 'szmr', 'gonogo', 'rdo'];

describe('registry', () => {
  it('module titles', () => {
    expect(moduleTitles).toEqual({
      pzmr: 'ПЗМР',
      szmr: 'Сложная реакция (СЗМР)',
      gonogo: 'Go/No-Go',
      rdo: 'Реакция на движущийся объект',
      gorbov: 'Красно-чёрные таблицы Горбова',
      schulte: 'Таблицы Шульте',
      numseries: 'Числовые ряды',
    });
  });

  it('lNorm re-exports L_NORM (R1)', () => {
    expect(lNorm).toBe(L_NORM);
    expect(lNorm).toEqual({ pzmr: 14, szmr: 12, gonogo: 10, rdo: 10, gorbov: 12, schulte: 6, numseries: 0 });
  });

  it.each(IDS)('%s: id, title, lNorm and block size are wired', (id) => {
    const m = reactionModules[id];
    expect(m.id).toBe(id);
    expect(m.title).toBe(moduleTitles[id]);
    expect(m.lNorm).toBe(L_NORM[id]);
    expect(m.blockSize).toBe({ pzmr: 15, szmr: 20, gonogo: 20, rdo: 10 }[id]);
  });

  it.each(IDS)('%s: works through the erased interface', (id) => {
    const m = reactionModules[id];
    const p = m.params(10);
    expect(m.generateBlock(p, createRng(1), 'keyboard')).toHaveLength(m.blockSize);
    expect(m.instruction('keyboard', p).length).toBeGreaterThan(0);
    expect(m.describeParams(p).length).toBeGreaterThan(0);
  });
});
