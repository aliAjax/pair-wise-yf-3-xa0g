/**
 * 嗅觉台账 · 运行时
 *
 * 持有内存中的事件日志与物化视图，对外提供事务性 commit：
 *   1. 在内存里应用 mutator（纯函数，可能抛校验错误）。
 *   2. 对新账本做一次完整重算（可能抛 RecomputeError）。
 *   3. 只有重算成功才原子落盘；任何一步失败都回滚到上一份完整状态，不留半成品。
 */
import {
  forceRecompute,
  migrateLegacy,
  type LegacyMemoryLike,
} from './ledger';
import { loadEvents, saveEvents, loadCheckpoints, saveCheckpoints, loadObserver, saveObserver } from './storage';
import type { DerivedState, LedgerEvent, MigrationCheckpoint } from './types';
import { RecomputeError } from './types';

export interface CommitResult<T> {
  derived: DerivedState;
  result?: T;
}

export interface LedgerRuntime {
  events: LedgerEvent[];
  derived: DerivedState;
  checkpoints: MigrationCheckpoint[];
  observer: string;
  /** 载入 + 幂等迁移 + 重算。返回本次新迁移的条数。 */
  init(legacy: LegacyMemoryLike[]): { migratedCount: number };
  /** 事务性提交：mutator 纯函数返回新事件（或 {events, result}）。 */
  commit(mutator: (draft: LedgerEvent[]) => LedgerEvent[] | { events: LedgerEvent[]; result?: unknown }): CommitResult<unknown>;
  /** 强制重算（UI 上的「重算」按钮）；失败回滚，不留半成品。 */
  recompute(): DerivedState;
  setObserver(name: string): void;
}

export function createLedgerRuntime(): LedgerRuntime {
  let events: LedgerEvent[] = [];
  let derived: DerivedState;
  let checkpoints: MigrationCheckpoint[] = [];
  let observer = loadObserver();

  return {
    get events() {
      return events;
    },
    get derived() {
      return derived;
    },
    get checkpoints() {
      return checkpoints;
    },
    get observer() {
      return observer;
    },

    init(legacy) {
      events = loadEvents();
      checkpoints = loadCheckpoints();

      // 幂等迁移：已迁移的会被自动跳过，中断后重跑继续。
      const migrated = migrateLegacy(events, legacy, 'legacy');
      events = migrated.events;
      checkpoints = [...checkpoints, ...migrated.checkpoints];
      if (migrated.migrated > 0) {
        saveEvents(events);
        saveCheckpoints(checkpoints);
      }

      derived = forceRecompute(events);
      return { migratedCount: migrated.migrated };
    },

  commit(mutator: (draft: LedgerEvent[]) => LedgerEvent[] | { events: LedgerEvent[]; result?: unknown }): CommitResult<unknown> {
      const prevEvents = events;
      let nextEvents: LedgerEvent[];
      let result: unknown;

      // 1. 应用 mutator（纯函数；校验错误在此抛出，状态不变）。
      const out = mutator(prevEvents);
      nextEvents = Array.isArray(out) ? out : out.events;
      result = Array.isArray(out) ? undefined : out.result;

      // 2. 完整重算（失败 → 回滚，不落盘，不留半成品）。
      let nextDerived: DerivedState;
      try {
        nextDerived = forceRecompute(nextEvents);
      } catch (err) {
        events = prevEvents;
        if (err instanceof RecomputeError) throw err;
        throw new RecomputeError(`重算失败，已回滚：${(err as Error).message}`, err);
      }

      // 3. 原子落盘（只有重算成功才走到这）。
      try {
        saveEvents(nextEvents);
      } catch (err) {
        events = prevEvents;
        throw new RecomputeError(`落盘失败，已回滚：${(err as Error).message}`, err);
      }

      events = nextEvents;
      derived = nextDerived;
      return { derived: nextDerived, result };
    },

    recompute() {
      const next = forceRecompute(events);
      derived = next;
      return next;
    },

    setObserver(name) {
      observer = name;
      saveObserver(name);
    },
  };
}
