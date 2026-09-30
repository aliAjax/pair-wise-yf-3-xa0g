import type { LegacyRecord, LedgerEvent, Projection } from './types';
import { migrateLegacyRecord, defaultDeps } from './commands';
import type { CommandDeps } from './types';
import { replay } from './projection';

/**
 * 可继续的旧数据迁移队列。
 *
 * - 队列状态可持久化（每条作业带 done 标记），刷新/中断后从第一个未完成项继续
 * - 每条迁移是一次原子提交：成功才标 done；失败保留错误、停在原处，稍后重试
 * - 已在事件流中的 legacyId 自动判重（幂等），重复入队/重复执行都安全
 */
export interface MigrationJob {
  legacy: LegacyRecord;
  done: boolean;
  migrated: boolean;
  observationId?: string;
  error?: string;
  attempts: number;
}

export interface MigrationQueue {
  jobs: MigrationJob[];
  /** 全部完成（含判重跳过） */
  finished: boolean;
  lastError?: string;
}

export function createQueue(records: LegacyRecord[]): MigrationQueue {
  return {
    jobs: records.map((legacy) => ({ legacy, done: false, migrated: false, attempts: 0 })),
    finished: records.length === 0,
  };
}

export interface QueueTickResult {
  queue: MigrationQueue;
  events: LedgerEvent[];
  projection: Projection;
  /** 本步是否真正处理了一条（用于驱动循环或停止） */
  processed: boolean;
}

/** 推进队列一条；全部完成或某条失败时停止。失败不抛异常、不留半成品。 */
export function tickMigration(
  queue: MigrationQueue,
  events: LedgerEvent[],
  deps: CommandDeps = defaultDeps,
): QueueTickResult {
  const projection = replay(events);
  const idx = queue.jobs.findIndex((j) => !j.done);
  if (idx === -1) {
    return { queue: { ...queue, finished: true }, events, projection, processed: false };
  }

  const job = queue.jobs[idx];
  const { result, events: nextEvents, projection: nextProjection } = migrateLegacyRecord(
    events,
    job.legacy,
    deps,
  );

  const jobs = queue.jobs.slice();
  if (result.ok) {
    jobs[idx] = {
      ...job,
      done: true,
      migrated: result.migrated,
      observationId: result.observationId,
      attempts: job.attempts + 1,
      error: undefined,
    };
  } else {
    // 原子提交失败：事件流原样未动；标记错误并停在该条，等待「继续迁移」
    jobs[idx] = { ...job, attempts: job.attempts + 1, error: result.error };
  }

  const finished = jobs.every((j) => j.done);
  return {
    queue: { jobs, finished, lastError: result.ok ? undefined : result.error },
    events: nextEvents,
    projection: nextProjection,
    processed: true,
  };
}

/** 连续推进；maxSteps 用于模拟「处理到一半中断」，之后可随时继续。 */
export function runMigration(
  queue: MigrationQueue,
  events: LedgerEvent[],
  maxSteps = Number.POSITIVE_INFINITY,
  deps: CommandDeps = defaultDeps,
): QueueTickResult {
  let q = queue;
  let ev = events;
  let projection = replay(events);
  let steps = 0;
  for (;;) {
    const r = tickMigration(q, ev, deps);
    q = r.queue;
    ev = r.events;
    projection = r.projection;
    if (!r.processed) break;
    steps += 1;
    if (q.lastError) break; // 某条失败 -> 停住，队列保持可继续
    if (steps >= maxSteps) break; // 外部中断点
  }
  return { queue: q, events: ev, projection, processed: steps > 0 };
}

export function queueProgress(queue: MigrationQueue): { done: number; total: number; migrated: number; skipped: number; failed: number } {
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const j of queue.jobs) {
    if (j.done && j.migrated) migrated += 1;
    else if (j.done) skipped += 1;
    else if (j.attempts > 0 && j.error) failed += 1;
  }
  return { done: queue.jobs.filter((j) => j.done).length, total: queue.jobs.length, migrated, skipped, failed };
}
