import type { LedgerEvent, LegacyRecord, ObservationInput, Projection } from './types';
export * from './types';
export {
  replay,
  baselineAt,
  calibrationFactor,
  clampIntensity,
  CLAMP_MIN,
  CLAMP_MAX,
} from './projection';
export {
  recordObservation,
  amendMemory,
  discardMemory,
  registerCalibration,
  withdrawCalibration,
  migrateLegacyRecord,
  makeSniffKey,
  commitEvents,
  defaultDeps,
} from './commands';
export type { CommandDeps, ConflictReceipt } from './types';
export {
  createQueue,
  tickMigration,
  runMigration,
  queueProgress,
} from './migration';
export type { MigrationQueue, MigrationJob } from './migration';
export { migrateLegacyState } from './stateMigration';

/** 视图便捷选择器：卡片/筛选/排行统一从投影取「未废弃」记忆 */
export function liveMemories(p: Projection) {
  return p.memories.filter((m) => !m.discarded);
}

export type { LedgerEvent, LegacyRecord, ObservationInput };
