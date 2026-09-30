/**
 * 嗅觉台账 · 领域类型
 *
 * 整个系统是一本「只追加」的账：
 *   - 观测事件（observation.recorded）：档案员的原始读数，永不改写。
 *   - 校准事件（calibration.recorded / withdrawn）：基线 + 有效区间，可迟到、可撤回。
 *   - 会话事件（session.created / updated / deleted）：一段气味记忆的描述性字段。
 *
 * 「气味记忆」不是存进去的，而是把账本折叠（recompute）出来的物化视图。
 */

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type SmellType =
  | 'woody'
  | 'floral'
  | 'fruity'
  | 'earthy'
  | 'spicy'
  | 'sweet'
  | 'musty'
  | 'fresh'
  | 'burnt'
  | 'other';
export type Emotion =
  | 'warm'
  | 'nostalgic'
  | 'peaceful'
  | 'melancholy'
  | 'joyful'
  | 'uncomfortable'
  | 'surprising';

/** 一段气味记忆的描述性字段（不是读数，可编辑）。 */
export interface SessionFields {
  location: string;
  source_guess: string;
  season: Season;
  smell_type: SmellType;
  memory_text: string;
  color_association: string;
  emotion: Emotion;
  want_again: boolean;
  /** 采样/封存时刻（ISO）。校准区间按它判定。 */
  created_at: string;
  /** 最近一次更新（改描述字段或追加读数）时刻（ISO）。 */
  updated_at: string;
}

/** 原始嗅觉观测（读数）。只追加，永不改写。 */
export interface ObservationEvent {
  seq: number;
  kind: 'observation.recorded';
  eventId: string;
  /** 同一次闻样（记忆）的标识。 */
  sessionId: string;
  /** 采样时刻（ISO）——校准有效区间按它判定。 */
  sampledAt: string;
  /** 原始读数 1-10。 */
  intensity: number;
  humidity: number;
  /** 档案员（谁存的）。 */
  observer: string;
  /** 落账时刻（ISO）。 */
  savedAt: string;
  /** 本次追加的结果：saved=正常落账；conflict=与他人并发冲突，未成为标准读数。 */
  status: 'saved' | 'conflict';
  /** 乐观并发令牌：基于哪一个 seq 编辑。 */
  baseSeq?: number;
}

/** 校准基线事件（录入或撤回）。只追加。 */
export interface CalibrationEvent {
  seq: number;
  kind: 'calibration.recorded' | 'calibration.withdrawn';
  eventId: string;
  calibrationId: string;
  version: number;
  /** 有效区间（按 sampledAt）：[validFrom, validTo)，null 表示开口。 */
  validFrom: string | null;
  validTo: string | null;
  /** 加性修正量。 */
  intensityOffset: number;
  humidityOffset: number;
  reason?: string;
  /** 基线录入时刻（可能晚于 validFrom → 迟到的基线）。 */
  recordedAt: string;
  withdrawnAt?: string;
}

/** 会话（记忆）事件。 */
export interface SessionEvent {
  seq: number;
  kind: 'session.created' | 'session.updated' | 'session.deleted';
  eventId: string;
  sessionId: string;
  fields?: Partial<SessionFields>;
  occurredAt: string;
}

export type LedgerEvent = ObservationEvent | CalibrationEvent | SessionEvent;

/** 折叠出来的校准基线（当前版本）。 */
export interface Calibration {
  calibrationId: string;
  version: number;
  validFrom: string | null;
  validTo: string | null;
  intensityOffset: number;
  humidityOffset: number;
  reason?: string;
  recordedAt: string;
  status: 'active' | 'withdrawn';
}

/** 物化视图里的气味记忆：描述字段 + 经校准的读数 + 溯源信息。 */
export interface SmellMemory extends SessionFields {
  id: string;
  /** 校准后的读数（卡片/排行/筛选用的就是它）。 */
  intensity: number;
  humidity: number;
  /** 溯源：来自哪条观测、哪条基线。 */
  observation_id: string | null;
  calibration_id: string | null;
  /** 校准前的原始读数。 */
  raw_intensity: number | null;
  raw_humidity: number | null;
  observer: string | null;
  sampled_at: string | null;
  updated_at: string;
}

/** 旧数据迁移的断点记录。 */
export interface MigrationCheckpoint {
  sourceId: string;
  sessionId: string;
  observationEventId: string;
  migratedAt: string;
}

/** 折叠后的派生状态（物化视图）。 */
export interface DerivedState {
  memories: SmellMemory[];
  canonicalObservations: Map<string, ObservationEvent>;
  activeCalibrations: Calibration[];
  sessions: Map<string, { fields: SessionFields; deleted: boolean }>;
}

/** 追加观测的结果。 */
export type AppendResult =
  | { status: 'saved'; event: ObservationEvent; canonical: ObservationEvent }
  | {
      status: 'conflict';
      event: ObservationEvent;
      winner: ObservationEvent;
      yourReading: { intensity: number; humidity: number };
    };

/** 提交结果：派生视图 + 本次操作的附加信息。 */
export interface CommitOutcome<T = unknown> {
  derived: DerivedState;
  events: LedgerEvent[];
  result?: T;
}

/** 重算失败：不留下半成品。 */
export class RecomputeError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RecomputeError';
  }
}
