import type {
  CalibrationRegisteredEvent,
  CommandDeps,
  CommandResult,
  ConflictReceipt,
  LedgerEvent,
  LegacyRecord,
  MemoryNarrative,
  ObservationInput,
  ObservationRecordedEvent,
  Projection,
  RecordResult,
} from './types';
import { replay } from './projection';

export const defaultDeps: CommandDeps = {
  now: () => new Date().toISOString(),
  eventId: () => `EVT-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
  memoryId: () => `MEM-${Math.random().toString(36).slice(2, 10)}`,
};

export const SNIFF_KEY_PREFIX = 'SNIFF';

/** 闻样批次号：同一地点、同一采样时刻视为同一次闻样（与档案员无关），
 * 两位档案员同时保存据此去重 */
export function makeSniffKey(sampledAt: string, location: string): string {
  const sig = `${sampledAt}|${location.trim()}`;
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = (h * 31 + sig.charCodeAt(i)) | 0;
  }
  return `${SNIFF_KEY_PREFIX}-${(h >>> 0).toString(36).padStart(7, '0')}`;
}

function nextObservationNo(projection: Projection): number {
  return projection.observationCount + 1;
}

function findWinner(projection: Projection, sniffKey: string) {
  return projection.memories.find((m) => m.sniffKey === sniffKey) ?? null;
}

function validateObservationInput(input: ObservationInput): string | null {
  if (!input.archivist?.trim()) return '缺少档案员标识';
  if (!input.sniffKey?.trim()) return '缺少闻样批次号';
  if (!input.sampledAt) return '缺少采样时刻';
  if (!Number.isFinite(input.rawIntensity) || input.rawIntensity < 1 || input.rawIntensity > 10) {
    return '原始强度必须在 1–10 之间';
  }
  if (!input.location?.trim()) return '缺少地点';
  return null;
}

/**
 * 原子提交：先基于「现有事件 + 候选事件」完整重算投影，
 * 成功才把候选事件落入事件流；重算/校验失败则原样返回，账上不留半成品。
 */
export function commitEvents(events: LedgerEvent[], candidates: LedgerEvent[]): CommandResult<{ events: LedgerEvent[]; projection: Projection }> {
  try {
    const next = [...events, ...candidates];
    const projection = replay(next); // 重算失败 -> catch，事件流保持不变
    return { ok: true, events: next, projection };
  } catch (err) {
    return { ok: false, error: `重算失败，已整体回滚：${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// 闻样录入（原始读数只追加；并发保存只留一份原始读数）
// ---------------------------------------------------------------------------

export function recordObservation(
  events: LedgerEvent[],
  input: ObservationInput,
  deps: CommandDeps = defaultDeps,
): { result: RecordResult; events: LedgerEvent[]; projection: Projection } {
  const base = replay(events);
  const invalid = validateObservationInput(input);
  if (invalid) {
    return { result: { ok: false, error: invalid }, events, projection: base };
  }

  const winner = findWinner(base, input.sniffKey);
  if (winner) {
    // 后到者：不再产生第二份原始读数，只追加一条冲突审计事件，冲突与来源挂在先到者卡片上
    const conflictEvent: LedgerEvent = {
      type: 'observation.conflict_reported',
      eventId: deps.eventId(),
      at: deps.now(),
      sniffKey: input.sniffKey,
      winnerObservationId: winner.observationId,
      winnerEventId: events.find(
        (e) => e.type === 'observation.recorded' && (e as ObservationRecordedEvent).memoryId === winner.id,
      )!.eventId,
      winnerArchivist: winner.archivist,
      lateArchivist: input.archivist,
      claimedIntensity: input.rawIntensity,
    };
    const committed = commitEvents(events, [conflictEvent]);
    if (!committed.ok) {
      return { result: { ok: false, error: committed.error }, events, projection: base };
    }
    const receipt: ConflictReceipt = {
      kind: 'conflict',
      sniffKey: input.sniffKey,
      winnerObservationId: winner.observationId,
      winnerEventId: conflictEvent.winnerEventId,
      winnerArchivist: winner.archivist,
      winnerRecordedAt: winner.recordedAt,
      winnerRawIntensity: winner.rawIntensity,
    };
    return {
      result: { ok: false, error: '同一次闻样已存在原始读数', kind: 'conflict', conflict: receipt },
      events: committed.events,
      projection: committed.projection,
    };
  }

  const no = nextObservationNo(base);
  const observed: ObservationRecordedEvent = {
    type: 'observation.recorded',
    eventId: deps.eventId(),
    at: deps.now(),
    observationId: `OBS-${String(no).padStart(6, '0')}`,
    memoryId: deps.memoryId(),
    source: 'direct',
    ...input,
  };
  const committed = commitEvents(events, [observed]);
  if (!committed.ok) {
    return { result: { ok: false, error: committed.error }, events, projection: base };
  }
  return {
    result: { ok: true, memoryId: observed.memoryId, observationId: observed.observationId },
    events: committed.events,
    projection: committed.projection,
  };
}

// ---------------------------------------------------------------------------
// 记忆叙述修订 / 废弃（原始读数不可改；删除是墓碑）
// ---------------------------------------------------------------------------

export function amendMemory(
  events: LedgerEvent[],
  memoryId: string,
  archivist: string,
  patch: Partial<MemoryNarrative> & { sampledAt?: string },
  deps: CommandDeps = defaultDeps,
): CommandResult<{ events: LedgerEvent[]; projection: Projection }> {
  const base = replay(events);
  const target = base.memories.find((m) => m.id === memoryId);
  if (!target) return { ok: false, error: `记忆 ${memoryId} 不存在` };
  if (target.discarded) return { ok: false, error: '已废弃的记忆不能修改' };
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return { ok: false, error: '没有需要修订的字段' };
  const ev: LedgerEvent = {
    type: 'memory.amended',
    eventId: deps.eventId(),
    at: deps.now(),
    memoryId,
    archivist,
    patch: Object.fromEntries(entries),
  };
  return commitEvents(events, [ev]);
}

export function discardMemory(
  events: LedgerEvent[],
  memoryId: string,
  archivist: string,
  reason: string | undefined,
  deps: CommandDeps = defaultDeps,
): CommandResult<{ events: LedgerEvent[]; projection: Projection }> {
  const base = replay(events);
  const target = base.memories.find((m) => m.id === memoryId);
  if (!target) return { ok: false, error: `记忆 ${memoryId} 不存在` };
  if (target.discarded) return { ok: false, error: '该记忆已处于废弃状态' };
  return commitEvents(events, [
    {
      type: 'memory.discarded',
      eventId: deps.eventId(),
      at: deps.now(),
      memoryId,
      archivist,
      reason,
    },
  ]);
}

// ---------------------------------------------------------------------------
// 校准基线：有效区间按采样时刻确定；迟到/撤回都会让受影响观测重算
// ---------------------------------------------------------------------------

export function registerCalibration(
  events: LedgerEvent[],
  args: {
    archivist: string;
    standardReading: number;
    observedReading: number;
    validFrom: string;
  },
  deps: CommandDeps = defaultDeps,
): CommandResult<{ events: LedgerEvent[]; projection: Projection; baselineId: string; affectedMemoryIds: string[] }> {
  const { archivist, standardReading, observedReading, validFrom } = args;
  if (!archivist?.trim()) return { ok: false, error: '缺少档案员标识' };
  if (!validFrom) return { ok: false, error: '缺少生效起始时刻' };
  if (!(standardReading > 0) || !(observedReading > 0)) {
    return { ok: false, error: '标准样真值与档案员读数必须为正数' };
  }
  const base = replay(events);
  const active = base.baselines.filter((b) => b.archivist === archivist && b.status === 'active');

  // 不变量：同一档案员的任一采样时刻至多有一条生效基线。
  // 新区间是 [T, ∞)：
  //   - 若存在开放区间 [S, ∞)，只允许 T > S（新基线把旧区间截断为 [S,T)）
  //   - T <= S 会重叠，拒绝（更早生效的校准只能先撤回当前开放基线）
  //   - 与任何闭合区间 [from,to) 相交（to > T）也拒绝
  const opens = active.filter((b) => b.validTo === null);
  if (opens.length > 1) {
    return { ok: false, error: '已存在多条开放基线，数据异常，请先整理基线' };
  }
  const open = opens[0];
  if (open && validFrom <= open.validFrom) {
    return {
      ok: false,
      error: `与开放基线 ${open.id}（${open.validFrom} 起至今）重叠；更早生效的校准请先撤回当前基线再补录`,
    };
  }
  for (const b of active) {
    if (b === open) continue;
    // 闭合区间 [from, validTo) 与 [validFrom, ∞) 相交当且仅当 validTo > validFrom
    if (b.validTo !== null && b.validTo > validFrom) {
      return {
        ok: false,
        error: `与既有基线 ${b.id} 的有效区间 [${b.validFrom}, ${b.validTo}) 重叠，请先撤回旧基线`,
      };
    }
  }

  const baselineId = `CAL-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
  const ev: CalibrationRegisteredEvent = {
    type: 'calibration.registered',
    eventId: deps.eventId(),
    at: deps.now(),
    baselineId,
    archivist,
    standardReading,
    observedReading,
    validFrom,
    closesBaselineId: open?.id,
  };
  const committed = commitEvents(events, [ev]);
  if (!committed.ok) return { ok: false, error: committed.error };

  // 报告受影响观测：该档案员、采样时刻 >= validFrom 的记忆（卡片/排行随后统一重算）
  const affectedMemoryIds = committed.projection.memories
    .filter((m) => m.archivist === archivist && m.sampledAt >= validFrom)
    .map((m) => m.id);

  return { ok: true, events: committed.events, projection: committed.projection, baselineId, affectedMemoryIds };
}

export function withdrawCalibration(
  events: LedgerEvent[],
  baselineId: string,
  reason: string,
  deps: CommandDeps = defaultDeps,
): CommandResult<{ events: LedgerEvent[]; projection: Projection; affectedMemoryIds: string[] }> {
  if (!reason?.trim()) return { ok: false, error: '撤回基线必须填写原因' };
  const base = replay(events);
  const b = base.baselines.find((x) => x.id === baselineId);
  if (!b) return { ok: false, error: `基线 ${baselineId} 不存在` };
  if (b.status === 'withdrawn') return { ok: false, error: '该基线已经撤回' };

  const committed = commitEvents(events, [
    {
      type: 'calibration.withdrawn',
      eventId: deps.eventId(),
      at: deps.now(),
      baselineId,
      reason,
    },
  ]);
  if (!committed.ok) return { ok: false, error: committed.error };

  // 撤回后，落在该区间内的观测校准结论失效
  const affectedMemoryIds = committed.projection.memories
    .filter(
      (m) =>
        m.archivist === b.archivist &&
        m.sampledAt >= b.validFrom &&
        (b.validTo === null || m.sampledAt < b.validTo),
    )
    .map((m) => m.id);

  return { ok: true, events: committed.events, projection: committed.projection, affectedMemoryIds };
}

// ---------------------------------------------------------------------------
// 旧数据迁移：无观测号 -> 单次观测；逐条提交，中断可继续；按 sniffKey 幂等
// ---------------------------------------------------------------------------

export function migrateLegacyRecord(
  events: LedgerEvent[],
  record: LegacyRecord,
  deps: CommandDeps = defaultDeps,
): { result: { ok: boolean; migrated: boolean; observationId?: string; error?: string }; events: LedgerEvent[]; projection: Projection } {
  const base = replay(events);

  // 幂等：同一 legacyId 已迁移，或同一闻样批次已存在原始读数 -> 跳过
  const already = base.memories.find((m) => m.sniffKey === record.legacyId);
  if (already) {
    return {
      result: { ok: true, migrated: false, observationId: already.observationId },
      events,
      projection: base,
    };
  }

  if (!(record.intensity >= 1 && record.intensity <= 10)) {
    return { result: { ok: false, migrated: false, error: `${record.legacyId} 强度越界` }, events, projection: base };
  }

  const no = nextObservationNo(base);
  const ev: ObservationRecordedEvent = {
    type: 'observation.recorded',
    eventId: deps.eventId(),
    at: deps.now(),
    observationId: `OBS-${String(no).padStart(6, '0')}`,
    memoryId: deps.memoryId(),
    source: 'legacy',
    archivist: record.archivist,
    sniffKey: record.legacyId, // 迁移记录的批次号即旧 id，天然幂等
    sampledAt: record.createdAt,
    rawIntensity: record.intensity,
    location: record.location,
    source_guess: record.source_guess,
    humidity: record.humidity,
    season: record.season,
    smell_type: record.smell_type,
    memory_text: record.memory_text,
    color_association: record.color_association,
    emotion: record.emotion,
    want_again: record.want_again,
  };

  // 单条原子提交：失败时这条不留任何痕迹，队列可稍后重试
  const committed = commitEvents(events, [ev]);
  if (!committed.ok) {
    return { result: { ok: false, migrated: false, error: committed.error }, events, projection: base };
  }
  return {
    result: { ok: true, migrated: true, observationId: ev.observationId },
    events: committed.events,
    projection: committed.projection,
  };
}
