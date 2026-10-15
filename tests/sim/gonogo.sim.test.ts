import { describe, expect, it } from 'vitest';
import { gonogo, type GoNoGoParams } from '../../src/modules/reaction/gonogo';

/**
 * The inhibition a Go/No-Go block demands (spec §2.5, §8.2; Справочник F8). A no-go trial is a diffusion between a
 * withhold boundary at 0 and a press boundary at a, from a start z that leans towards pressing the more the pace and
 * the rarity of no-go make pressing a habit, with a drift towards withholding that weakens the more the no-go looks
 * like the go. The press boundary is fixed (a cautious player); the chance to reach it is the chance of a press on
 * the no-go: P = (1 − e^(−2vz/s²)) / (1 − e^(−2va/s²)).
 */
const S = 0.1;
const A = 0.12;
/** z/a by the share of no-go and the ISI range of the level; the model knows the F8 combinations only. */
const START: Readonly<Record<string, number>> = {
  '0.2:500–2500': 0.55,
  '0.15:400–1800': 0.6,
  '0.15:300–1000': 0.65,
};
/** How similar the no-go is to the go: v = −0.25 · 0.8^step. */
const SIMILARITY: Readonly<Record<GoNoGoParams['noGoStimulus'], number>> = { green_circle: 0, red_square: 1, red_marked: 2 };

function commissionChance(p: GoNoGoParams): number {
  const key = `${String(p.noGoRatio)}:${String(p.isiMin)}–${String(p.isiMax)}`;
  const share = START[key];
  if (share === undefined) throw new RangeError(`no start point for no-go share and ISI ${key}`);
  const z = share * A;
  const v = -0.25 * 0.8 ** SIMILARITY[p.noGoStimulus];
  return (1 - Math.exp((-2 * v * z) / S ** 2)) / (1 - Math.exp((-2 * v * A) / S ** 2));
}

describe('Go/No-Go: the inhibition demand grows with the level (F8)', () => {
  it('P(press on no-go) does not fall with the level and is ≥ 3 points higher at L 12 than at L 0', () => {
    const p = [0, 8, 12, 16, 20].map((L) => commissionChance(gonogo.params(L)));
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThanOrEqual(p[i - 1] as number);
    expect((p[2] as number) - (p[0] as number)).toBeGreaterThanOrEqual(0.03);
  });
});
