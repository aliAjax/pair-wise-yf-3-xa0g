import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  recordObservation,
  amendMemory,
  discardMemory,
  registerCalibration,
  withdrawCalibration,
  createQueue,
  runMigration,
  queueProgress,
} from '../ledger';
import type {
  BaselineView,
  ConflictReceipt,
  LedgerEvent,
  MemoryNarrative,
  MemoryView,
} from '../ledger/types';
import type { MigrationQueue } from '../ledger/migration';
import { migrateLegacyState } from '../ledger/stateMigration';
import { legacySeed } from '../data/legacySeed';

/** 录入表单提交的形状（强度即原始读数） */
export interface ObservationForm extends MemoryNarrative {
  archivist: string;
  sampledAt: string;
  rawIntensity: number;
}

export interface Notice {
  kind: 'ok' | 'conflict' | 'error';
  text: string;
  detail?: ConflictReceipt;
}

interface LedgerStore {
  /** 唯一事实来源：只追加的事件流 */
  events: LedgerEvent[];
  /** 可继续的旧档迁移队列（持久化，中断后可续） */
  migrationQueue: MigrationQueue;
  currentArchivist: string;
  notice: Notice | null;

  setArchivist: (name: string) => void;
  clearNotice: () => void;

  /** 首次进入：旧档迁移（已完成则幂等跳过） */
  ensureMigrated: () => void;
  /** 迁移中断后继续 */
  continueMigration: () => void;

  record: (form: ObservationForm, sniffKey: string) => void;
  amend: (memory: MemoryView, patch: Partial<MemoryNarrative> & { sampledAt?: string }) => void;
  discard: (id: string, reason?: string) => void;

  addCalibration: (args: { standardReading: number; observedReading: number; validFrom: string }) => { ok: boolean; error?: string; affected: number };
  withdrawCalibration: (baselineId: string, reason: string) => { ok: boolean; error?: string; affected: number };
}

function applyMigration(events: LedgerEvent[], queue: MigrationQueue) {
  const r = runMigration(queue, events);
  return { events: r.events, queue: r.queue };
}

export const useLedgerStore = create<LedgerStore>()(
  persist(
    (set, get) => ({
      events: [],
      migrationQueue: createQueue([]),
      currentArchivist: '林档案员',
      notice: null,

      setArchivist: (name) => set({ currentArchivist: name.trim() || '林档案员' }),
      clearNotice: () => set({ notice: null }),

      ensureMigrated: () => {
        const { events, migrationQueue } = get();
        if (migrationQueue.finished) return;
        const next = applyMigration(events, migrationQueue);
        set({ events: next.events, migrationQueue: next.queue });
        const prog = queueProgress(next.queue);
        if (!next.queue.finished) {
          set({
            notice: {
              kind: 'error',
              text: `旧档迁移在第 ${prog.done + 1} 条中断（${next.queue.lastError ?? '未知错误'}），可稍后继续`,
            },
          });
        }
      },

      continueMigration: () => {
        const { events, migrationQueue } = get();
        if (migrationQueue.finished) return;
        const next = applyMigration(events, migrationQueue);
        const prog = queueProgress(next.queue);
        set({
          events: next.events,
          migrationQueue: next.queue,
          notice: next.queue.finished
            ? { kind: 'ok', text: `旧档迁移完成：共 ${prog.migrated} 条转为单次观测` }
            : {
                kind: 'error',
                text: `迁移仍卡在第 ${prog.done + 1} 条：${next.queue.lastError ?? '未知错误'}`,
              },
        });
      },

      record: (form, sniffKey) => {
        const r = recordObservation(get().events, { ...form, sniffKey });
        set({ events: r.events });
        if (r.result.ok) {
          set({ notice: { kind: 'ok', text: `原始读数已追加（观测号 ${r.result.observationId}）` } });
        } else if (r.result.kind === 'conflict') {
          const detail = r.result.conflict;
          set({
            notice: {
              kind: 'conflict',
              text: `同一次闻样已有原始读数：${detail.winnerArchivist} 先保存（${detail.winnerObservationId}，原始读数 ${detail.winnerRawIntensity}），你的读数仅登记为冲突`,
              detail,
            },
          });
        } else {
          set({ notice: { kind: 'error', text: r.result.error } });
        }
      },

      amend: (memory, patch) => {
        const r = amendMemory(get().events, memory.id, get().currentArchivist, patch);
        if (r.ok) set({ events: r.events, notice: { kind: 'ok', text: '叙述已修订，卡片与排行已重算' } });
        else set({ notice: { kind: 'error', text: r.error } });
      },

      discard: (id, reason) => {
        const r = discardMemory(get().events, id, get().currentArchivist, reason);
        if (r.ok) set({ events: r.events, notice: { kind: 'ok', text: '记忆已废弃（原始读数仍保留在账上）' } });
        else set({ notice: { kind: 'error', text: r.error } });
      },

      addCalibration: ({ standardReading, observedReading, validFrom }) => {
        const r = registerCalibration(get().events, {
          archivist: get().currentArchivist,
          standardReading,
          observedReading,
          validFrom,
        });
        if (!r.ok) {
          set({ notice: { kind: 'error', text: r.error } });
          return { ok: false, error: r.error, affected: 0 };
        }
        set({ events: r.events });
        set({
          notice: {
            kind: 'ok',
            text: `基线已登记（${r.baselineId}），${r.affectedMemoryIds.length} 条观测按采样时刻重算`,
          },
        });
        return { ok: true, affected: r.affectedMemoryIds.length };
      },

      withdrawCalibration: (baselineId, reason) => {
        const r = withdrawCalibration(get().events, baselineId, reason);
        if (!r.ok) {
          set({ notice: { kind: 'error', text: r.error } });
          return { ok: false, error: r.error, affected: 0 };
        }
        set({ events: r.events });
        set({
          notice: {
            kind: 'ok',
            text: `基线已撤回，${r.affectedMemoryIds.length} 条旧结论失效并回退原始读数`,
          },
        });
        return { ok: true, affected: r.affectedMemoryIds.length };
      },
    }),
    {
      name: 'scent-memory-storage',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        events: s.events,
        migrationQueue: s.migrationQueue,
        currentArchivist: s.currentArchivist,
      }),
      // 旧版（v1/v0）：没有观测号的 SmellMemory[] -> 建迁移队列，启动时逐条迁移
      migrate: (persisted: unknown, version: number) => {
        if (version >= 2) return persisted as Record<string, unknown>;
        return migrateLegacyState(persisted) as unknown as Record<string, unknown>;
      },
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as object) } as LedgerStore;
        // 全新用户（localStorage 无记录）：内置旧档作为待迁移数据
        if (!persisted) {
          merged.migrationQueue = createQueue(legacySeed);
        }
        // 防御：队列缺失（残缺的持久化）时补一个空队列，避免后续逻辑读到 undefined
        if (!merged.migrationQueue || !Array.isArray(merged.migrationQueue.jobs)) {
          merged.migrationQueue = createQueue(
            merged.events && merged.events.length > 0 ? [] : legacySeed,
          );
        }
        return merged;
      },
    },
  ),
);

export type { BaselineView };
