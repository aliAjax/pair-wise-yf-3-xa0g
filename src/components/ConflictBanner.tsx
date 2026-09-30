import { AlertTriangle, X, UserCheck, Save } from 'lucide-react';
import type { ConflictState } from '../store/memoryStore';
import { formatDate } from '../utils/helpers';

interface Props {
  conflict: ConflictState;
  location: string;
  onDismiss: () => void;
  onForceOverwrite: () => void;
}

/**
 * 并发保存冲突横幅。
 * 后到的档案员保存同一次闻样时，标准读数已被他人抢先落账——
 * 这里展示胜出者的来源（谁、何时、读数），并让后到者选择采用或覆盖。
 */
export default function ConflictBanner({ conflict, location, onDismiss, onForceOverwrite }: Props) {
  const { winner, yourReading } = conflict;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] w-[min(92vw,560px)] animate-slideDown">
      <div className="rounded-2xl border border-brick-400/40 bg-paper-50/95 backdrop-blur shadow-paper-hover p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 shrink-0 rounded-xl bg-brick-400/15 text-brick-600 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-serif text-base font-semibold text-ink-800">
              保存冲突 · 「{location}」
            </h4>
            <p className="text-sm text-ink-700/80 mt-1 leading-relaxed">
              档案员 <b className="text-ink-800">{winner.observer}</b> 已于{' '}
              <b>{formatDate(winner.savedAt)}</b> 保存了同一次闻样
              （强度 <b className="text-ochre-600">{winner.intensity}</b>），
              以 TA 的读数为准，只保留这一份原始读数。
            </p>
            <p className="text-xs text-ink-700/60 mt-1">
              你的读数（强度 {yourReading.intensity}）已记入台账备查，但未成为标准读数。
            </p>
            <div className="flex items-center gap-2 mt-3">
              <button onClick={onDismiss} className="btn-primary !py-2 !px-4 text-sm inline-flex items-center gap-1.5">
                <UserCheck className="w-4 h-4" /> 采用 TA 的读数
              </button>
              <button onClick={onForceOverwrite} className="btn-secondary !py-2 !px-4 text-sm inline-flex items-center gap-1.5">
                <Save className="w-4 h-4" /> 我仍要覆盖
              </button>
            </div>
          </div>
          <button
            onClick={onDismiss}
            className="p-1.5 rounded-lg text-ink-700/50 hover:bg-paper-200 transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
