import type { Season, SmellType, Emotion } from '../utils/constants';

/**
 * 可追溯嗅觉账 —— 领域类型
 *
 * 三层结构：
 *   1. 事件流（LedgerEvent[]）：原始读数与校准事实，只追加、永不修改
 *   2. 基线（BaselineView）：按档案员划分、按采样时刻生效的校准区间
 *   3. 投影（Projection）：随时可由事件流完整重算的卡片/筛选/排行视图
 */

/** 气味记忆中可被 amend 的叙述性字段（原始读数不在其中） */
export interface MemoryNarrative {
  location: string;
  source_guess: string;
  humidity: number;
  season: Season;
  smell_type: SmellType;
  memory_text: string;
  color_association: string;
  emotion: Emotion;
  want_again: boolean;
}

/** 一次闻样录入命令携带的全部字段 */
export interface ObservationInput extends MemoryNarrative {
  /** 档案员（闻样人）标识，校准基线按人分别生效 */
  archivist: string;
  /** 同一次闻样的去重键：两位档案员保存同一批闻样时相同 */
  sniffKey: string;
  /** 采样时刻（ISO），决定哪条基线对这条读数生效 */
  sampledAt: string;
  /** 原始强度读数（1-10），只追加、永不修改 */
  rawIntensity: number;
}

/** 旧版数据：没有观测号的记忆记录 */
export interface LegacyRecord extends MemoryNarrative {
  legacyId: string;
  intensity: number;
  humidity: number;
  season: Season;
  smell_type: SmellType;
  memory_text: string;
  color_association: string;
  emotion: Emotion;
  want_again: boolean;
  createdAt: string;
  archivist: string;
}

// ---------------------------------------------------------------------------
// 事件（事实层，append-only）
// ---------------------------------------------------------------------------

interface EventBase {
  /** 事件号，全局唯一、只追加 */
  eventId: string;
  /** 事件入账时刻（ISO） */
  at: string;
}

export interface ObservationRecordedEvent extends EventBase, ObservationInput {
  type: 'observation.recorded';
  /** 观测号，按入账顺序生成，如 OBS-000007 */
  observationId: string;
  /** 记忆卡片 id（一条记忆对应一次观测） */
  memoryId: string;
  /** direct=档案员直接录入；legacy=旧数据迁移 */
  source: 'direct' | 'legacy';
}

export interface ObservationConflictEvent extends EventBase {
  type: 'observation.conflict_reported';
  /** 同一次闻样的去重键 */
  sniffKey: string;
  /** 先到者（唯一原始读数）的观测号 */
  winnerObservationId: string;
  /** 先到者录入事件号 —— 冲突来源凭证 */
  winnerEventId: string;
  winnerArchivist: string;
  /** 后到的档案员 */
  lateArchivist: string;
  /** 后到者声称的读数（仅作记录，不会成为第二份原始读数） */
  claimedIntensity: number;
}

export interface MemoryAmendedEvent extends EventBase {
  type: 'memory.amended';
  memoryId: string;
  archivist: string;
  patch: Partial<MemoryNarrative> & { sampledAt?: string };
}

export interface MemoryDiscardedEvent extends EventBase {
  type: 'memory.discarded';
  memoryId: string;
  archivist: string;
  reason?: string;
}

export interface CalibrationRegisteredEvent extends EventBase {
  type: 'calibration.registered';
  baselineId: string;
  archivist: string;
  /** 标准样真值 */
  standardReading: number;
  /** 档案员对标准样的读数（嗅觉变钝时偏小） */
  observedReading: number;
  /** 该基线开始生效的采样时刻 */
  validFrom: string;
  /** 注册时被自动截断的、原本开放的基线 id */
  closesBaselineId?: string;
}

export interface CalibrationWithdrawnEvent extends EventBase {
  type: 'calibration.withdrawn';
  baselineId: string;
  reason: string;
}

export type LedgerEvent =
  | ObservationRecordedEvent
  | ObservationConflictEvent
  | MemoryAmendedEvent
  | MemoryDiscardedEvent
  | CalibrationRegisteredEvent
  | CalibrationWithdrawnEvent;

// ---------------------------------------------------------------------------
// 投影（派生层，随时可从事件流完整重算）
// ---------------------------------------------------------------------------

export type CalibrationStatus = 'calibrated' | 'uncalibrated' | 'invalidated';

export interface CalibrationDerivation {
  status: CalibrationStatus;
  /** 校准后强度；未校准/已失效时为 null */
  calibratedIntensity: number | null;
  /** 生效因子 = 标准真值 / 档案员读数 */
  factor: number | null;
  /** 生效基线 id（来源凭证） */
  baselineId: string | null;
}

export interface ConflictInfo {
  archivist: string;
  at: string;
  eventId: string;
  claimedIntensity: number;
}

export type IntensityBasis = 'calibrated' | 'raw-uncalibrated' | 'raw-invalidated';

/** 卡片、筛选、排行共同消费的记忆视图 */
export interface MemoryView extends MemoryNarrative {
  id: string;
  observationId: string;
  sniffKey: string;
  archivist: string;
  sampledAt: string;
  recordedAt: string;
  updatedAt: string;
  rawIntensity: number;
  discarded: boolean;
  source: 'direct' | 'legacy';
  calibration: CalibrationDerivation;
  /** 生效强度：优先校准值，无有效基限时回退原始读数 */
  intensity: number;
  intensityBasis: IntensityBasis;
  conflicts: ConflictInfo[];
}

export interface BaselineView {
  id: string;
  archivist: string;
  standardReading: number;
  observedReading: number;
  factor: number;
  validFrom: string;
  /** null = 开放区间，至今有效 */
  validTo: string | null;
  status: 'active' | 'withdrawn';
  registeredAt: string;
  withdrawnAt?: string;
  withdrawReason?: string;
}

export interface Projection {
  memories: MemoryView[];
  baselines: BaselineView[];
  observationCount: number;
}

/** 冲突回执：后到的档案员看到的冲突与来源 */
export interface ConflictReceipt {
  kind: 'conflict';
  sniffKey: string;
  winnerObservationId: string;
  winnerEventId: string;
  winnerArchivist: string;
  winnerRecordedAt: string;
  winnerRawIntensity: number;
}

export type CommandResult<T = void> =
  | (T & { ok: true; error?: never })
  | { ok: false; error: string };

export type RecordResult =
  | { ok: true; error?: undefined; kind?: undefined; memoryId: string; observationId: string }
  | { ok: false; error: string; kind: 'conflict'; conflict: ConflictReceipt }
  | { ok: false; error: string; kind?: undefined };

/** 命令依赖：时钟与 id 生成器（测试时可注入固定值） */
export interface CommandDeps {
  now: () => string;
  eventId: () => string;
  memoryId: () => string;
}
