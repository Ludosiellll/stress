import type { ModuleId } from './types';

/** Level at which a module counts as "at norm" (planner priority, R1). numseries has no level. */
export const L_NORM: Record<ModuleId, number> = { pzmr: 14, szmr: 12, gonogo: 10, rdo: 10, gorbov: 12, schulte: 6, numseries: 0 };
