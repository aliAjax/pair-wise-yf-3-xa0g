/**
 * 嗅觉台账 · 正确性测试
 *
 * 覆盖叙事里的硬性要求：
 *  - 原始读数只追加（改读数 = 追加新观测，旧读数不被改写）
 *  - 校准按采样时刻区间生效；迟到基线修正历史；撤回后旧结论失效
 *  - 重算失败回滚，不留半成品
 *  - 并发追加：baseSeq 不符 → 冲突，后到者看到胜出者与来源
 *  - 旧数据迁移成单次观测；中断可继续；幂等
 *  - 卡片/筛选/观测同读一份物化视图（一致性）
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  recompute,
  appendObservation,
  recordCalibration,
  withdrawCalibration,
  migrateLegacy,
  createSession,
  type LegacyMemoryLike,
  type LedgerEvent,
  type SessionFields,
} from './index';
import { createLedgerRuntime } from './runtime';

/* ------------------------------------------------------------------ */
/* localStorage 垫片（node 环境无 localStorage）                        */
/* ------------------------------------------------------------------ */
const mem = new Map<string, string>();
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    length: mem.size,
  } as Storage;
});
beforeEach(() => mem.clear());

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';
const T3 = '2026-04-01T00:00:00.000Z';

function baseFields(over: Partial<SessionFields> = {}): SessionFields {
  return {
    location: '测试地点',
    source_guess: '测试来源',
    season: 'autumn',
    smell_type: 'woody',
    memory_text: '一段记忆',
    color_association: '#8B5A2B',
    emotion: 'nostalgic',
    want_again: true,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

/** 建一个会话 + 一条标准观测，返回事件与会话 id。 */
function setupSession(events: LedgerEvent[], sessionId: string, intensity = 8, sampledAt = T0) {
  let next = createSession(events, sessionId, baseFields({ created_at: sampledAt, updated_at: sampledAt }), sampledAt);
  const r = appendObservation(next, {
    sessionId,
    sampledAt,
    intensity,
    humidity: 5,
    observer: '档案员·甲',
    savedAt: sampledAt,
  });
  next = r.events;
  return { events: next, canonical: r.result.status === 'saved' ? r.result.canonical : undefined };
}

/* ------------------------------------------------------------------ */
/* 1. 原始读数只追加                                                    */
/* ------------------------------------------------------------------ */
describe('原始读数只追加', () => {
  it('改读数是追加新观测，旧读数仍留在账本且不被改写', () => {
    let { events } = setupSession([], 's1', 8, T0);
    const first = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(first.intensity).toBe(8);
    expect(first.raw_intensity).toBe(8);

    // 档案员乙改读数：追加一条新观测
    const r2 = appendObservation(events, {
      sessionId: 's1',
      sampledAt: T0,
      intensity: 6,
      humidity: 5,
      observer: '档案员·乙',
      savedAt: T1,
      baseSeq: recompute(events).canonicalObservations.get('s1')!.seq,
    });
    events = r2.events;

    const obsEvents = events.filter((e) => e.kind === 'observation.recorded');
    expect(obsEvents).toHaveLength(2); // 两条都在
    expect(obsEvents[0].intensity).toBe(8); // 旧读数未被改写
    expect(obsEvents[0].status).toBe('saved');
    expect(obsEvents[1].intensity).toBe(6);

    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(6); // 卡片读到的是新读数
    expect(mem.raw_intensity).toBe(6);
    expect(mem.observer).toBe('档案员·乙');
  });
});

/* ------------------------------------------------------------------ */
/* 2. 校准按采样时刻区间生效；迟到修正历史；撤回失效                    */
/* ------------------------------------------------------------------ */
describe('校准基线', () => {
  it('命中区间的观测被修正，未命中的不修正', () => {
    let { events } = setupSession([], 's1', 8, T1);

    // 基线区间 [T0, T2)，偏移 -2 → s1 采样于 T1，命中 → 6
    const cal = recordCalibration(events, {
      validFrom: T0,
      validTo: T2,
      intensityOffset: -2,
      humidityOffset: 0,
      reason: '嗅觉疲劳校准',
      recordedAt: T1,
    });
    events = cal.events;

    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(6);
    expect(mem.raw_intensity).toBe(8);
    expect(mem.calibration_id).toBe(cal.calibration.calibrationId);
  });

  it('区间外的观测不被修正', () => {
    let { events } = setupSession([], 's1', 8, T3); // 采样于 T3
    const cal = recordCalibration(events, {
      validFrom: T0,
      validTo: T2, // T3 在区间外
      intensityOffset: -2,
      humidityOffset: 0,
      recordedAt: T1,
    });
    events = cal.events;
    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(8); // 未修正
    expect(mem.calibration_id).toBeNull();
  });

  it('迟到的基线（记录晚于区间）会修正历史观测', () => {
    let { events } = setupSession([], 's1', 8, T0);
    // 基线在 T2 才录入，但区间从 T0 开始 → 迟到，仍修正 T0 的历史观测
    const cal = recordCalibration(events, {
      validFrom: T0,
      validTo: null,
      intensityOffset: -2,
      humidityOffset: 0,
      reason: '补校准',
      recordedAt: T2,
    });
    events = cal.events;
    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(6);
  });

  it('撤回基线后旧结论失效，读数回到未校准', () => {
    let { events } = setupSession([], 's1', 8, T0);
    const cal = recordCalibration(events, {
      validFrom: T0,
      validTo: null,
      intensityOffset: -2,
      humidityOffset: 0,
      recordedAt: T0,
    });
    events = cal.events;
    expect(recompute(events).memories.find((m) => m.id === 's1')!.intensity).toBe(6);

    const w = withdrawCalibration(events, cal.calibration.calibrationId, T1);
    events = w.events;
    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(8); // 撤回后回到原始读数
    expect(mem.calibration_id).toBeNull();
    expect(recompute(events).activeCalibrations).toHaveLength(0);
  });

  it('修正量被限制在 1-10', () => {
    let { events } = setupSession([], 's1', 3, T0);
    const cal = recordCalibration(events, {
      validFrom: T0,
      validTo: null,
      intensityOffset: -5,
      humidityOffset: 0,
      recordedAt: T0,
    });
    events = cal.events;
    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(1); // 3 - 5 截断到 1
  });
});

/* ------------------------------------------------------------------ */
/* 3. 并发冲突：后到者看到胜出者与来源                                 */
/* ------------------------------------------------------------------ */
describe('并发追加冲突', () => {
  it('baseSeq 不符 → 冲突：标准读数不变，后到者看到胜出者', () => {
    let { events, canonical } = setupSession([], 's1', 8, T0);
    const seq1 = canonical!.seq;

    // 甲先改（基于 seq1）→ 成功，标准读数推进到 seq2
    const a = appendObservation(events, {
      sessionId: 's1',
      sampledAt: T0,
      intensity: 7,
      humidity: 5,
      observer: '档案员·甲',
      savedAt: T1,
      baseSeq: seq1,
    });
    expect(a.result.status).toBe('saved');
    events = a.events;
    const seq2 = a.result.status === 'saved' ? a.result.canonical.seq : -1;

    // 乙基于过期的 seq1 保存 → 冲突
    const b = appendObservation(events, {
      sessionId: 's1',
      sampledAt: T0,
      intensity: 5,
      humidity: 5,
      observer: '档案员·乙',
      savedAt: T2,
      baseSeq: seq1,
    });
    expect(b.result.status).toBe('conflict');
    if (b.result.status === 'conflict') {
      expect(b.result.winner.seq).toBe(seq2);
      expect(b.result.winner.observer).toBe('档案员·甲'); // 来源
      expect(b.result.winner.intensity).toBe(7);
      expect(b.result.yourReading.intensity).toBe(5);
    }

    // 标准读数仍是甲的 7
    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(7);
    expect(mem.observer).toBe('档案员·甲');

    // 乙的尝试仍记入账本（可追溯），但不是标准读数
    const conflictEvt = b.events.find((e) => e.kind === 'observation.recorded' && e.status === 'conflict');
    expect(conflictEvt).toBeDefined();
    expect(recompute(b.events).canonicalObservations.get('s1')!.seq).toBe(seq2);
  });

  it('以最新 baseSeq 重新保存（覆盖）→ 成功', () => {
    let { events, canonical } = setupSession([], 's1', 8, T0);
    const seq1 = canonical!.seq;
    const a = appendObservation(events, {
      sessionId: 's1',
      sampledAt: T0,
      intensity: 7,
      humidity: 5,
      observer: '档案员·甲',
      savedAt: T1,
      baseSeq: seq1,
    });
    events = a.events;
    const seq2 = a.result.status === 'saved' ? a.result.canonical.seq : -1;

    // 乙先撞冲突
    const b = appendObservation(events, {
      sessionId: 's1',
      sampledAt: T0,
      intensity: 5,
      humidity: 5,
      observer: '档案员·乙',
      savedAt: T2,
      baseSeq: seq1,
    });
    expect(b.result.status).toBe('conflict');

    // 乙以最新 seq2 重新保存 → 成功覆盖
    const c = appendObservation(events, {
      sessionId: 's1',
      sampledAt: T0,
      intensity: 6,
      humidity: 5,
      observer: '档案员·乙',
      savedAt: T3,
      baseSeq: seq2,
    });
    expect(c.result.status).toBe('saved');
    events = c.events;
    const mem = recompute(events).memories.find((m) => m.id === 's1')!;
    expect(mem.intensity).toBe(6);
    expect(mem.observer).toBe('档案员·乙');
  });
});

/* ------------------------------------------------------------------ */
/* 4. 旧数据迁移：单次观测、幂等、可继续                               */
/* ------------------------------------------------------------------ */
describe('旧数据迁移', () => {
  const legacy: LegacyMemoryLike[] = [
    { ...baseFields({ created_at: T0, updated_at: T0 }), id: 'mock-1', intensity: 7, humidity: 4 },
    { ...baseFields({ created_at: T1, updated_at: T1 }), id: 'mock-2', intensity: 5, humidity: 9 },
    { ...baseFields({ created_at: T2, updated_at: T2 }), id: 'mock-3', intensity: 9, humidity: 5 },
  ];

  it('每条旧记录迁移成一次观测，且不带校准', () => {
    const { events, migrated } = migrateLegacy([], legacy);
    expect(migrated).toBe(3);
    const derived = recompute(events);
    expect(derived.memories).toHaveLength(3);
    for (const m of derived.memories) {
      expect(m.observation_id).not.toBeNull();
      expect(m.calibration_id).toBeNull(); // 迁移时无基线
      expect(m.raw_intensity).toBe(m.intensity); // 无校准 → 读数即原始值
    }
    expect(derived.memories.find((m) => m.id === 'mock-1')!.intensity).toBe(7);
  });

  it('幂等：重复迁移不产生重复观测', () => {
    const first = migrateLegacy([], legacy);
    const second = migrateLegacy(first.events, legacy);
    expect(second.migrated).toBe(0);
    expect(second.events.length).toBe(first.events.length);
    const obsCount = second.events.filter((e) => e.kind === 'observation.recorded').length;
    expect(obsCount).toBe(3);
  });

  it('中断可继续：先迁 2 条，再跑只补第 3 条', () => {
    const partial = migrateLegacy([], legacy.slice(0, 2));
    expect(partial.migrated).toBe(2);
    const resume = migrateLegacy(partial.events, legacy);
    expect(resume.migrated).toBe(1); // 只补未完成的
    const obsCount = resume.events.filter((e) => e.kind === 'observation.recorded').length;
    expect(obsCount).toBe(3);
    expect(recompute(resume.events).memories).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 重算原子：失败回滚，不留半成品                                   */
/* ------------------------------------------------------------------ */
describe('重算原子性', () => {
  it('commit 中重算失败 → 内存与落盘都回滚到上一份完整状态', () => {
    const rt = createLedgerRuntime();
    rt.init([]);
    rt.commit((d) => {
      const next = createSession(d, 's1', baseFields(), T0);
      return { events: next };
    });
    expect(rt.derived.memories).toHaveLength(1);

    // 制造一次会让重算抛错的提交（读数非法）
    const before = rt.events.length;
    expect(() =>
      rt.commit((d) => {
        // 直接塞一条非法读数事件，绕过 appendObservation 的校验
        const bad: LedgerEvent = {
          seq: d.length + 1,
          kind: 'observation.recorded',
          eventId: 'obs-bad',
          sessionId: 's1',
          sampledAt: T0,
          intensity: 99, // 非法
          humidity: 5,
          observer: 'x',
          savedAt: T0,
          status: 'saved',
        };
        return { events: [...d, bad] };
      }),
    ).toThrow();

    // 回滚：事件数与记忆数都不变（无半成品）
    expect(rt.events.length).toBe(before);
    expect(rt.derived.memories).toHaveLength(1);
    expect(rt.derived.memories.find((m) => m.id === 's1')!.intensity).toBe(0); // 无观测 → 0
  });

  it('校验错误（区间倒置）直接拒绝，状态不变', () => {
    const rt = createLedgerRuntime();
    rt.init([]);
    rt.commit((d) => createSession(d, 's1', baseFields(), T0));
    const before = rt.events.length;
    expect(() =>
      rt.commit((d) =>
        recordCalibration(d, {
          validFrom: T2,
          validTo: T0, // 倒置
          intensityOffset: -1,
          humidityOffset: 0,
          recordedAt: T0,
        }),
      ),
    ).toThrow(/起点不能晚于终点/);
    expect(rt.events.length).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 一致性：卡片/筛选/观测同读一份物化视图                           */
/* ------------------------------------------------------------------ */
describe('派生一致性', () => {
  it('同一份账本重算结果确定；每条记忆的溯源引用自洽', () => {
    let { events } = setupSession([], 's1', 8, T0);
    events = recordCalibration(events, {
      validFrom: T0,
      validTo: null,
      intensityOffset: -2,
      humidityOffset: 0,
      recordedAt: T0,
    }).events;
    setupSession(events, 's2', 5, T1);
    // 重新取一次包含 s2 的 events
    const r2 = setupSession(events, 's2', 5, T1);
    events = r2.events;

    const d1 = recompute(events);
    const d2 = recompute(events);
    expect(d1.memories).toEqual(d2.memories); // 确定性

    for (const m of d1.memories) {
      if (m.calibration_id) {
        expect(d1.activeCalibrations.some((c) => c.calibrationId === m.calibration_id)).toBe(true);
      }
      if (m.observation_id) {
        expect(d1.canonicalObservations.get(m.id)?.eventId).toBe(m.observation_id);
      }
    }
  });
});
