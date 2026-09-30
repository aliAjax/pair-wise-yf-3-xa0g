/**
 * 气味记忆库 · 状态层
 *
 * 对外暴露的 memories 是台账折叠出来的物化视图（卡片/筛选/图表同读这一份）。
 * 所有变更都走 ledger runtime 的事务性 commit：重算失败自动回滚，不留半成品。
 * 原始读数只追加；改读数 = 追加观测，旧读数不被改写。
 */
import { create } from 'zustand';
import { createLedgerRuntime } from '../lib/ledger/runtime';
import {
  appendObservation,
  recordCalibration,
  withdrawCalibration,
  createSession,
  updateSession,
  deleteSession,
  type LegacyMemoryLike,
} from '../lib/ledger/ledger';
import type {
  Calibration,
  AppendResult,
  Season,
  SmellType,
  Emotion,
  SessionFields,
  SmellMemory,
} from '../lib/ledger/types';
import { generateId } from '../utils/helpers';
import { mockMemories } from '../data/mockData';

export interface MemoryInput {
  location: string;
  source_guess: string;
  /** 原始读数（档案员当下闻到的强度/湿度）。 */
  intensity: number;
  humidity: number;
  season: Season;
  smell_type: SmellType;
  memory_text: string;
  color_association: string;
  emotion: Emotion;
  want_again: boolean;
}

export interface CalibrationInput {
  validFrom: string | null;
  validTo: string | null;
  intensityOffset: number;
  humidityOffset: number;
  reason?: string;
}

export interface ConflictState {
  sessionId: string;
  sampledAt: string;
  yourReading: { intensity: number; humidity: number };
  winner: { observer: string; savedAt: string; intensity: number; humidity: number; seq: number };
  latestSeq: number;
}

interface MigrationState {
  migrated: number;
  total: number;
  done: boolean;
}

interface MemoryStore {
  memories: SmellMemory[];
  calibrations: Calibration[];
  observer: string;
  migration: MigrationState;
  conflict: ConflictState | null;
  rollbackError: string | null;
  hydrated: boolean;

  initIfEmpty: () => void;
  addMemory: (input: MemoryInput) => void;
  updateMemory: (id: string, input: MemoryInput) => void;
  deleteMemory: (id: string) => void;

  addCalibration: (input: CalibrationInput) => void;
  withdrawCalibration: (calibrationId: string) => void;

  setObserver: (name: string) => void;
  forceOverwrite: () => void;
  dismissConflict: () => void;
  simulateConflict: (sessionId: string) => void;
  recomputeNow: () => void;
  clearRollbackError: () => void;
}

const runtime = createLedgerRuntime();

/** 旧数据：优先读旧版 zustand 持久化，否则用预置示例（均无观测号，需迁移）。 */
function loadLegacyMemories(): LegacyMemoryLike[] {
  try {
    const raw = localStorage.getItem('scent-memory-storage');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { memories?: LegacyMemoryLike[] } };
      const mems = parsed?.state?.memories;
      if (Array.isArray(mems) && mems.length > 0) return mems;
    }
  } catch {
    /* 旧数据损坏 → 回退到示例 */
  }
  return mockMemories as unknown as LegacyMemoryLike[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  memories: [],
  calibrations: [],
  observer: runtime.observer,
  migration: { migrated: 0, total: 0, done: false },
  conflict: null,
  rollbackError: null,
  hydrated: false,

  initIfEmpty: () => {
    if (get().hydrated) return;
    const legacy = loadLegacyMemories();
    runtime.init(legacy);
    set({
      memories: runtime.derived.memories,
      calibrations: runtime.derived.activeCalibrations,
      observer: runtime.observer,
      migration: { migrated: runtime.checkpoints.length, total: legacy.length, done: true },
      hydrated: true,
    });
  },

  addMemory: (input) => {
    const now = nowIso();
    const sessionId = generateId();
    const fields: SessionFields = {
      location: input.location,
      source_guess: input.source_guess,
      season: input.season,
      smell_type: input.smell_type,
      memory_text: input.memory_text,
      color_association: input.color_association,
      emotion: input.emotion,
      want_again: input.want_again,
      created_at: now,
      updated_at: now,
    };
    const { derived } = runtime.commit((draft) => {
      let next = createSession(draft, sessionId, fields, now);
      const r = appendObservation(next, {
        sessionId,
        sampledAt: now,
        intensity: input.intensity,
        humidity: input.humidity,
        observer: runtime.observer,
        savedAt: now,
      });
      next = r.events;
      return { events: next };
    });
    set({ memories: derived.memories, calibrations: derived.activeCalibrations });
  },

  updateMemory: (id, input) => {
    const current = runtime.derived.memories.find((m) => m.id === id);
    if (!current) return;
    const canonical = runtime.derived.canonicalObservations.get(id);
    const now = nowIso();

    const fields: Partial<SessionFields> = {
      location: input.location,
      source_guess: input.source_guess,
      season: input.season,
      smell_type: input.smell_type,
      memory_text: input.memory_text,
      color_association: input.color_association,
      emotion: input.emotion,
      want_again: input.want_again,
    };
    const readingChanged =
      input.intensity !== (current.raw_intensity ?? current.intensity) ||
      input.humidity !== (current.raw_humidity ?? current.humidity);

    const { derived, result } = runtime.commit((draft) => {
      let next = updateSession(draft, id, fields, now);
      if (readingChanged) {
        const r = appendObservation(next, {
          sessionId: id,
          sampledAt: current.sampled_at ?? now,
          intensity: input.intensity,
          humidity: input.humidity,
          observer: runtime.observer,
          savedAt: now,
          baseSeq: canonical?.seq,
        });
        next = r.events;
        return { events: next, result: r.result };
      }
      return { events: next };
    });
    const appendResult = result as AppendResult | undefined;

    if (appendResult?.status === 'conflict') {
      set({
        memories: derived.memories,
        calibrations: derived.activeCalibrations,
        conflict: {
          sessionId: id,
          sampledAt: current.sampled_at ?? now,
          yourReading: appendResult.yourReading,
          winner: { ...appendResult.winner },
          latestSeq: appendResult.winner.seq,
        },
      });
    } else {
      set({ memories: derived.memories, calibrations: derived.activeCalibrations, conflict: null });
    }
  },

  deleteMemory: (id) => {
    const { derived } = runtime.commit((draft) => deleteSession(draft, id, nowIso()));
    set({ memories: derived.memories, calibrations: derived.activeCalibrations });
  },

  addCalibration: (input) => {
    const { derived } = runtime.commit((draft) =>
      recordCalibration(draft, {
        validFrom: input.validFrom,
        validTo: input.validTo,
        intensityOffset: input.intensityOffset,
        humidityOffset: input.humidityOffset,
        reason: input.reason,
        recordedAt: nowIso(),
      }),
    );
    set({ memories: derived.memories, calibrations: derived.activeCalibrations });
  },

  withdrawCalibration: (calibrationId) => {
    const { derived } = runtime.commit((draft) =>
      withdrawCalibration(draft, calibrationId, nowIso()),
    );
    set({ memories: derived.memories, calibrations: derived.activeCalibrations });
  },

  setObserver: (name) => {
    runtime.setObserver(name);
    set({ observer: name });
  },

  forceOverwrite: () => {
    const c = get().conflict;
    if (!c) return;
    const { derived } = runtime.commit((draft) => {
      const r = appendObservation(draft, {
        sessionId: c.sessionId,
        sampledAt: c.sampledAt,
        intensity: c.yourReading.intensity,
        humidity: c.yourReading.humidity,
        observer: runtime.observer,
        savedAt: nowIso(),
        baseSeq: c.latestSeq, // 与最新标准读数对齐 → 成功覆盖
      });
      return { events: r.events, result: r.result };
    });
    set({ memories: derived.memories, calibrations: derived.activeCalibrations, conflict: null });
  },

  dismissConflict: () => set({ conflict: null }),

  // 演示用：另一位档案员基于过期令牌保存同一次闻样 → 触发冲突。
  simulateConflict: (sessionId) => {
    const current = runtime.derived.memories.find((m) => m.id === sessionId);
    if (!current) return;
    const now = nowIso();
    const { derived, result } = runtime.commit((draft) => {
      const r = appendObservation(draft, {
        sessionId,
        sampledAt: current.sampled_at ?? now,
        intensity: current.raw_intensity ?? current.intensity,
        humidity: current.raw_humidity ?? current.humidity,
        observer: '另一位档案员',
        savedAt: now,
        baseSeq: 0, // 故意用过期令牌（标准读数 seq 恒 >=1）触发冲突
      });
      return { events: r.events, result: r.result };
    });
    const appendResult = result as AppendResult | undefined;
    if (appendResult?.status === 'conflict') {
      set({
        memories: derived.memories,
        conflict: {
          sessionId,
          sampledAt: current.sampled_at ?? now,
          yourReading: appendResult.yourReading,
          winner: { ...appendResult.winner },
          latestSeq: appendResult.winner.seq,
        },
      });
    } else {
      set({ memories: derived.memories });
    }
  },

  recomputeNow: () => {
    try {
      const derived = runtime.recompute();
      set({ memories: derived.memories, calibrations: derived.activeCalibrations, rollbackError: null });
    } catch (err) {
      set({ rollbackError: (err as Error).message });
    }
  },

  clearRollbackError: () => set({ rollbackError: null }),
}));
