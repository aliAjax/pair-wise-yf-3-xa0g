import { Plus, UserRound } from 'lucide-react';

interface Props {
  onAdd: () => void;
  memoryCount: number;
  archivist: string;
  onArchivistChange: (name: string) => void;
}

export default function Header({ onAdd, memoryCount, archivist, onArchivistChange }: Props) {
  return (
    <header className="relative pt-14 pb-8 md:pt-20 md:pb-12">
      <div className="container max-w-6xl">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <div className="relative">
            <div className="absolute -left-2 -top-8 text-7xl md:text-8xl opacity-10 select-none pointer-events-none font-serif text-ochre-500">
              味
            </div>
            <h1 className="font-serif text-4xl md:text-6xl font-bold text-ink-800 leading-tight relative z-10">
              旧房间
              <span className="text-ochre-500">气味</span>
              记忆库
            </h1>
            <p className="mt-3 font-hand text-lg md:text-xl text-ink-700/70 pl-1 relative z-10">
              原始读数只追加，校准基线按采样时刻重算 —— 可追溯的嗅觉账
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3 pl-1">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-paper-200/80 text-ink-700/80 text-sm border border-paper-300">
                <span className="text-base">📚</span>
                在档 <b className="text-ochre-600 font-semibold">{memoryCount}</b> 次观测
              </span>
              <label className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-moss-100 text-moss-600 text-sm border border-moss-200 cursor-pointer">
                <UserRound className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">当前档案员</span>
                <input
                  value={archivist}
                  onChange={(e) => onArchivistChange(e.target.value)}
                  className="bg-transparent outline-none font-semibold w-24 placeholder:text-moss-600/50"
                  placeholder="档案员"
                />
              </label>
            </div>
          </div>
          <button
            onClick={onAdd}
            className="group relative inline-flex items-center justify-center gap-2 bg-ochre-500 hover:bg-ochre-600 active:bg-ochre-700 text-paper-50 font-medium rounded-2xl px-6 py-3.5 shadow-paper hover:shadow-paper-hover hover:-translate-y-1 transition-all duration-250 self-start md:self-auto"
          >
            <span className="absolute inset-0 rounded-2xl opacity-20"
              style={{ background: 'radial-gradient(circle at 20% 20%, #fff 0%, transparent 60%)' }} />
            <Plus className="w-5 h-5 transition-transform duration-300 group-hover:rotate-90" strokeWidth={2.5} />
            <span className="font-serif text-lg">登记闻样</span>
          </button>
        </div>
        <div className="mt-8 h-px w-full" style={{ background: 'linear-gradient(90deg, transparent 0%, #CBB993 20%, #CBB993 80%, transparent 100%)' }} />
      </div>
    </header>
  );
}
