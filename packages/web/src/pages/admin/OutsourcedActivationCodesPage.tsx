import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Archive, ChevronLeft, ChevronRight, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import { safeErrorMessage } from '../../utils/labels';
import { visiblePageNumbers } from '../../utils/pagination';

type CodeStatus = 'AVAILABLE' | 'EXHAUSTED' | 'CHECK_FAILED' | 'UNKNOWN';
type StatusFilter = 'all' | 'available' | 'exhausted' | 'error' | 'unknown';
type ArchiveScope = 'active' | 'archived' | 'all';

interface OutsourcedCodeItem {
  id: string;
  maskedCode: string;
  batchLabel: string | null;
  status: CodeStatus;
  lastRemaining: number | null;
  lastUsed: number | null;
  lastTotal: number | null;
  localSubmitCount: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  exhaustedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  orderCount: number;
}

interface CodeSummary {
  total: number;
  available: number;
  exhausted: number;
  unknown: number;
  checkFailed: number;
  totalRemaining: number;
  totalUsed: number | null;
  localSubmitCount: number;
}

interface FetchOptions {
  silent?: boolean;
}

const EMPTY_SUMMARY: CodeSummary = {
  total: 0,
  available: 0,
  exhausted: 0,
  unknown: 0,
  checkFailed: 0,
  totalRemaining: 0,
  totalUsed: null,
  localSubmitCount: 0,
};

export default function OutsourcedActivationCodesPage() {
  const [codes, setCodes] = useState<OutsourcedCodeItem[]>([]);
  const [summary, setSummary] = useState<CodeSummary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [archiveScope, setArchiveScope] = useState<ArchiveScope>('active');
  const [batchLabelFilter, setBatchLabelFilter] = useState('');
  const [search, setSearch] = useState('');
  const [codesText, setCodesText] = useState('');
  const [batchLabel, setBatchLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deletingUnused, setDeletingUnused] = useState(false);
  const [error, setError] = useState('');

  const fetchCodes = async (options: FetchOptions = {}) => {
    if (!options.silent) setLoading(true);
    try {
      const response = await api.get('/admin/outsourced-activation-codes', {
        params: currentParams(),
      });
      setCodes(response.data.codes);
      setSummary(response.data.summary ?? EMPTY_SUMMARY);
      setTotal(response.data.total);
      setError('');
    } catch {
      if (!options.silent) setError('外包兑换码列表加载失败');
    } finally {
      if (!options.silent) setLoading(false);
    }
  };

  useEffect(() => {
    void fetchCodes();
  }, [page, status, archiveScope, batchLabelFilter, search]);

  useAutoRefresh(() => fetchCodes({ silent: true }), AUTO_REFRESH_INTERVAL_MS);

  const handleImport = async () => {
    if (!codesText.trim()) {
      toast.error('请先输入外包兑换码');
      return;
    }
    setImporting(true);
    try {
      const response = await api.post('/admin/outsourced-activation-codes/import', {
        codesText: codesText.trim(),
        batchLabel: batchLabel || undefined,
      });
      toast.success(`已导入 ${response.data.importedCount ?? 0} 个，重复 ${response.data.duplicateCount ?? 0} 个`);
      setCodesText('');
      await fetchCodes();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '导入外包兑换码失败'));
    } finally {
      setImporting(false);
    }
  };

  const handleRefreshCurrent = async () => {
    setRefreshing(true);
    try {
      const response = await api.post('/admin/outsourced-activation-codes/refresh', currentFilters());
      toast.success(`已检测 ${response.data.checked ?? 0} 个，可用 ${response.data.available ?? 0} 个`);
      await fetchCodes();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '刷新外包兑换码状态失败'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleRefreshOne = async (id: string) => {
    try {
      await api.post(`/admin/outsourced-activation-codes/${id}/refresh`);
      toast.success('外包兑换码状态已刷新');
      await fetchCodes();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '刷新外包兑换码失败'));
    }
  };

  const handleArchive = async (id: string) => {
    if (!confirm('确认归档这个外包兑换码？归档后默认列表不再显示。')) return;
    try {
      await api.post(`/admin/outsourced-activation-codes/${id}/archive`);
      toast.success('外包兑换码已归档');
      await fetchCodes();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '归档外包兑换码失败'));
    }
  };

  const handleArchiveCurrent = async () => {
    if (!confirm('确认按当前筛选归档外包兑换码？归档后默认列表不再显示。')) return;
    setArchiving(true);
    try {
      const response = await api.post('/admin/outsourced-activation-codes/archive', currentFilters());
      toast.success(`已归档 ${response.data.archivedCount ?? 0} 个外包兑换码`);
      await fetchCodes();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '批量归档外包兑换码失败'));
    } finally {
      setArchiving(false);
    }
  };

  const handleDeleteUnusedCurrent = async () => {
    if (!confirm('确认按当前筛选删除未使用的外包兑换码？已提交过或关联订单的兑换码不会被删除。')) return;
    setDeletingUnused(true);
    try {
      const response = await api.post('/admin/outsourced-activation-codes/delete-unused', currentFilters());
      toast.success(`已删除 ${response.data.deletedCount ?? 0} 个未使用外包兑换码`);
      await fetchCodes();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '批量删除外包兑换码失败'));
    } finally {
      setDeletingUnused(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除这个未使用的外包兑换码？')) return;
    try {
      await api.delete(`/admin/outsourced-activation-codes/${id}`);
      toast.success('外包兑换码已删除');
      await fetchCodes();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '删除外包兑换码失败'));
    }
  };

  const totalPages = Math.ceil(total / 20);
  const visiblePages = visiblePageNumbers(page, totalPages);

  function currentParams() {
    return {
      ...currentFilters(),
      page,
      limit: 20,
    };
  }

  function currentFilters() {
    return {
      status,
      archiveScope,
      batchLabel: batchLabelFilter || undefined,
      search: search || undefined,
    };
  }

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-app-primary">外包兑换码管理</h2>
        <p className="mt-1 text-sm text-app-secondary">
          管理提交到外包买家端 API 的激活码，远端剩余额度以最近一次检测结果为准。
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6">
        <h3 className="text-lg font-semibold">导入外包兑换码</h3>
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_220px_auto] lg:items-end">
          <div>
            <label className="mb-1 block text-sm text-app-secondary">兑换码列表</label>
            <textarea
              value={codesText}
              onChange={(event) => setCodesText(event.target.value)}
              placeholder="每行一个外包兑换码"
              rows={4}
              className="w-full rounded-lg border border-app-border px-3 py-2 font-mono text-sm outline-none focus:border-app-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-app-secondary">批次标签（可选）</label>
            <input
              value={batchLabel}
              onChange={(event) => setBatchLabel(event.target.value)}
              placeholder="例如 outsourced-001"
              className="w-full rounded-lg border border-app-border px-3 py-2 text-sm outline-none focus:border-app-accent"
            />
          </div>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing}
            className="flex items-center justify-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover disabled:opacity-50"
          >
            {importing ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            导入
          </button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <SummaryCard label="总数" value={summary.total} />
        <SummaryCard label="可用" value={summary.available} />
        <SummaryCard label="已用完" value={summary.exhausted} />
        <SummaryCard label="未知" value={summary.unknown} />
        <SummaryCard label="检测失败" value={summary.checkFailed} />
        <SummaryCard label="远端剩余" value={summary.totalRemaining} />
        <SummaryCard label="本系统提交" value={summary.localSubmitCount} />
      </div>

      <div className="overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-checkout">
        <div className="grid grid-cols-1 gap-3 border-b border-app-border px-4 py-4 sm:px-6 lg:flex lg:flex-wrap lg:items-center">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-sm text-app-secondary">状态</span>
            {(['all', 'available', 'exhausted', 'error', 'unknown'] as const).map((nextStatus) => (
              <button
                key={nextStatus}
                type="button"
                onClick={() => { setStatus(nextStatus); setPage(1); }}
                className={`rounded-lg px-3 py-1 text-sm ${
                  status === nextStatus ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {statusFilterLabel(nextStatus)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-sm text-app-secondary">归档</span>
            {(['active', 'archived', 'all'] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => { setArchiveScope(scope); setPage(1); }}
                className={`rounded-lg px-3 py-1 text-sm ${
                  archiveScope === scope ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {scope === 'active' ? '未归档' : scope === 'archived' ? '已归档' : '全部'}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex">
            <input
              value={batchLabelFilter}
              onChange={(event) => { setBatchLabelFilter(event.target.value); setPage(1); }}
              placeholder="输入批次标签筛选"
              className="w-full rounded-lg border border-app-border px-3 py-2 text-sm outline-none focus:border-app-accent lg:w-44"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); }}
              placeholder="搜索脱敏码或批次"
              className="w-full rounded-lg border border-app-border px-3 py-2 text-sm outline-none focus:border-app-accent lg:w-44"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              data-testid="refresh-outsourced-codes"
              onClick={handleRefreshCurrent}
              disabled={refreshing}
              title="按当前筛选最多刷新 50 个最久未检测的外包兑换码"
              className="flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              刷新当前筛选
            </button>
            <button
              type="button"
              data-testid="archive-outsourced-codes"
              onClick={handleArchiveCurrent}
              disabled={archiving}
              className="flex items-center justify-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 text-sm text-app-primary hover:bg-neutral-200 disabled:opacity-50"
            >
              {archiving ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
              归档筛选结果
            </button>
            <button
              type="button"
              data-testid="delete-unused-outsourced-codes"
              onClick={handleDeleteUnusedCurrent}
              disabled={deletingUnused}
              className="flex items-center justify-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 hover:bg-red-100 disabled:opacity-50"
            >
              {deletingUnused ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              删除未使用
            </button>
          </div>
          <span className="text-sm text-app-secondary lg:ml-auto">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-app-accent" />
          </div>
        ) : error ? (
          <div className="py-10 text-center text-app-secondary">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[1120px] w-full text-sm">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">外包兑换码</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">批次</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">状态</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">远端剩余</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">远端已用/总量</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">本系统提交</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">最近检测</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">错误</th>
                  <th className="px-6 py-3 text-right font-medium text-app-secondary">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {codes.map((code) => (
                  <tr key={code.id} className="hover:bg-neutral-50">
                    <td className="px-6 py-3 font-mono font-medium">{code.maskedCode}</td>
                    <td className="px-6 py-3 text-app-secondary">{code.batchLabel ?? '-'}</td>
                    <td className="px-6 py-3"><StatusPill status={code.status} /></td>
                    <td className="px-6 py-3 text-app-secondary">{formatNumber(code.lastRemaining)}</td>
                    <td className="px-6 py-3 text-app-secondary">
                      {formatNumber(code.lastUsed)} / {formatNumber(code.lastTotal)}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">{code.localSubmitCount}</td>
                    <td className="px-6 py-3 text-app-secondary">{formatDate(code.lastCheckedAt)}</td>
                    <td className="max-w-[220px] truncate px-6 py-3 text-app-secondary" title={code.lastError ?? ''}>
                      {code.lastError ?? '-'}
                    </td>
                    <td className="px-6 py-3 text-right space-x-2">
                      <button
                        type="button"
                        onClick={() => void handleRefreshOne(code.id)}
                        className="p-1 text-gray-400 hover:text-app-primary"
                        title="刷新"
                      >
                        <RefreshCw size={14} />
                      </button>
                      {code.localSubmitCount === 0 && code.orderCount === 0 && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(code.id)}
                          className="p-1 text-gray-400 hover:text-red-600"
                          title="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                      {!code.archivedAt && (
                        <button
                          type="button"
                          onClick={() => void handleArchive(code.id)}
                          className="p-1 text-gray-400 hover:text-amber-600"
                          title="归档"
                        >
                          <Archive size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {codes.length === 0 && (
              <div className="border-t border-app-border px-6 py-10 text-center text-sm text-app-secondary">
                没有符合筛选条件的外包兑换码
              </div>
            )}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-app-border px-4 py-4 sm:px-6">
            <button
              type="button"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
              disabled={page <= 1}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-app-border text-app-secondary hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
              title="上一页"
            >
              <ChevronLeft size={16} />
            </button>
            {visiblePages.map((nextPage) => (
              <button
                key={nextPage}
                type="button"
                onClick={() => setPage(nextPage)}
                className={`h-9 min-w-9 rounded px-3 text-sm ${
                  page === nextPage ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {nextPage}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
              disabled={page >= totalPages}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-app-border text-app-secondary hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
              title="下一页"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </Layout>
  );
}

function SummaryCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout">
      <div className="text-sm text-app-secondary">{label}</div>
      <div className="mt-1 text-2xl font-bold text-app-primary">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: CodeStatus }) {
  const className = status === 'AVAILABLE'
    ? 'bg-green-100 text-green-700'
    : status === 'EXHAUSTED'
      ? 'bg-gray-100 text-gray-600'
      : status === 'CHECK_FAILED'
        ? 'bg-red-100 text-red-700'
        : 'bg-amber-100 text-amber-700';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${className}`}>{statusLabel(status)}</span>;
}

function statusFilterLabel(status: StatusFilter): string {
  if (status === 'all') return '全部';
  return statusLabel(status === 'available'
    ? 'AVAILABLE'
    : status === 'exhausted'
      ? 'EXHAUSTED'
      : status === 'error'
        ? 'CHECK_FAILED'
        : 'UNKNOWN');
}

function statusLabel(status: CodeStatus): string {
  if (status === 'AVAILABLE') return '可用';
  if (status === 'EXHAUSTED') return '已用完';
  if (status === 'CHECK_FAILED') return '检测失败';
  return '未知';
}

function formatNumber(value: number | null): string {
  return typeof value === 'number' ? String(value) : '-';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '-';
}
