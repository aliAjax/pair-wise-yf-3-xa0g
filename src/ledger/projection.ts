import type {
  BaselineView,
  CalibrationDerivation,
  ConflictInfo,
  LedgerEvent,
  MemoryAmendedEvent,
  MemoryView,
  ObservationRecordedEvent,
  Projection,
} from './types';

export const CLAMP_MIN = 1;
export const CLAMP_MAX = 10;

/** 校准因子四舍五入到 4 位，避免投影漂移 */
export function calibrationFactor(standardReading: number, observedReading: number): number {
  if (!(observedReading > 0)) return 1;
  return Math.round((standardReading / observedReading) * 10000) / 10000;
}

export function clampIntensity(v: number): number {
  return Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, Math.round(v * 10) / 10));
}

/**
 * 按「档案员 + 采样时刻」挑选唯一生效基线：
 * 区间 [validFrom, validTo)，validTo=null 为开放区间；必须未被撤回。
 * 多个区间命中时取 validFrom 最晚的一条。
 */
export function baselineAt(
  baselines: BaselineView[],
  archivist: string,
  sampledAt: string,
): BaselineView | null {
  const hits = baselines.filter(
    (b) =>
      b.archivist === archivist &&
      b.status === 'active' &&
      b.validFrom <= sampledAt &&
      (b.validTo === null || sampledAt < b.validTo),
  );
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => (a.validFrom > b.validFrom ? a : b));
}

function deriveCalibration(
  baselines: BaselineView[],
  archivist: string,
  sampledAt: string,
  rawIntensity: number,
  baselineWithdrawn: boolean,
): CalibrationDerivation {
  const active = baselineAt(baselines, archivist, sampledAt);
  if (active) {
    return {
      status: 'calibrated',
      calibratedIntensity: clampIntensity(rawIntensity * active.factor),
      factor: active.factor,
      baselineId: active.id,
    };
  }
  if (baselineWithdrawn) {
    return { status: 'invalidated', calibratedIntensity: null, factor: null, baselineId: null };
  }
  return { status: 'uncalibrated', calibratedIntensity: null, factor: null, baselineId: null };
}

interface Accumulator {
  observations: ObservationRecordedEvent[];
  amendments: Record<string, MemoryAmendedEvent[]>;
  discarded: Set<string>;
  baselines: BaselineView[];
  /** memoryId -> 冲突记录（按入账顺序） */
  conflicts: Map<string, ConflictInfo[]>;
  /** sniffKey -> 先到的观测事件（只留一份原始读数） */
  winnerBySniffKey: Map<string, ObservationRecordedEvent>;
}

/**
 * 从事件流完整重算投影。纯函数：同样的事件流必然得到同样的投影，
 * 因此基线迟到/撤回、迁移补录后，卡片、筛选、排行总能一致地重算。
 */
export function replay(events: LedgerEvent[]): Projection {
  const acc: Accumulator = {
    observations: [],
    amendments: {},
    discarded: new Set(),
    baselines: [],
    conflicts: new Map(),
    winnerBySniffKey: new Map(),
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'observation.recorded': {
        // 去重只发生在命令层；投影只认已经入账的观测。
        acc.observations.push(ev);
        if (!acc.winnerBySniffKey.has(ev.sniffKey)) {
          acc.winnerBySniffKey.set(ev.sniffKey, ev);
        }
        break;
      }
      case 'observation.conflict_reported': {
        const winner = acc.winnerBySniffKey.get(ev.sniffKey);
        if (winner) {
          const list = acc.conflicts.get(winner.memoryId) ?? [];
          list.push({
            archivist: ev.lateArchivist,
            at: ev.at,
            eventId: ev.eventId,
            claimedIntensity: ev.claimedIntensity,
          });
          acc.conflicts.set(winner.memoryId, list);
        }
        break;
      }
      case 'memory.amended': {
        (acc.amendments[ev.memoryId] ??= []).push(ev);
        break;
      }
      case 'memory.discarded': {
        acc.discarded.add(ev.memoryId);
        break;
      }
      case 'calibration.registered': {
        const factor = calibrationFactor(ev.standardReading, ev.observedReading);
        const baseline: BaselineView = {
          id: ev.baselineId,
          archivist: ev.archivist,
          standardReading: ev.standardReading,
          observedReading: ev.observedReading,
          factor,
          validFrom: ev.validFrom,
          validTo: null,
          status: 'active',
          registeredAt: ev.at,
        };
        if (ev.closesBaselineId) {
          const prev = acc.baselines.find((b) => b.id === ev.closesBaselineId);
          if (prev && prev.validTo === null) prev.validTo = ev.validFrom;
        }
        acc.baselines.push(baseline);
        break;
      }
      case 'calibration.withdrawn': {
        const b = acc.baselines.find((x) => x.id === ev.baselineId);
        if (b) {
          b.status = 'withdrawn';
          b.withdrawnAt = ev.at;
          b.withdrawReason = ev.reason;
        }
        break;
      }
      default: {
        // 损坏/未知事件：让重算显式失败，由命令层整体回滚，绝不静默丢弃
        const kind = (ev as { type?: string })?.type ?? typeof ev;
        throw new Error(`无法重放未知事件：${kind}`);
      }
    }
  }

  const memories: MemoryView[] = acc.observations.map((obs) => {
    const patch: Record<string, unknown> = {};
    let sampledAt = obs.sampledAt;
    let updatedAt = obs.at;
    for (const am of acc.amendments[obs.memoryId] ?? []) {
      Object.assign(patch, am.patch);
      if (am.patch.sampledAt) sampledAt = am.patch.sampledAt;
      updatedAt = am.at;
    }

    // 该档案员在该采样时刻是否曾经有基线、但它后来被撤回
    const everCovered = acc.baselines.some(
      (b) =>
        b.archivist === obs.archivist &&
        b.validFrom <= sampledAt &&
        (b.validTo === null || sampledAt < b.validTo),
    );
    const calibration = deriveCalibration(
      acc.baselines,
      obs.archivist,
      sampledAt,
      obs.rawIntensity,
      everCovered,
    );

    const narrative = {
      location: (patch.location as string) ?? obs.location,
      source_guess: (patch.source_guess as string) ?? obs.source_guess,
      humidity: (patch.humidity as number) ?? obs.humidity,
      season: (patch.season as MemoryView['season']) ?? obs.season,
      smell_type: (patch.smell_type as MemoryView['smell_type']) ?? obs.smell_type,
      memory_text: (patch.memory_text as string) ?? obs.memory_text,
      color_association: (patch.color_association as string) ?? obs.color_association,
      emotion: (patch.emotion as MemoryView['emotion']) ?? obs.emotion,
      want_again: (patch.want_again as boolean) ?? obs.want_again,
    };

    return {
      id: obs.memoryId,
      observationId: obs.observationId,
      sniffKey: obs.sniffKey,
      archivist: obs.archivist,
      sampledAt,
      recordedAt: obs.at,
      updatedAt,
      rawIntensity: obs.rawIntensity,
      discarded: acc.discarded.has(obs.memoryId),
      source: obs.source,
      conflicts: acc.conflicts.get(obs.memoryId) ?? [],
      calibration,
      intensity:
        calibration.status === 'calibrated'
          ? (calibration.calibratedIntensity as number)
          : obs.rawIntensity,
      intensityBasis:
        calibration.status === 'calibrated'
          ? 'calibrated'
          : calibration.status === 'invalidated'
            ? 'raw-invalidated'
            : 'raw-uncalibrated',
      ...narrative,
    };
  });

  // 排行/列表默认按采样时刻倒序（同旧体验）
  memories.sort((a, b) => (a.sampledAt < b.sampledAt ? 1 : -1));

  return {
    memories,
    baselines: acc.baselines,
    observationCount: acc.observations.length,
  };
}
