import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  replay,
  recordObservation,
  amendMemory,
  discardMemory,
  registerCalibration,
  withdrawCalibration,
  createQueue,
  runMigration,
  makeSniffKey,
  commitEvents,
  liveMemories,
  type CommandDeps,
  type LedgerEvent,
  type ObservationInput,
  type LegacyRecord,
} from '../index';

function makeDeps(): CommandDeps {
  let n = 0;
  return {
    now: () => `2026-09-30T0${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}:00.000Z`,
    eventId: () => `EVT-${++n}`,
    memoryId: () => `MEM-${++n}`,
  };
}

const baseInput = (p: Partial<ObservationInput> = {}): ObservationInput => ({
  location: '档案馆三号库',
  source_guess: '旧纸张',
  humidity: 5,
  season: 'autumn',
  smell_type: 'musty',
  memory_text: '',
  color_association: '#8B7355',
  emotion: 'peaceful',
  want_again: true,
  archivist: '林档案员',
  sniffKey: 'SK-1',
  sampledAt: '2026-06-01T08:00:00.000Z',
  rawIntensity: 6,
  ...p,
});

function legacy(legacyId: string, intensity = 6, createdAt = '2026-03-01T08:00:00.000Z'): LegacyRecord {
  const { archivist: _a, sniffKey: _s, sampledAt: _t, rawIntensity: _raw, ...narrative } = baseInput({
    location: `旧库-${legacyId}`,
    rawIntensity: intensity,
  });
  void _a; void _s; void _t; void _raw;
  return { ...narrative, legacyId, intensity, createdAt, archivist: '林档案员' };
}

describe('原始读数：只追加、重算驱动卡片与排行', () => {
  test('未校准时卡片强度=原始读数，校准迟到后排行随之重算', () => {
    let events: LedgerEvent[] = [];
    const deps = makeDeps();

    // 两次闻样：obs-A 原始 5（较晚采样），obs-B 原始 6（较早采样）
    let r = recordObservation(
      events,
      baseInput({ sniffKey: 'SK-A', sampledAt: '2026-06-10T08:00:00.000Z', rawIntensity: 5 }),
      deps,
    );
    assert.equal(r.result.ok, true);
    events = r.events;
    r = recordObservation(
      events,
      baseInput({ sniffKey: 'SK-B', sampledAt: '2026-05-01T08:00:00.000Z', rawIntensity: 6 }),
      deps,
    );
    events = r.events;

    let p = replay(events);
    let ranked = [...liveMemories(p)].sort((a, b) => b.intensity - a.intensity);
    assert.equal(ranked[0].sniffKey, 'SK-B'); // 6 > 5
    for (const m of liveMemories(p)) assert.equal(m.calibration.status, 'uncalibrated');

    // 基线迟到：林档案员标准真值 10、实测 8（变钝）→ 因子 1.25，
    // 仅对 6 月 1 日之后采样的 obs-A 生效
    const cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 8, validFrom: '2026-06-01T00:00:00.000Z' },
      deps,
    );
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;

    p = replay(events);
    const a = p.memories.find((m) => m.sniffKey === 'SK-A')!;
    const b = p.memories.find((m) => m.sniffKey === 'SK-B')!;
    assert.equal(a.calibration.status, 'calibrated');
    assert.equal(a.intensity, 6.3); // 5 * 1.25 = 6.25，保留一位小数
    assert.equal(a.rawIntensity, 5); // 原始读数未被改写
    assert.equal(b.calibration.status, 'uncalibrated');
    assert.equal(b.intensity, 6);

    // 排行一起重算：obs-A 反超
    ranked = [...liveMemories(p)].sort((x, y) => y.intensity - x.intensity);
    assert.equal(ranked[0].sniffKey, 'SK-A');
  });

  test('校准只按采样时刻定有效区间：开放区间被新基线截断', () => {
    let events: LedgerEvent[] = [];
    const deps = makeDeps();
    const t1 = '2026-04-01T08:00:00.000Z';
    const t2 = '2026-07-01T08:00:00.000Z';
    const t3 = '2026-08-01T08:00:00.000Z';

    let r = recordObservation(events, baseInput({ sniffKey: 'SK-1', sampledAt: t1, rawIntensity: 8 }), deps);
    events = r.events;
    r = recordObservation(events, baseInput({ sniffKey: 'SK-2', sampledAt: t3, rawIntensity: 8 }), deps);
    events = r.events;

    let cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 8, validFrom: '2026-01-01T00:00:00.000Z' },
      deps,
    );
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;

    // 新基线从 7 月起生效，自动截断旧开放区间
    cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 10, validFrom: t2 },
      deps,
    );
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;

    const p = replay(events);
    const [b1, b2] = p.baselines;
    assert.equal(b1.validTo, t2);
    assert.equal(b2.validTo, null);

    const m1 = p.memories.find((m) => m.sniffKey === 'SK-1')!;
    const m2 = p.memories.find((m) => m.sniffKey === 'SK-2')!;
    assert.equal(m1.intensity, 10); // 8 * 1.25
    assert.equal(m2.intensity, 8); // 8 * 1.0
  });

  test('开放基线完全重叠、闭合区间相交均被拒绝；撤回后可补录，拒绝不留账', () => {
    let events: LedgerEvent[] = [];
    const deps = makeDeps();
    const jan = '2026-01-01T00:00:00.000Z';
    const jul = '2026-07-01T00:00:00.000Z';
    const mar = '2026-03-01T00:00:00.000Z';

    let cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 8, validFrom: jan },
      deps,
    );
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;
    const before = events.length;

    // 同起点开放区间：完全重叠，拒绝且不留账
    cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 6, validFrom: jan },
      deps,
    );
    assert.equal(cal.ok, false);
    assert.equal(events.length, before);

    // 7 月新基线合法地截断 1 月开放区间 -> [1月,7月) + [7月,∞)
    cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 5, validFrom: jul },
      deps,
    );
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;

    // 此时补 3 月开放区间：与闭合区间 [1月,7月) 相交，拒绝
    cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 6, validFrom: mar },
      deps,
    );
    assert.equal(cal.ok, false);
    assert.equal(events.length, before + 1);

    // 撤回两条旧基线后补录 3 月即合法（撤回基线不参与重叠检查）
    const ids = replay(events).baselines.map((b) => b.id);
    for (const id of ids) {
      const w = withdrawCalibration(events, id, '标准样瓶贴错', deps);
      assert.equal(w.ok, true);
      if (!w.ok) return;
      events = w.events;
    }

    cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 6, validFrom: mar },
      deps,
    );
    assert.equal(cal.ok, true);
  });
});

describe('基线撤回：旧结论失效，卡片与筛选一起重算', () => {
  test('撤回后受影响观测变为已失效并回退原始读数', () => {
    let events: LedgerEvent[] = [];
    const deps = makeDeps();

    const r = recordObservation(
      events,
      baseInput({ sniffKey: 'SK-X', sampledAt: '2026-06-15T08:00:00.000Z', rawIntensity: 4 }),
      deps,
    );
    events = r.events;

    const cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 5, validFrom: '2026-06-01T00:00:00.000Z' },
      deps,
    );
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;

    let p = replay(events);
    let m = p.memories[0];
    assert.equal(m.intensity, 8); // 4 * 2
    assert.equal(m.calibration.status, 'calibrated');
    const baselineId = m.calibration.baselineId!;

    const w = withdrawCalibration(events, baselineId, '当天标准样被污染', deps);
    assert.equal(w.ok, true);
    if (!w.ok) return;
    events = w.events;

    p = replay(events);
    m = p.memories[0];
    assert.equal(m.calibration.status, 'invalidated');
    assert.equal(m.calibration.calibratedIntensity, null);
    assert.equal(m.intensity, 4); // 旧校准结论不再参与排行/筛选
    assert.equal(m.intensityBasis, 'raw-invalidated');

    // 按「已校准」筛选时该卡片被剔除
    const calibratedOnly = liveMemories(p).filter((x) => x.calibration.status === 'calibrated');
    assert.equal(calibratedOnly.length, 0);
  });

  test('基线按档案员隔离：A 的撤回不影响 B', () => {
    let events: LedgerEvent[] = [];
    const deps = makeDeps();

    let r = recordObservation(events, baseInput({ archivist: 'A', sniffKey: 'KA' }), deps);
    events = r.events;
    r = recordObservation(events, baseInput({ archivist: 'B', sniffKey: 'KB' }), deps);
    events = r.events;

    let cal = registerCalibration(events, { archivist: 'A', standardReading: 10, observedReading: 5, validFrom: '2026-01-01T00:00:00.000Z' }, deps);
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;
    cal = registerCalibration(events, { archivist: 'B', standardReading: 10, observedReading: 5, validFrom: '2026-01-01T00:00:00.000Z' }, deps);
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;

    const baselineA = replay(events).baselines.find((b) => b.archivist === 'A')!;
    const w = withdrawCalibration(events, baselineA.id, '撤销', deps);
    assert.equal(w.ok, true);
    if (!w.ok) return;
    events = w.events;

    const p = replay(events);
    assert.equal(p.memories.find((m) => m.archivist === 'A')!.calibration.status, 'invalidated');
    assert.equal(p.memories.find((m) => m.archivist === 'B')!.calibration.status, 'calibrated');
  });
});

describe('两位档案员同时保存同一次闻样', () => {
  test('只留一份原始读数，后到者看到冲突与来源；再多一次也只追加冲突', () => {
    let events: LedgerEvent[] = [];
    const deps = makeDeps();
    const sniffKey = makeSniffKey('2026-06-10T09:00:00.000Z', '樟木柜');

    const first = recordObservation(
      events,
      baseInput({ archivist: '林档案员', sniffKey, location: '樟木柜', rawIntensity: 7 }),
      deps,
    );
    assert.equal(first.result.ok, true);
    events = first.events;
    const winnerEventId = events.find((e) => e.type === 'observation.recorded')!.eventId;

    // 几乎同时，第二位档案员保存同一批闻样（读数还更钝）
    const late = recordObservation(
      events,
      baseInput({ archivist: '周档案员', sniffKey, location: '樟木柜', rawIntensity: 5 }),
      deps,
    );
    assert.equal(late.result.ok, false);
    if (late.result.ok) return;
    assert.equal(late.result.kind, 'conflict');
    assert.equal(late.result.conflict.winnerArchivist, '林档案员');
    assert.equal(late.result.conflict.winnerEventId, winnerEventId);
    assert.equal(late.result.conflict.winnerRawIntensity, 7);
    events = late.events; // 冲突审计事件入账，但无第二份原始读数

    // 第三位再次保存
    const third = recordObservation(
      events,
      baseInput({ archivist: '陈档案员', sniffKey, location: '樟木柜', rawIntensity: 6 }),
      deps,
    );
    assert.equal(third.result.ok, false);
    events = third.events;

    const p = replay(events);
    assert.equal(p.observationCount, 1); // 只有一份原始读数
    const mem = p.memories[0];
    assert.equal(mem.rawIntensity, 7);
    assert.deepEqual(
      mem.conflicts.map((c) => c.archivist),
      ['周档案员', '陈档案员'],
    );
    assert.deepEqual(
      mem.conflicts.map((c) => c.claimedIntensity),
      [5, 6],
    );
    assert.equal(mem.conflicts[0].eventId, events.find((e) => e.type === 'observation.conflict_reported')!.eventId);
  });
});

describe('旧数据迁移：无观测号 → 单次观测，中断可继续，失败不留半成品', () => {
  test('迁移到一半中断，继续后完成；迁移得到观测号且为 legacy 来源', () => {
    const records = [legacy('OLD-1'), legacy('OLD-2', 3), legacy('OLD-3', 9)];
    let queue = createQueue(records);
    let events: LedgerEvent[] = [];
    const deps = makeDeps();

    // 处理一条后「断电」
    let run = runMigration(queue, events, 1, deps);
    assert.equal(run.processed, true);
    events = run.events;
    queue = run.queue;
    assert.equal(queue.finished, false);
    assert.equal(replay(events).observationCount, 1);
    const first = replay(events).memories[0];
    assert.equal(first.source, 'legacy');
    assert.equal(first.observationId, 'OBS-000001');

    // 继续迁移，跑到底
    run = runMigration(queue, events, Number.POSITIVE_INFINITY, deps);
    events = run.events;
    queue = run.queue;
    assert.equal(queue.finished, true);
    assert.equal(replay(events).observationCount, 3);
    assert.deepEqual(
      replay(events).memories.map((m) => m.observationId).sort(),
      ['OBS-000001', 'OBS-000002', 'OBS-000003'],
    );

    // 重新对同一批旧数据建队：全部判重跳过，不产生新观测（幂等可继续）
    const rerun = runMigration(createQueue(records), events, Number.POSITIVE_INFINITY, deps);
    assert.equal(rerun.queue.finished, true);
    assert.equal(rerun.queue.jobs.filter((j) => j.migrated).length, 0);
    assert.equal(rerun.events.length, events.length);
  });

  test('某条迁移失败时停在原处，事件流不增加半成品；修正后继续', () => {
    const bad = legacy('OLD-BAD', 0); // 强度越界
    const good = legacy('OLD-GOOD', 5);
    let queue = createQueue([good, bad]);
    let events: LedgerEvent[] = [];
    const deps = makeDeps();

    let run = runMigration(queue, events, Number.POSITIVE_INFINITY, deps);
    events = run.events;
    queue = run.queue;
    assert.equal(queue.finished, false);
    assert.equal((run.queue.lastError ?? "").includes('强度越界'), true);
    const recorded = replay(events).observationCount;
    assert.equal(recorded, 1); // good 已落账，bad 未留下任何事件

    // 再跑一次仍然失败、不新增
    run = runMigration(queue, events, Number.POSITIVE_INFINITY, deps);
    assert.equal((run.queue.lastError ?? "").includes('强度越界'), true);
    assert.equal(replay(run.events).observationCount, 1);
    events = run.events;
    queue = run.queue;

    // 修正数据（例如清洗后）继续
    queue = { ...queue, jobs: queue.jobs.map((j) => (j.legacy.legacyId === 'OLD-BAD' ? { ...j, legacy: legacy('OLD-BAD', 4) } : j)) };
    run = runMigration(queue, events, Number.POSITIVE_INFINITY, deps);
    assert.equal(run.queue.finished, true);
    assert.equal(replay(run.events).observationCount, 2);
  });
});

describe('叙述修订与废弃：原始读数不可改，投影可确定性重算', () => {
  test('amend 只改叙述；改采样时刻会触发校准重算；discard 是墓碑', () => {
    let events: LedgerEvent[] = [];
    const deps = makeDeps();

    const r = recordObservation(
      events,
      baseInput({ sniffKey: 'SK-E', sampledAt: '2026-05-01T08:00:00.000Z', rawIntensity: 4 }),
      deps,
    );
    events = r.events;
    const memoryId = (r.result as { memoryId: string }).memoryId;

    let am = amendMemory(events, memoryId, '林档案员', { location: '新地点' }, deps);
    assert.equal(am.ok, true);
    if (!am.ok) return;
    events = am.events;

    // 补一条 6 月生效基线；观测仍在 5 月，未校准
    const cal = registerCalibration(
      events,
      { archivist: '林档案员', standardReading: 10, observedReading: 5, validFrom: '2026-06-01T00:00:00.000Z' },
      deps,
    );
    assert.equal(cal.ok, true);
    if (!cal.ok) return;
    events = cal.events;

    // 把采样时刻修正进基线窗口 -> 卡片随之变为已校准（重算受影响观测）
    am = amendMemory(events, memoryId, '林档案员', { sampledAt: '2026-06-15T08:00:00.000Z' }, deps);
    assert.equal(am.ok, true);
    if (!am.ok) return;
    events = am.events;

    let p = replay(events);
    const m = p.memories[0];
    assert.equal(m.location, '新地点');
    assert.equal(m.rawIntensity, 4); // 原始读数仍未动
    assert.equal(m.intensity, 8); // 4 * 2
    assert.equal(m.calibration.status, 'calibrated');

    // 确定性：同一事件流重放结果一致
    assert.deepEqual(replay(events), p);

    const d = discardMemory(events, memoryId, '林档案员', '重复归档', deps);
    assert.equal(d.ok, true);
    if (!d.ok) return;
    events = d.events;
    p = replay(events);
    assert.equal(p.memories[0].discarded, true);
    assert.equal(liveMemories(p).length, 0); // 卡片/筛选/排行中消失，原始事件仍在账上
  });

  test('非法命令被整体拒绝，事件流与投影不变', () => {
    const deps = makeDeps();
    const events: LedgerEvent[] = [];

    const bad = recordObservation(events, baseInput({ rawIntensity: 99 }), deps);
    assert.equal(bad.result.ok, false);
    assert.equal(bad.events.length, 0);

    const am = amendMemory(events, 'MEM-NOPE', '林档案员', { location: 'x' }, deps);
    assert.equal(am.ok, false);

    const w = withdrawCalibration(events, 'CAL-NOPE', '原因', deps);
    assert.equal(w.ok, false);

    // 重算抛错时原子提交回滚：脏候选事件不入账，事件流原样
    const before = events.length;
    const dirty = commitEvents(events, [null as unknown as LedgerEvent]);
    assert.equal(dirty.ok, false);
    assert.match(dirty.ok ? '' : dirty.error, /重算失败/);
    assert.equal(events.length, before);
  });
});

describe('v0/v1 持久化升级：没有观测号的旧记忆 -> 迁移队列', () => {
  test('旧 memories 映射为 legacy 作业，经迁移得到观测号；空存储给空队列', async () => {
    const { migrateLegacyState } = await import('../index');

    const upgraded = migrateLegacyState({
      memories: [
        {
          id: 'm-1', location: '老屋', source_guess: '煤炉', intensity: 8, humidity: 4,
          season: 'winter', smell_type: 'burnt', memory_text: '冷', color_association: '#4A3728',
          emotion: 'warm', want_again: true, created_at: '2024-12-01T08:00:00.000Z',
        },
        { location: '无 id 旧档', intensity: 3, created_at: '2024-11-01T08:00:00.000Z' },
      ],
    });
    assert.equal(upgraded.migrationQueue.jobs.length, 2);
    assert.equal(upgraded.migrationQueue.jobs[0].legacy.legacyId, 'm-1');
    assert.equal(upgraded.migrationQueue.jobs[0].legacy.smell_type, 'burnt');
    assert.equal(typeof upgraded.migrationQueue.jobs[1].legacy.legacyId, 'string'); // 缺 id 自动补

    const run = runMigration(upgraded.migrationQueue, upgraded.events, Number.POSITIVE_INFINITY, makeDeps());
    assert.equal(run.queue.finished, true);
    assert.deepEqual(
      run.projection.memories.map((m) => m.observationId).sort(),
      ['OBS-000001', 'OBS-000002'],
    );
    assert.equal(run.projection.memories.every((m) => m.source === 'legacy'), true);

    assert.deepEqual(migrateLegacyState(null).migrationQueue.jobs, []);
    assert.deepEqual(migrateLegacyState({}).migrationQueue.jobs, []);
  });
});
