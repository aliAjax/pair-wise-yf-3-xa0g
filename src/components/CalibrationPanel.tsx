import { useState } from 'react';
import { FlaskConical, Ban, Plus, History } from 'lucide-react';
import { useLedgerStore } from '../store/memoryStore';
import { useProjection } from '../hooks/useProjection';
import { formatDate, toLocalInput } from '../utils/helpers';

interface Props {
  archivist: string;
}

/**
 * 校准基线台账：按档案员过滤，按采样时刻定有效区间。
 * 登记/撤回都会让事件流追加事实，卡片、筛选、排行随之整体重算。
 */
export default function CalibrationPanel({ archivist }: Props) {
  const { addCalibration, withdrawCalibration } = useLedgerStore();
  const projection = useProjection();
  const [standard, setStandard] = useState(10);
  const [observed, setObserved] = useState(8);
  const [fromLocal, setFromLocal] = useState(toLocalInput(new Date().toISOString()));
  const [open, setOpen] = useState(false);

  const baselines = projection.baselines
    .filter((b) => b.archivist === archivist)
    .slice()
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1));

  const factor = observed > 0 ? standard / observed : 1;

  const submit = () => {
    const ok = addCalibration({
      standardReading: standard,
      observedReading: observed,
      validFrom: new Date(fromLocal).toISOString(),
    });
    if (ok.ok) {
      setObserved(8);
      setOpen(false);
    }
  };

  return (
    <section className="container max-w-6xl mb-6">
      <div className="bg-paper-50/70 backdrop-blur rounded-2xl border border-paper-300 p-4 md:p-5 shadow-paper">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-moss-600" />
            <span className="font-hand text-xl text-moss-600">{archivist} 的校准基线</span>
            <span className="text-xs text-ink-700/50">
              · 按采样时刻生效，登记/撤回都会重算受影响观测
            </span>
          </div>
          <button
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium bg-moss-600 hover:bg-moss-700 text-paper-50 transition-all"
          >
            <Plus className="w-4 h-4" /> 登记基线
          </button>
        </div>

        {open && (
          <div className="mt-4 p-4 rounded-xl bg-moss-100/40 border border-moss-200 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">标准样真值</label>
              <input
                type="number" min={1} max={10} step={1}
                value={standard}
                onChange={(e) => setStandard(Number(e.target.value))}
                className="scent-input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">你闻标准样的读数</label>
              <input
                type="number" min={1} max={10} step={1}
                value={observed}
                onChange={(e) => setObserved(Number(e.target.value))}
                className="scent-input"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">生效起始采样时刻</label>
              <input
                type="datetime-local"
                value={fromLocal}
                onChange={(e) => setFromLocal(e.target.value)}
                className="scent-input"
              />
            </div>
            <button onClick={submit} className="btn-primary py-2.5">
              登记并重算（因子 {factor.toFixed(2)}×）
            </button>
            <p className="md:col-span-4 text-[11px] text-ink-700/55">
              连续闻样后鼻子变钝时读数会偏小（如真值 10 闻到 8 → 因子 1.25）。新基线会自动截断该档案员此前的开放区间；
              与已闭合区间重叠会被拒绝，需先撤回旧基线。
            </p>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {baselines.length === 0 ? (
            <div className="text-sm text-ink-700/45 py-3 flex items-center gap-2">
              <History className="w-4 h-4" />
              暂无基线 —— 该档案员的观测目前按原始读数展示
            </div>
          ) : (
            baselines.map((b) => (
              <div
                key={b.id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 rounded-xl border text-sm ${
                  b.status === 'withdrawn'
                    ? 'bg-paper-100/60 border-paper-200 opacity-70'
                    : 'bg-paper-100/70 border-paper-200'
                }`}
              >
                <span className="font-mono text-[12px] font-semibold text-ink-800">{b.id}</span>
                <span className="text-ink-700">
                  真值 {b.standardReading} / 读数 {b.observedReading}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-moss-100 text-moss-600 text-xs font-semibold">
                  因子 {b.factor}×
                </span>
                <span className="text-[12px] text-ink-700/60">
                  {formatDate(b.validFrom)} → {b.validTo ? formatDate(b.validTo) : '至今'}
                </span>
                {b.status === 'withdrawn' ? (
                  <span className="inline-flex items-center gap-1 text-[12px] text-brick-500">
                    <Ban className="w-3.5 h-3.5" />
                    已撤回：{b.withdrawReason}
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      const reason = window.prompt('撤回原因？撤回后受影响观测的旧校准结论立即失效');
                      if (reason?.trim()) withdrawCalibration(b.id, reason.trim());
                    }}
                    className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-brick-500 hover:bg-brick-500/10 transition-colors"
                  >
                    <Ban className="w-3.5 h-3.5" /> 撤回
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
