import { useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import FilterPanel from '../components/FilterPanel';
import VisualizationPanel from '../components/VisualizationPanel';
import CalibrationPanel from '../components/CalibrationPanel';
import MemoryCard from '../components/MemoryCard';
import MemoryModal from '../components/MemoryModal';
import { useLedgerStore, type ObservationForm } from '../store/memoryStore';
import { useProjection } from '../hooks/useProjection';
import type { Filters } from '../utils/helpers';
import { filterMemories } from '../utils/helpers';
import { makeSniffKey } from '../ledger';
import type { MemoryView } from '../ledger/types';
import { BookOpenCheck, CheckCircle2, AlertTriangle, CopyX, Play } from 'lucide-react';
import { queueProgress } from '../ledger/migration';

const defaultFilters: Filters = {
  smellType: '',
  season: '',
  emotion: '',
  calibration: '',
};

export default function Home() {
  const {
    ensureMigrated,
    continueMigration,
    migrationQueue,
    currentArchivist,
    setArchivist,
    record,
    amend,
    discard,
    notice,
    clearNotice,
  } = useLedgerStore();
  const projection = useProjection();
  const memories = useMemo(
    () => projection.memories.filter((m) => !m.discarded),
    [projection],
  );

  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MemoryView | null>(null);

  useEffect(() => {
    ensureMigrated();
  }, [ensureMigrated]);

  const filteredMemories = useMemo(
    () => filterMemories(memories, filters),
    [memories, filters],
  );
  const progress = queueProgress(migrationQueue);

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };
  const resetFilters = () => setFilters(defaultFilters);

  const openAddModal = () => { setEditing(null); setModalOpen(true); };
  const openEditModal = (m: MemoryView) => { setEditing(m); setModalOpen(true); };

  const handleAdd = (form: ObservationForm) => {
    // 闻样批次号由「采样时刻 + 地点」决定：另一位档案员保存同一批闻样会命中去重
    const sniffKey = makeSniffKey(form.sampledAt, form.location);
    record(form, sniffKey);
  };

  const handleEdit = (memory: MemoryView, patch: Partial<ObservationForm>) => {
    amend(memory, patch);
  };

  const handleDelete = (m: MemoryView) => {
    const msg = `确认废弃「${m.location}」吗？\n原始读数仍保留在账上（可追溯），卡片、筛选与排行中将不再显示。`;
    if (window.confirm(msg)) {
      discard(m.id, '手动废弃');
      if (expandedId === m.id) setExpandedId(null);
    }
  };

  const scrollToCard = (id: string) => {
    setExpandedId(id);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-memory-id="${id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const hasFilter = filters.smellType || filters.season || filters.emotion || filters.calibration;

  return (
    <div className="min-h-screen">
      <Header
        onAdd={openAddModal}
        memoryCount={memories.length}
        archivist={currentArchivist}
        onArchivistChange={setArchivist}
      />

      <main className="container max-w-6xl pb-20">
        {/* 迁移状态（中断可继续） */}
        {!migrationQueue.finished && (
          <div className="mb-5 flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl bg-brick-400/10 border border-brick-400/30 text-sm">
            <AlertTriangle className="w-4 h-4 text-brick-500 shrink-0" />
            <span className="text-brick-600">
              旧档迁移中断：{progress.done}/{progress.total}，卡在「{migrationQueue.jobs.find((j) => !j.done)?.legacy.location}」
              {migrationQueue.lastError ? `（${migrationQueue.lastError}）` : ''}
            </span>
            <button
              onClick={continueMigration}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brick-500 hover:bg-brick-600 text-paper-50 text-xs font-medium ml-auto"
            >
              <Play className="w-3.5 h-3.5" /> 继续迁移
            </button>
          </div>
        )}

        {/* 命令回执：成功 / 冲突与来源 / 失败 */}
        {notice && (
          <div
            className={`mb-5 flex items-start gap-3 px-4 py-3 rounded-2xl border text-sm animate-fadeInUp ${
              notice.kind === 'ok'
                ? 'bg-moss-100/60 border-moss-200 text-moss-700'
                : notice.kind === 'conflict'
                  ? 'bg-brick-400/10 border-brick-400/30 text-brick-600'
                  : 'bg-brick-400/10 border-brick-400/30 text-brick-600'
            }`}
          >
            {notice.kind === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <CopyX className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <div className="flex-1">
              <div>{notice.text}</div>
              {notice.detail && (
                <div className="mt-1 text-[12px] text-ink-700/65 font-mono">
                  来源事件 {notice.detail.winnerEventId} · 先到入账 {new Date(notice.detail.winnerRecordedAt).toLocaleString()} · 批次 {notice.detail.sniffKey}
                </div>
              )}
            </div>
            <button onClick={clearNotice} className="text-xs underline opacity-70 hover:opacity-100 shrink-0">
              知道了
            </button>
          </div>
        )}

        <FilterPanel
          filters={filters}
          onChange={handleFilterChange}
          onReset={resetFilters}
          resultCount={filteredMemories.length}
        />

        <CalibrationPanel archivist={currentArchivist} />

        <VisualizationPanel memories={filteredMemories} onSelect={scrollToCard} />

        <section className="mt-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-hand text-2xl text-ochre-600 flex items-center gap-2">
              <BookOpenCheck className="w-5 h-5" />
              气味档案
            </h2>
            <span className="text-xs text-ink-700/50">
              强度取自重算投影；点击卡片查看原始读数与基线来源
            </span>
          </div>

          {filteredMemories.length === 0 ? (
            <div className="bg-paper-50/70 backdrop-blur rounded-3xl border-2 border-dashed border-paper-400 py-20 text-center">
              <div className="text-6xl mb-4 select-none">🍂</div>
              <h3 className="font-serif text-2xl text-ink-800 mb-2">
                {hasFilter ? '没有匹配的气味记忆' : '还没有封存任何气味'}
              </h3>
              <p className="text-ink-700/60 max-w-md mx-auto mb-6">
                {hasFilter
                  ? '换一组筛选条件试试？或者先登记一次闻样'
                  : '空气中一定有让你难忘的味道——原始读数先入账，鼻子变钝了也能事后校准'}
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <button onClick={openAddModal} className="btn-primary">
                  登记第一次闻样
                </button>
                {hasFilter && (
                  <button onClick={resetFilters} className="btn-secondary">
                    清除筛选条件
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="masonry-grid">
              {filteredMemories.map((m, idx) => (
                <div key={m.id} data-memory-id={m.id}>
                  <MemoryCard
                    memory={m}
                    index={idx}
                    isExpanded={expandedId === m.id}
                    onToggle={() => setExpandedId(expandedId === m.id ? null : m.id)}
                    onEdit={() => openEditModal(m)}
                    onDelete={() => handleDelete(m)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="pb-10 pt-4 text-center text-xs text-ink-700/40 font-hand text-lg">
        <p>原始读数只追加 · 基线按采样时刻重算 · 一切结论可追溯 · Scent Ledger</p>
      </footer>

      <MemoryModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        archivist={currentArchivist}
        editingData={editing}
        onAdd={handleAdd}
        onEdit={handleEdit}
      />
    </div>
  );
}
