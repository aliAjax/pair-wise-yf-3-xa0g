import { useState } from 'react';
import { X, Scale, History, RefreshCw, UserCog, GitBranch, Zap } from 'lucide-react';
import { useMemoryStore } from '../store/memoryStore';
import type { CalibrationInput } from '../store/memoryStore';
import type { Calibration, SmellMemory } from '../lib/ledger/types';
import { formatDate } from '../utils/helpers';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/* 日期输入 <-> ISO（按天取边界） */
function dateToISO(dateStr: string, endOfDay = false): string | null {
  if (!dateStr) return null;
  return new Date(dateStr + (endOfDay ? 'T23:59:59.999' : 'T00:00:00')).toISOString();
}
function isoToDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

function affectedCount(cal: Calibration, memories: SmellMemory[]): number {
  return memories.filter((m) => {
    if (!m.sampled_at) return false;
    const t = m.sampled_at;
    const after = cal.validFrom === null || cal.validFrom <= t;
    const before = cal.validTo === null || t < cal.validTo;
    return after && before;
  }).length;
}

const inputCls =
  'w-full rounded-xl border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-ochre-400';

export default function LedgerPanel({ isOpen, onClose }: Props) {
  const {
    memories, calibrations, observer, migration, rollbackError,
    setObserver, addCalibration, withdrawCalibration, simulateConflict, recomputeNow,
  } = useMemoryStore();

  const [nameInput, setNameInput] = useState(observer);
  const [form, setForm] = useState({
    reason: '', validFrom: '', validTo: '', intensityOffset: -2, humidityOffset: 0,
  });

  if (!isOpen) return null;

  const handleAdd = () => {
    const input: CalibrationInput = {
      validFrom: dateToISO(form.validFrom),
      validTo: dateToISO(form.validTo, true),
      intensityOffset: Number(form.intensityOffset) || 0,
      humidityOffset: Number(form.humidityOffset) || 0,
      reason: form.reason.trim() || undefined,
    };
    addCalibration(input);
    setForm({ reason: '', validFrom: '', validTo: '', intensityOffset: -2, humidityOffset: 0 });
  };

  const saveName = () => setObserver(nameInput.trim() || '档案员');

  return (
    <div className="fixed inset-0 z-50 flex items-start md:items-center justify-center p-4 pt-8 md:p-6 overflow-y-auto">
      <div className="absolute inset-0 bg-ink-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-paper-50 rounded-3xl shadow-2xl border border-paper-300 animate-slideDown">
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-paper-200 rounded-t-3xl bg-paper-50/95 backdrop-blur">
          <div>
            <h2 className="font-serif text-2xl font-bold text-ink-800 flex items-center gap-2">
              <Scale className="w-5 h-5 text-ochre-600" /> 校准与台账
            </h2>
            <p className="text-sm text-ink-700/60 mt-0.5 font-hand">
              原始读数只追加，校准按采样时刻生效，记忆是账本折叠出来的账
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl text-ink-700/60 hover:text-ink-800 hover:bg-paper-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-7 max-h-[70vh] overflow-y-auto">
          {/* 档案员 + 迁移状态 */}
          <section className="grid sm:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-paper-200 bg-paper-100/60 p-4">
              <h3 className="font-hand text-lg text-ochre-600 flex items-center gap-2 mb-2">
                <UserCog className="w-4 h-4" /> 档案员身份
              </h3>
              <div className="flex gap-2">
                <input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="你的名字"
                  className={inputCls}
                />
                <button onClick={saveName} className="btn-secondary !px-3 !py-2 text-sm">保存</button>
              </div>
              <p className="text-[11px] text-ink-700/55 mt-2">读数会记录是谁闻的；两人同时保存同一次闻样时，后到者能看到来源。</p>
            </div>
            <div className="rounded-2xl border border-paper-200 bg-paper-100/60 p-4">
              <h3 className="font-hand text-lg text-moss-600 flex items-center gap-2 mb-2">
                <GitBranch className="w-4 h-4" /> 旧数据迁移
              </h3>
              <p className="text-sm text-ink-800">
                已迁移 <b className="text-moss-600">{migration.migrated}</b> / {migration.total} 条
                <span className="text-ink-700/60">（每条迁移成单次观测）</span>
              </p>
              <p className="text-[11px] text-ink-700/55 mt-2">
                没有观测号的旧数据会在首次打开时自动补登成一次观测；中断后重跑会自动继续，不重复。
              </p>
            </div>
          </section>

          {/* 校准基线 */}
          <section>
            <h3 className="font-hand text-xl text-ochre-600 flex items-center gap-2 mb-3">
              <Scale className="w-4 h-4" /> 校准基线
            </h3>

            <div className="rounded-2xl border border-paper-200 bg-paper-100/60 p-4 mb-4 space-y-3">
              <input
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="基线说明（如：连续闻样后嗅觉疲劳，整体偏钝）"
                className={inputCls}
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <label className="text-xs text-ink-700/70">
                  生效起（采样时刻）
                  <input type="date" value={form.validFrom} onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))} className={`${inputCls} mt-1`} />
                </label>
                <label className="text-xs text-ink-700/70">
                  生效止（留空=长期）
                  <input type="date" value={form.validTo} onChange={(e) => setForm((f) => ({ ...f, validTo: e.target.value }))} className={`${inputCls} mt-1`} />
                </label>
                <label className="text-xs text-ink-700/70">
                  强度修正
                  <input type="number" min={-5} max={5} value={form.intensityOffset} onChange={(e) => setForm((f) => ({ ...f, intensityOffset: Number(e.target.value) }))} className={`${inputCls} mt-1`} />
                </label>
                <label className="text-xs text-ink-700/70">
                  湿度修正
                  <input type="number" min={-5} max={5} value={form.humidityOffset} onChange={(e) => setForm((f) => ({ ...f, humidityOffset: Number(e.target.value) }))} className={`${inputCls} mt-1`} />
                </label>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-ink-700/55">
                  修正量会加到命中区间的观测读数上（结果限制在 1-10）。基线可以迟到——补录的基线会回头修正区间内的历史观测。
                </p>
                <button onClick={handleAdd} className="btn-primary !py-2 !px-4 text-sm shrink-0">录入基线</button>
              </div>
            </div>

            <div className="space-y-2">
              {calibrations.length === 0 && (
                <p className="text-sm text-ink-700/50 text-center py-4">还没有校准基线。录入一条，区间内的观测会被修正。</p>
              )}
              {calibrations.map((c) => {
                const affected = affectedCount(c, memories);
                const late = c.validFrom !== null && c.recordedAt.slice(0, 10) > c.validFrom.slice(0, 10);
                return (
                  <div key={c.calibrationId} className="rounded-xl border border-paper-200 bg-paper-50 px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-ink-800 text-sm">{c.reason || '未命名基线'}</span>
                        {late && <span className="text-[10px] px-1.5 py-0.5 rounded bg-lavender-300/40 text-lavender-600">迟到</span>}
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-moss-100 text-moss-600">影响 {affected} 条</span>
                      </div>
                      <p className="text-[11px] text-ink-700/60 mt-1">
                        区间 {c.validFrom ? formatDate(c.validFrom) : '最早'} → {c.validTo ? formatDate(c.validTo) : '长期'}
                        {' · '}强度 {c.intensityOffset >= 0 ? '+' : ''}{c.intensityOffset}
                        {' / '}湿度 {c.humidityOffset >= 0 ? '+' : ''}{c.humidityOffset}
                      </p>
                    </div>
                    <button
                      onClick={() => withdrawCalibration(c.calibrationId)}
                      className="text-xs px-3 py-1.5 rounded-lg text-brick-600 hover:bg-brick-500/10 transition-colors shrink-0"
                    >
                      撤回
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 观测溯源 */}
          <section>
            <h3 className="font-hand text-xl text-ochre-600 flex items-center gap-2 mb-3">
              <History className="w-4 h-4" /> 观测溯源
            </h3>
            <div className="rounded-2xl border border-paper-200 bg-paper-100/60 divide-y divide-paper-200">
              {memories.map((m) => (
                <div key={m.id} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink-800 truncate">{m.location}</div>
                    <div className="text-[11px] text-ink-700/60 mt-0.5">
                      原始 <b className="text-ink-700">{m.raw_intensity ?? m.intensity}</b>
                      {m.calibration_id && <> → 校准后 <b className="text-ochre-600">{m.intensity}</b></>}
                      {' · '}{m.observer ?? '匿名'} · {m.sampled_at ? formatDate(m.sampled_at) : '—'}
                    </div>
                  </div>
                  <button
                    onClick={() => simulateConflict(m.id)}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg text-brick-600 hover:bg-brick-500/10 transition-colors shrink-0 inline-flex items-center gap-1"
                    title="模拟另一位档案员基于过期令牌保存，触发冲突"
                  >
                    <Zap className="w-3 h-3" /> 模拟并发
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* 重算 */}
          <section className="flex items-center justify-between rounded-2xl border border-paper-200 bg-paper-100/60 px-4 py-3">
            <div>
              <h3 className="font-hand text-lg text-ochre-600">手动重算</h3>
              <p className="text-[11px] text-ink-700/55">从账本重新折叠全部记忆。失败会回滚，不留半成品。</p>
            </div>
            <button onClick={recomputeNow} className="btn-secondary !py-2 !px-4 text-sm inline-flex items-center gap-1.5">
              <RefreshCw className="w-4 h-4" /> 重算
            </button>
          </section>

          {rollbackError && (
            <div className="rounded-xl border border-brick-400/40 bg-brick-500/10 px-4 py-3 text-sm text-brick-600">
              重算失败，已回滚：{rollbackError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
