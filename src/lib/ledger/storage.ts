/**
 * 嗅觉台账 · 持久层
 *
 * 事件日志是唯一的事实来源（source of truth），物化视图只是缓存。
 * 写入采用「暂存 → 提升」两步：先写 :pending，再提升为正式键，最后清 pending。
 * 这样即使在写入中途崩溃，正式键里始终是上一份完整状态，重算失败不留半成品。
 */
import type { LedgerEvent, MigrationCheckpoint } from './types';

const EVENTS_KEY = 'scent-ledger-events';
const EVENTS_PENDING_KEY = 'scent-ledger-events:pending';
const CHECKPOINTS_KEY = 'scent-ledger-checkpoints';
const OBSERVER_KEY = 'scent-ledger-observer';

/** 内存兜底：仅在无 localStorage 的环境（如测试）启用，不参与生产持久化。 */
let memoryFallback: Map<string, string> | null = null;

function memoryStorage(): Storage {
  if (!memoryFallback) memoryFallback = new Map<string, string>();
  const m = memoryFallback;
  return {
    getItem: (key: string) => (m.has(key) ? m.get(key)! : null),
    setItem: (key: string, value: string) => {
      m.set(key, value);
    },
    removeItem: (key: string) => {
      m.delete(key);
    },
    clear: () => m.clear(),
    key: (index: number) => Array.from(m.keys())[index] ?? null,
    length: m.size,
  } as Storage;
}

/** 获取存储：优先 localStorage，不可用时回退内存（保证可测、不崩）。 */
function getStorage(): Storage {
  const ls = (globalThis as unknown as { localStorage?: Storage }).localStorage;
  if (ls) return ls;
  return memoryStorage();
}

function safeParse<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readArray<T>(key: string): T[] {
  const parsed = safeParse<T[]>(getStorage().getItem(key));
  return Array.isArray(parsed) ? parsed : [];
}

/** 载入事件日志；若存在完整的 pending 则提升，否则丢弃 pending（正式键仍是上一份好状态）。 */
export function loadEvents(): LedgerEvent[] {
  const ls = getStorage();
  const pending = safeParse<LedgerEvent[]>(ls.getItem(EVENTS_PENDING_KEY));
  if (Array.isArray(pending)) {
    // pending 是完整数组 → 提升为正式状态
    try {
      ls.setItem(EVENTS_KEY, JSON.stringify(pending));
      ls.removeItem(EVENTS_PENDING_KEY);
      return pending;
    } catch {
      // 提升失败（如配额）→ 丢弃 pending，保留正式键
      ls.removeItem(EVENTS_PENDING_KEY);
    }
  } else {
    // pending 损坏 → 丢弃，正式键仍是上一份完整状态
    ls.removeItem(EVENTS_PENDING_KEY);
  }
  return readArray<LedgerEvent>(EVENTS_KEY);
}

/** 原子地保存整份事件日志：先写 pending，再提升，最后清 pending。 */
export function saveEvents(events: LedgerEvent[]): void {
  const ls = getStorage();
  const json = JSON.stringify(events);
  ls.setItem(EVENTS_PENDING_KEY, json);
  ls.setItem(EVENTS_KEY, json);
  ls.removeItem(EVENTS_PENDING_KEY);
}

export function loadCheckpoints(): MigrationCheckpoint[] {
  return readArray<MigrationCheckpoint>(CHECKPOINTS_KEY);
}

export function saveCheckpoints(checkpoints: MigrationCheckpoint[]): void {
  getStorage().setItem(CHECKPOINTS_KEY, JSON.stringify(checkpoints));
}

export function loadObserver(): string {
  return getStorage().getItem(OBSERVER_KEY) || '档案员';
}

export function saveObserver(observer: string): void {
  getStorage().setItem(OBSERVER_KEY, observer);
}

export function clearLedger(): void {
  const ls = getStorage();
  ls.removeItem(EVENTS_KEY);
  ls.removeItem(EVENTS_PENDING_KEY);
  ls.removeItem(CHECKPOINTS_KEY);
}
