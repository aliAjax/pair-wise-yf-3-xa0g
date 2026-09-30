/**
 * 端到端：通过 store 验证「迁移 → 校准 → 撤回 → 冲突」整条链路。
 * 各用例按顺序共享同一份账本（集成测试）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { useMemoryStore } from '../store/memoryStore';
import { localStorageMem } from './setup-localstorage';

beforeAll(() => {
  localStorageMem.clear();
});

describe('端到端：迁移 → 校准 → 撤回 → 冲突', () => {
  it('init 把 mockData 迁移成单次观测（无校准、读数即原始值）', () => {
    useMemoryStore.getState().initIfEmpty();
    const s = useMemoryStore.getState();
    expect(s.memories.length).toBe(8);
    expect(s.migration.migrated).toBe(8);
    for (const m of s.memories) {
      expect(m.observation_id).not.toBeNull();
      expect(m.calibration_id).toBeNull();
      expect(m.raw_intensity).toBe(m.intensity);
    }
  });

  it('录入覆盖过去的基线 → 历史记忆被修正，原始读数不变', () => {
    const before = useMemoryStore.getState().memories[0];
    useMemoryStore.getState().addCalibration({
      validFrom: '2020-01-01T00:00:00.000Z',
      validTo: null,
      intensityOffset: -2,
      humidityOffset: 0,
      reason: '补校准',
    });
    const s = useMemoryStore.getState();
    const after = s.memories.find((m) => m.id === before.id)!;
    expect(after.intensity).toBe(before.intensity - 2);
    expect(after.calibration_id).not.toBeNull();
    expect(after.raw_intensity).toBe(before.raw_intensity);
    expect(s.calibrations.length).toBe(1);
  });

  it('撤回基线 → 旧结论失效，回到原始读数', () => {
    const s = useMemoryStore.getState();
    const calId = s.calibrations[0].calibrationId;
    const before = s.memories.find((m) => m.calibration_id === calId)!;
    useMemoryStore.getState().withdrawCalibration(calId);
    const after = useMemoryStore.getState().memories.find((m) => m.id === before.id)!;
    expect(after.intensity).toBe(after.raw_intensity);
    expect(after.calibration_id).toBeNull();
    expect(useMemoryStore.getState().calibrations).toHaveLength(0);
  });

  it('模拟并发 → 冲突横幅出现，后到者看到胜出者与来源', () => {
    const target = useMemoryStore.getState().memories[0];
    useMemoryStore.getState().simulateConflict(target.id);
    const c = useMemoryStore.getState().conflict;
    expect(c).not.toBeNull();
    expect(c!.winner.observer).toBeTruthy();
    expect(c!.winner.savedAt).toBeTruthy();
    expect(c!.winner.intensity).toBeGreaterThan(0);
    // 标准读数未被后到者覆盖
    const mem = useMemoryStore.getState().memories.find((m) => m.id === target.id)!;
    expect(mem.observer).not.toBe('另一位档案员');
  });

  it('采用 TA 的读数 → 冲突消除', () => {
    useMemoryStore.getState().dismissConflict();
    expect(useMemoryStore.getState().conflict).toBeNull();
  });

  it('强制重算 → 结果确定，记忆数不变', () => {
    const before = useMemoryStore.getState().memories.length;
    useMemoryStore.getState().recomputeNow();
    const s = useMemoryStore.getState();
    expect(s.memories.length).toBe(before);
    expect(s.rollbackError).toBeNull();
  });
});
