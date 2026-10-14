import type { ModuleId, ReactionModuleId } from '../engine/types';
import type { ReactionModule } from './reaction/common';
import { gonogo } from './reaction/gonogo';
import { pomeh } from './reaction/pomeh';
import { pzmr } from './reaction/pzmr';
import { rdo } from './reaction/rdo';
import { stroop } from './reaction/stroop';
import { szmr } from './reaction/szmr';
import { taskswitch } from './reaction/taskswitch';

export { L_NORM as lNorm } from '../engine/planner';
export type { ReactionModule } from './reaction/common';

export const reactionModules: Record<ReactionModuleId, ReactionModule<unknown>> = {
  pzmr,
  szmr,
  gonogo,
  rdo,
  stroop,
  taskswitch,
  pomeh,
};

export const moduleTitles: Record<ModuleId, string> = {
  pzmr: pzmr.title,
  szmr: szmr.title,
  gonogo: gonogo.title,
  rdo: rdo.title,
  gorbov: 'Красно-чёрные таблицы Горбова',
  schulte: 'Таблицы Шульте',
  stroop: stroop.title,
  taskswitch: taskswitch.title,
  pomeh: pomeh.title,
  memory: 'Память',
  numseries: 'Числовые ряды',
};
