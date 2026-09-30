import type { LegacyRecord } from '../ledger/types';
import { mockMemories } from './mockData';

/**
 * 旧版数据没有观测号 —— 作为「待迁移旧档」进入迁移队列，
 * 由账本逐条迁移为单次观测（sniffKey 直接取旧 id，天然幂等、中断可续）。
 */
export const legacySeed: LegacyRecord[] = mockMemories.map((m) => ({
  legacyId: m.id,
  location: m.location,
  source_guess: m.source_guess,
  intensity: m.intensity,
  humidity: m.humidity,
  season: m.season,
  smell_type: m.smell_type,
  memory_text: m.memory_text,
  color_association: m.color_association,
  emotion: m.emotion,
  want_again: m.want_again,
  createdAt: m.created_at,
  archivist: '旧档迁移',
}));
