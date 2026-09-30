/**
 * 嗅觉台账 · 纯函数核心
 *
 * 不变量：
 *   1. 观测事件只追加——永不就地改写或删除读数。
 *   2. 物化视图（memories / calibrations）是账本的纯函数折叠，可随时重算。
 *   3. 重算失败抛 RecomputeError，调用方负责回滚，不留半成品。
 *   4. 校准按采样时刻 sampledAt 命中 [validFrom, validTo) 区间来决定是否修正。
 */
import type {
  AppendResult,
  Calibration,
  CalibrationEvent,
  DerivedState,
  LedgerEvent,
  MigrationCheckpoint,
  ObservationEvent,
  SessionEvent,
  SessionFields,
  SmellMemory,
} from './types';
import { RecomputeError } from './types';

const clamp = (n: number, lo = 1, hi = 10): number => {
  if (Number.isNaN(n)) throw new RecomputeError('读数不是数字');
  return Math.min(hi, Math.max(lo, n));
};

const isInt = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 10;

export function nextSeq(events: LedgerEvent[]): number {
  let max = 0;
  for (const e of events) if (e.seq > max) max = e.seq;
  return max + 1;
}

export function newEventId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* 事件构造（只构造，不改写既有事件）                                  */
/* ------------------------------------------------------------------ */

export function makeSessionCreated(
  sessionId: string,
  fields: SessionFields,
  occurredAt: string,
  seq: number,
): SessionEvent {
  return {
    seq,
    kind: 'session.created',
    eventId: newEventId('sess'),
    sessionId,
    fields: { ...fields },
    occurredAt,
  };
}

export function makeSessionUpdated(
  sessionId: string,
  fields: Partial<SessionFields>,
  occurredAt: string,
  seq: number,
): SessionEvent {
  return {
    seq,
    kind: 'session.updated',
    eventId: newEventId('sess'),
    sessionId,
    fields: { ...fields },
    occurredAt,
  };
}

export function makeSessionDeleted(sessionId: string, occurredAt: string, seq: number): SessionEvent {
  return {
    seq,
    kind: 'session.deleted',
    eventId: newEventId('sess'),
    sessionId,
    occurredAt,
  };
}

export function makeObservation(input: {
  sessionId: string;
  sampledAt: string;
  intensity: number;
  humidity: number;
  observer: string;
  savedAt: string;
  status: 'saved' | 'conflict';
  baseSeq?: number;
  seq: number;
}): ObservationEvent {
  if (!isInt(input.intensity) || !isInt(input.humidity)) {
    throw new RecomputeError('原始读数必须是 1-10 的整数');
  }
  return {
    seq: input.seq,
    kind: 'observation.recorded',
    eventId: newEventId('obs'),
    sessionId: input.sessionId,
    sampledAt: input.sampledAt,
    intensity: input.intensity,
    humidity: input.humidity,
    observer: input.observer,
    savedAt: input.savedAt,
    status: input.status,
    ...(input.baseSeq !== undefined ? { baseSeq: input.baseSeq } : {}),
  };
}

export function makeCalibrationRecorded(input: {
  calibrationId: string;
  version: number;
  validFrom: string | null;
  validTo: string | null;
  intensityOffset: number;
  humidityOffset: number;
  reason?: string;
  recordedAt: string;
  seq: number;
}): CalibrationEvent {
  if (!Number.isFinite(input.intensityOffset) || !Number.isFinite(input.humidityOffset)) {
    throw new RecomputeError('校准偏移必须是有限数字');
  }
  return {
    seq: input.seq,
    kind: 'calibration.recorded',
    eventId: newEventId('cal'),
    calibrationId: input.calibrationId,
    version: input.version,
    validFrom: input.validFrom,
    validTo: input.validTo,
    intensityOffset: input.intensityOffset,
    humidityOffset: input.humidityOffset,
    ...(input.reason ? { reason: input.reason } : {}),
    recordedAt: input.recordedAt,
  };
}

export function makeCalibrationWithdrawn(
  calibrationId: string,
  withdrawnAt: string,
  seq: number,
): CalibrationEvent {
  return {
    seq,
    kind: 'calibration.withdrawn',
    eventId: newEventId('cal'),
    calibrationId,
    version: -1,
    validFrom: null,
    validTo: null,
    intensityOffset: 0,
    humidityOffset: 0,
    recordedAt: withdrawnAt,
    withdrawnAt,
  };
}

/* ------------------------------------------------------------------ */
/* 追加观测（乐观并发：baseSeq 对不上 → 冲突）                         */
/* ------------------------------------------------------------------ */

/**
 * 向台账追加一次原始读数。
 * - 无冲突：新读数成为该次闻样的标准读数（canonical），旧标准读数自然折叠为 superseded。
 * - 冲突（baseSeq 与当前标准读数的 seq 不一致）：本次追加仍记入账本（status=conflict，
 *   可追溯），但标准读数不变；返回胜出者及其来源，让后到的人看到冲突。
 *
 * 纯函数：不改写 events，返回新数组与结果。
 */
export function appendObservation(
  events: LedgerEvent[],
  input: {
    sessionId: string;
    sampledAt: string;
    intensity: number;
    humidity: number;
    observer: string;
    savedAt: string;
    baseSeq?: number;
  },
): { events: LedgerEvent[]; result: AppendResult } {
  const derived = recompute(events);
  const winner = derived.canonicalObservations.get(input.sessionId);

  if (winner && input.baseSeq !== undefined && input.baseSeq !== winner.seq) {
    // 冲突：账本照记（可追溯），但不成为标准读数。
    const conflict = makeObservation({ ...input, status: 'conflict', seq: nextSeq(events) });
    return {
      events: [...events, conflict],
      result: {
        status: 'conflict',
        event: conflict,
        winner,
        yourReading: { intensity: input.intensity, humidity: input.humidity },
      },
    };
  }

  const saved = makeObservation({ ...input, status: 'saved', seq: nextSeq(events) });
  return {
    events: [...events, saved],
    result: { status: 'saved', event: saved, canonical: saved },
  };
}

/* ------------------------------------------------------------------ */
/* 校准基线                                                            */
/* ------------------------------------------------------------------ */

/** 录入一条校准基线（可迟到：validFrom 可以早于 recordedAt）。 */
export function recordCalibration(
  events: LedgerEvent[],
  input: {
    validFrom: string | null;
    validTo: string | null;
    intensityOffset: number;
    humidityOffset: number;
    reason?: string;
    recordedAt: string;
  },
): { events: LedgerEvent[]; calibration: Calibration } {
  if (input.validFrom && input.validTo && input.validFrom > input.validTo) {
    throw new RecomputeError('校准区间起点不能晚于终点');
  }
  const calibrationId = newEventId('calib');
  const ev = makeCalibrationRecorded({
    calibrationId,
    version: 1,
    validFrom: input.validFrom,
    validTo: input.validTo,
    intensityOffset: input.intensityOffset,
    humidityOffset: input.humidityOffset,
    reason: input.reason,
    recordedAt: input.recordedAt,
    seq: nextSeq(events),
  });
  const calibration: Calibration = {
    calibrationId,
    version: 1,
    validFrom: input.validFrom,
    validTo: input.validTo,
    intensityOffset: input.intensityOffset,
    humidityOffset: input.humidityOffset,
    reason: input.reason,
    recordedAt: input.recordedAt,
    status: 'active',
  };
  return { events: [...events, ev], calibration };
}

/** 撤回一条基线：撤回后旧结论失效，相关读数回到未校准（或被其它基线修正）。 */
export function withdrawCalibration(
  events: LedgerEvent[],
  calibrationId: string,
  withdrawnAt: string,
): { events: LedgerEvent[] } {
  const exists = events.some(
    (e) => e.kind === 'calibration.recorded' && e.calibrationId === calibrationId,
  );
  if (!exists) throw new RecomputeError(`基线不存在: ${calibrationId}`);
  const alreadyWithdrawn = events.some(
    (e) => e.kind === 'calibration.withdrawn' && e.calibrationId === calibrationId,
  );
  if (alreadyWithdrawn) throw new RecomputeError('基线已撤回，不能重复撤回');
  const ev = makeCalibrationWithdrawn(calibrationId, withdrawnAt, nextSeq(events));
  return { events: [...events, ev] };
}

/* ------------------------------------------------------------------ */
/* 会话（记忆）                                                        */
/* ------------------------------------------------------------------ */

export function createSession(
  events: LedgerEvent[],
  sessionId: string,
  fields: SessionFields,
  occurredAt: string,
): LedgerEvent[] {
  return [...events, makeSessionCreated(sessionId, fields, occurredAt, nextSeq(events))];
}

export function updateSession(
  events: LedgerEvent[],
  sessionId: string,
  fields: Partial<SessionFields>,
  occurredAt: string,
): LedgerEvent[] {
  return [...events, makeSessionUpdated(sessionId, fields, occurredAt, nextSeq(events))];
}

export function deleteSession(events: LedgerEvent[], sessionId: string, occurredAt: string): LedgerEvent[] {
  return [...events, makeSessionDeleted(sessionId, occurredAt, nextSeq(events))];
}

/* ------------------------------------------------------------------ */
/* 折叠：账本 → 物化视图（纯函数）                                     */
/* ------------------------------------------------------------------ */

/** 校验账本事件的基本形状；任何损坏都抛 RecomputeError，触发回滚。 */
function validateEvents(events: LedgerEvent[]): void {
  for (const e of events) {
    if (typeof e.seq !== 'number' || !e.kind || typeof e.eventId !== 'string') {
      throw new RecomputeError('账本事件缺少 seq/kind/eventId');
    }
    if (e.kind === 'observation.recorded') {
      if (!isInt(e.intensity) || !isInt(e.humidity)) {
        throw new RecomputeError(`观测读数非法: intensity=${e.intensity} humidity=${e.humidity}`);
      }
      if (typeof e.sessionId !== 'string' || !e.sampledAt) {
        throw new RecomputeError('观测事件缺少 sessionId/sampledAt');
      }
    } else if (e.kind === 'calibration.recorded') {
      if (!Number.isFinite(e.intensityOffset) || !Number.isFinite(e.humidityOffset)) {
        throw new RecomputeError('校准偏移必须是有限数字');
      }
      if (e.validFrom && e.validTo && e.validFrom > e.validTo) {
        throw new RecomputeError('校准区间起点不能晚于终点');
      }
    }
  }
}

export function recompute(events: LedgerEvent[]): DerivedState {
  try {
    validateEvents(events);
    // 1. 会话字段折叠
    const sessions = new Map<string, { fields: SessionFields; deleted: boolean }>();
    for (const e of events) {
      if (e.kind === 'session.created') {
        sessions.set(e.sessionId, { fields: { ...e.fields! } as SessionFields, deleted: false });
      } else if (e.kind === 'session.updated') {
        const cur = sessions.get(e.sessionId);
        if (cur) {
          cur.fields = { ...cur.fields, ...e.fields, updated_at: e.occurredAt } as SessionFields;
        }
      } else if (e.kind === 'session.deleted') {
        const cur = sessions.get(e.sessionId);
        if (cur) cur.deleted = true;
      }
    }

    // 2. 标准观测读数：每次闻样取最后一条 status= saved 的记录
    const canonicalObservations = new Map<string, ObservationEvent>();
    for (const e of events) {
      if (e.kind !== 'observation.recorded') continue;
      if (e.status === 'conflict') continue;
      const cur = canonicalObservations.get(e.sessionId);
      if (!cur || e.seq > cur.seq) canonicalObservations.set(e.sessionId, e);
    }

    // 3. 当前基线：每个 calibrationId 取最高版本，除非已撤回
    const latest = new Map<string, CalibrationEvent>();
    const withdrawn = new Set<string>();
    for (const e of events) {
      if (e.kind === 'calibration.recorded') {
        const cur = latest.get(e.calibrationId);
        if (!cur || e.version > cur.version) latest.set(e.calibrationId, e);
      } else if (e.kind === 'calibration.withdrawn') {
        withdrawn.add(e.calibrationId);
      }
    }
    const activeCalibrations: Calibration[] = [];
    for (const e of latest.values()) {
      if (withdrawn.has(e.calibrationId)) continue;
      activeCalibrations.push({
        calibrationId: e.calibrationId,
        version: e.version,
        validFrom: e.validFrom,
        validTo: e.validTo,
        intensityOffset: e.intensityOffset,
        humidityOffset: e.humidityOffset,
        reason: e.reason,
        recordedAt: e.recordedAt,
        status: 'active',
      });
    }

    // 4. 组装记忆：描述字段 + 标准读数 + 命中基线修正
    const memories: SmellMemory[] = [];
    for (const [sessionId, s] of sessions) {
      if (s.deleted) continue;
      const obs = canonicalObservations.get(sessionId);

      let intensity = 0;
      let humidity = 0;
      let rawIntensity: number | null = null;
      let rawHumidity: number | null = null;
      let calibrationId: string | null = null;
      let observationId: string | null = null;
      let observer: string | null = null;
      let sampledAt: string | null = null;

      if (obs) {
        rawIntensity = obs.intensity;
        rawHumidity = obs.humidity;
        observationId = obs.eventId;
        observer = obs.observer;
        sampledAt = obs.sampledAt;
        const cal = activeCalibrations
          .filter(
            (c) =>
              (c.validFrom === null || c.validFrom <= obs.sampledAt) &&
              (c.validTo === null || obs.sampledAt < c.validTo),
          )
          .sort((a, b) => b.version - a.version)[0];

        if (cal) {
          intensity = clamp(rawIntensity + cal.intensityOffset);
          humidity = clamp(rawHumidity + cal.humidityOffset);
          calibrationId = cal.calibrationId;
        } else {
          intensity = rawIntensity;
          humidity = rawHumidity;
        }
      }

      // 更新于：描述字段更新时刻与最近读数落账时刻取晚者
      let updatedAt = s.fields.updated_at;
      if (obs && obs.savedAt > updatedAt) updatedAt = obs.savedAt;

      memories.push({
        id: sessionId,
        ...s.fields,
        intensity,
        humidity,
        observation_id: observationId,
        calibration_id: calibrationId,
        raw_intensity: rawIntensity,
        raw_humidity: rawHumidity,
        observer,
        sampled_at: sampledAt,
        updated_at: updatedAt,
      });
    }

    memories.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { memories, canonicalObservations, activeCalibrations, sessions };
  } catch (err) {
    if (err instanceof RecomputeError) throw err;
    throw new RecomputeError(`重算失败：${(err as Error).message}`, err);
  }
}

/* ------------------------------------------------------------------ */
/* 迁移：旧数据（无观测号）→ 单次观测，可中断可继续                     */
/* ------------------------------------------------------------------ */

export interface LegacyMemoryLike extends SessionFields {
  id: string;
  intensity: number;
  humidity: number;
}

/**
 * 把旧数据迁移成「单次观测」。
 * - 幂等：用确定性 sessionId（= 旧 id）+ 台账存在性判断，已迁移的绝不重复迁移。
 * - 可继续：每次调用都只处理台账里尚不存在对应 session.created 的旧记录；
 *   中断后重跑自动跳过已迁移项。
 * 纯函数：返回追加后的事件、断点记录、本次迁移条数。
 */
export function migrateLegacy(
  events: LedgerEvent[],
  legacy: LegacyMemoryLike[],
  observer = 'legacy',
): { events: LedgerEvent[]; checkpoints: MigrationCheckpoint[]; migrated: number } {
  const existingSessions = new Set<string>();
  for (const e of events) {
    if (e.kind === 'session.created') existingSessions.add(e.sessionId);
  }

  let next = [...events];
  const checkpoints: MigrationCheckpoint[] = [];
  let migrated = 0;

  for (const legacyMem of legacy) {
    if (existingSessions.has(legacyMem.id)) continue; // 已迁移（断点续跑）
    const fields: SessionFields = {
      location: legacyMem.location,
      source_guess: legacyMem.source_guess,
      season: legacyMem.season,
      smell_type: legacyMem.smell_type,
      memory_text: legacyMem.memory_text,
      color_association: legacyMem.color_association,
      emotion: legacyMem.emotion,
      want_again: legacyMem.want_again,
      created_at: legacyMem.created_at,
      updated_at: legacyMem.updated_at,
    };
    const now = legacyMem.created_at;
    next = createSession(next, legacyMem.id, fields, now);
    const obs = makeObservation({
      sessionId: legacyMem.id,
      sampledAt: legacyMem.created_at,
      intensity: legacyMem.intensity,
      humidity: legacyMem.humidity,
      observer,
      savedAt: now,
      status: 'saved',
      seq: nextSeq(next),
    });
    next = [...next, obs];
    checkpoints.push({
      sourceId: legacyMem.id,
      sessionId: legacyMem.id,
      observationEventId: obs.eventId,
      migratedAt: now,
    });
    migrated += 1;
  }

  return { events: next, checkpoints, migrated };
}

/** 触发一次完整重算（暴露给 UI 的「重算」按钮；失败回滚由 store 负责）。 */
export function forceRecompute(events: LedgerEvent[]): DerivedState {
  return recompute(events);
}
