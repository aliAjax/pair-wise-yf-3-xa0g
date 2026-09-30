import { useMemo } from 'react';
import { replay, liveMemories } from '../ledger';
import { useLedgerStore } from '../store/memoryStore';

/** 事件流 -> 投影：任何命令提交后自动完整重算，卡片/筛选/排行永远一致 */
export function useProjection() {
  const events = useLedgerStore((s) => s.events);
  return useMemo(() => replay(events), [events]);
}

/** 未废弃的记忆（卡片/筛选/排行的统一来源） */
export function useLiveMemories() {
  const p = useProjection();
  return useMemo(() => liveMemories(p), [p]);
}
