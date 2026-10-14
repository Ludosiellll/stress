import { describe, expect, it } from 'vitest';
import { L_NORM } from '../engine/planner';
import { isReactionModule, MODULE_IDS, REACTION_MODULE_IDS } from '../engine/types';
import { createRng } from '../engine/rng';
import { lNorm, moduleTitles, reactionModules } from './registry';
import { szmr } from './reaction/szmr';

describe('registry', () => {
  it('module titles', () => {
    expect(moduleTitles).toEqual({
      pzmr: 'ПЗМР',
      szmr: 'Сложная реакция (СЗМР)',
      gonogo: 'Go/No-Go',
      rdo: 'Реакция на движущийся объект',
      gorbov: 'Красно-чёрные таблицы Горбова',
      schulte: 'Таблицы Шульте',
      stroop: 'Струп',
      numseries: 'Числовые ряды',
    });
  });

  it('lNorm re-exports L_NORM (R1)', () => {
    expect(lNorm).toBe(L_NORM);
    expect(lNorm).toEqual({ pzmr: 14, szmr: 12, gonogo: 10, rdo: 10, gorbov: 12, schulte: 6, stroop: 10, numseries: 0 });
  });

  it('MODULE_IDS lists every module once and every module has a title and L_norm', () => {
    expect(new Set(MODULE_IDS).size).toBe(MODULE_IDS.length);
    expect(MODULE_IDS.at(-1)).toBe('numseries');
    const sorted = [...MODULE_IDS].sort();
    expect(Object.keys(moduleTitles).sort()).toEqual(sorted);
    expect(Object.keys(L_NORM).sort()).toEqual(sorted);
    for (const m of MODULE_IDS) expect(moduleTitles[m].length).toBeGreaterThan(0);
  });

  it('REACTION_MODULE_IDS are the reaction modules of the catalogue, and isReactionModule tells them apart', () => {
    expect(Object.keys(reactionModules).sort()).toEqual([...REACTION_MODULE_IDS].sort());
    expect(new Set(REACTION_MODULE_IDS).size).toBe(REACTION_MODULE_IDS.length);
    for (const m of MODULE_IDS) {
      expect(isReactionModule(m)).toBe((REACTION_MODULE_IDS as readonly string[]).includes(m));
    }
    expect(MODULE_IDS.filter(isReactionModule)).toEqual(['pzmr', 'szmr', 'gonogo', 'rdo', 'stroop']);
  });

  it.each(REACTION_MODULE_IDS)('%s: id, title, lNorm and block size are wired', (id) => {
    const m = reactionModules[id];
    expect(m.id).toBe(id);
    expect(m.title).toBe(moduleTitles[id]);
    expect(m.lNorm).toBe(L_NORM[id]);
    expect(m.blockSize).toBe({ pzmr: 15, szmr: 20, gonogo: 20, rdo: 10, stroop: 20 }[id]);
  });

  it.each(REACTION_MODULE_IDS)('%s: works through the erased interface', (id) => {
    const m = reactionModules[id];
    const p = m.params(10);
    expect(m.generateBlock(p, createRng(1), 'keyboard')).toHaveLength(m.blockSize);
    expect(m.instruction('keyboard', p).length).toBeGreaterThan(0);
    expect(m.describeParams(p).length).toBeGreaterThan(0);
  });

  it('keyCount: СЗМР nKeys, Струп nColors, the other W1 modules one key', () => {
    for (const id of ['pzmr', 'gonogo', 'rdo'] as const) {
      const m = reactionModules[id];
      expect(m.keyCount(m.params(0))).toBe(1);
      expect(m.keyCount(m.params(40))).toBe(1);
    }
    expect(reactionModules.szmr.keyCount(szmr.params(8))).toBe(2);
    expect(reactionModules.szmr.keyCount(szmr.params(32))).toBe(6);
    expect(reactionModules.stroop.keyCount(reactionModules.stroop.params(16))).toBe(4);
  });
});
