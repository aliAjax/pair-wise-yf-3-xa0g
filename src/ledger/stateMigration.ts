import type { LegacyRecord } from './types';
import { createQueue, type MigrationQueue } from './migration';

export interface V2State {
  events: [];
  migrationQueue: MigrationQueue;
  currentArchivist: string;
}

interface V0orV1Persisted {
  memories?: Array<Partial<Record<string, unknown>>>;
}

/**
 * v0/v1 持久化（没有观测号的 SmellMemory[]）-> v2 事件账本初始状态。
 * 抽成纯函数：升级规则可独立测试，store 水合时直接调用。
 */
export function migrateLegacyState(persisted: unknown): V2State {
  const old: Array<Partial<Record<string, unknown>>> =
    (persisted as V0orV1Persisted | null)?.memories ?? [];

  const records: LegacyRecord[] = old.map((m) => ({
    legacyId: String(m.id ?? `legacy-${Math.random().toString(36).slice(2)}`),
    location: String(m.location ?? ''),
    source_guess: String(m.source_guess ?? ''),
    intensity: Number(m.intensity ?? 5),
    humidity: Number(m.humidity ?? 5),
    season: (m.season as LegacyRecord['season']) ?? 'autumn',
    smell_type: (m.smell_type as LegacyRecord['smell_type']) ?? 'other',
    memory_text: String(m.memory_text ?? ''),
    color_association: String(m.color_association ?? '#8B5A2B'),
    emotion: (m.emotion as LegacyRecord['emotion']) ?? 'nostalgic',
    want_again: Boolean(m.want_again),
    createdAt: String(m.created_at ?? new Date().toISOString()),
    archivist: '旧档迁移',
  }));

  return { events: [], migrationQueue: createQueue(records), currentArchivist: '林档案员' };
}
