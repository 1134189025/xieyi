import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import toast from 'react-hot-toast';
import { Plus, Trash2, Copy, Loader2 } from 'lucide-react';
import { orderStatusLabel } from '../../utils/labels';

interface CodeItem {
  id: string;
  code: string;
  batchLabel: string | null;
  usedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  order: { id: string; trackingToken: string; status: string } | null;
}

interface FetchCodesOptions {
  silent?: boolean;
}

export default function RedemptionCodesPage() {
  const [codes, setCodes] = useState<CodeItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'all' | 'unused' | 'used'>('all');
  const [archiveScope, setArchiveScope] = useState<'active' | 'archived' | 'all'>('active');
  const [batchLabelFilter, setBatchLabelFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [count, setCount] = useState(10);
  const [batchLabel, setBatchLabel] = useState('');
  const [error, setError] = useState('');

  const fetchCodes = async (options: FetchCodesOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const res = await api.get('/admin/redemption-codes', {
        params: {
          status: filter,
          archiveScope,
          batchLabel: batchLabelFilter || undefined,
          search: search || undefined,
          page,
          limit: 20,
        },
      });
      setCodes(res.data.codes);
      setTotal(res.data.total);
      setError('');
    } catch {
      if (!options.silent) {
        setError('兑换码列表加载失败');
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void fetchCodes();
  }, [page, filter, archiveScope, batchLabelFilter, search]);

  useAutoRefresh(() => fetchCodes({ silent: true }), AUTO_REFRESH_INTERVAL_MS);

  const handleGenerate = async () => {
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      toast.error('生成数量必须是 1 到 500 的整数');
      return;
    }
    setGenerating(true);
    try {
      const res = await api.post('/admin/redemption-codes', {
        count,
        batchLabel: batchLabel || undefined,
      });
      toast.success(`已生成 ${res.data.codes.length} 个兑换码`);
      fetchCodes();
    } catch {
      toast.error('生成兑换码失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除这个兑换码？')) return;
    try {
      await api.delete(`/admin/redemption-codes/${id}`);
      toast.success('兑换码已删除');
      fetchCodes();
    } catch {
      toast.error('删除兑换码失败');
    }
  };

  const handleArchive = async (id: string) => {
    if (!confirm('确认归档这个已使用兑换码？归档后默认列表不再显示。')) return;
    try {
      await api.post(`/admin/redemption-codes/${id}/archive`);
      toast.success('兑换码已归档');
      fetchCodes();
    } catch {
      toast.error('归档兑换码失败');
    }
  };

  const handleArchiveUsed = async () => {
    if (!confirm('确认按当前筛选归档已使用兑换码？')) return;
    setArchiving(true);
    try {
      const res = await api.post('/admin/redemption-codes/archive-used', {
        status: filter,
        batchLabel: batchLabelFilter || undefined,
        search: search || undefined,
        archiveScope,
      });
      toast.success(`已归档 ${res.data.archivedCount ?? 0} 个已使用兑换码`);
      fetchCodes();
    } catch {
      toast.error('批量归档失败');
    } finally {
      setArchiving(false);
    }
  };

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('已复制');
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  const handleCopyAll = async () => {
    const unusedCodes = codes.filter((c) => !c.usedAt).map((c) => c.code);
    try {
      await navigator.clipboard.writeText(unusedCodes.join('\n'));
      toast.success(`已复制 ${unusedCodes.length} 个未使用兑换码`);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  };

  const totalPages = Math.ceil(total / 20);

  return (
    <Layout>
      <h2 className="mb-6 text-2xl font-bold text-app-primary">兑换码管理</h2>

      <div className="mb-6 rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6">
        <h3 className="text-lg font-semibold mb-4">生成兑换码</h3>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-sm text-app-secondary">数量</label>
            <input
              type="number"
              min={1}
              max={500}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-full rounded-lg border border-app-border px-3 py-2 outline-none focus:border-app-accent sm:w-24"
            />
          </div>
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-sm text-app-secondary">批次标签（可选）</label>
            <input
              type="text"
              value={batchLabel}
              onChange={(e) => setBatchLabel(e.target.value)}
              placeholder="例如 batch-001"
              className="w-full rounded-lg border border-app-border px-3 py-2 outline-none focus:border-app-accent sm:w-48"
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover disabled:opacity-50 sm:w-auto"
          >
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            生成
          </button>
          <button
            onClick={handleCopyAll}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-app-primary hover:bg-neutral-200 sm:w-auto"
          >
            <Copy size={16} />
            复制本页未使用兑换码
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-checkout">
        <div className="flex flex-wrap items-center gap-3 border-b border-app-border px-4 py-4 sm:gap-4 sm:px-6">
          <span className="text-sm text-app-secondary">筛选：</span>
          {(['all', 'unused', 'used'] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1); }}
              className={`px-3 py-1 text-sm rounded-full ${
                filter === f ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
              }`}
            >
              {f === 'all' ? '全部' : f === 'unused' ? '未使用' : '已使用'}
            </button>
          ))}
          <span className="text-sm text-app-secondary">归档：</span>
          {(['active', 'archived', 'all'] as const).map((scope) => (
            <button
              key={scope}
              onClick={() => { setArchiveScope(scope); setPage(1); }}
              className={`px-3 py-1 text-sm rounded-full ${
                archiveScope === scope ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
              }`}
            >
              {scope === 'active' ? '未归档' : scope === 'archived' ? '已归档' : '全部'}
            </button>
          ))}
          <input
            type="text"
            value={batchLabelFilter}
            onInput={(event) => { setBatchLabelFilter(event.currentTarget.value); setPage(1); }}
            placeholder="输入批次标签筛选"
            className="w-full rounded-lg border border-app-border px-3 py-2 text-sm outline-none focus:border-app-accent sm:w-44"
          />
          <input
            type="search"
            value={search}
            onInput={(event) => { setSearch(event.currentTarget.value); setPage(1); }}
            placeholder="搜索兑换码或批次"
            className="w-full rounded-lg border border-app-border px-3 py-2 text-sm outline-none focus:border-app-accent sm:w-44"
          />
          <button
            type="button"
            data-testid="archive-used-codes"
            onClick={handleArchiveUsed}
            disabled={archiving}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {archiving ? '归档中...' : '归档已使用'}
          </button>
          <span className="w-full text-sm text-app-secondary sm:ml-auto sm:w-auto">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-app-accent" />
          </div>
        ) : error ? (
          <div className="py-10 text-center text-app-secondary">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[720px] w-full text-sm">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">兑换码</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">批次</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">状态</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">归档</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">创建时间</th>
                  <th className="px-6 py-3 text-right font-medium text-app-secondary">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {codes.map((code) => (
                  <tr key={code.id} className="hover:bg-neutral-50">
                    <td className="px-6 py-3 font-mono font-medium">{code.code}</td>
                    <td className="px-6 py-3 text-app-secondary">{code.batchLabel ?? '-'}</td>
                    <td className="px-6 py-3">
                      {code.usedAt ? (
                        <span className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded-full">
                          已使用 {code.order ? `（${orderStatusLabel(code.order.status)}）` : ''}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">
                          可用
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">
                      {code.archivedAt ? '已归档' : '未归档'}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">
                      {new Date(code.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="px-6 py-3 text-right space-x-2">
                      <button
                        onClick={() => handleCopy(code.code)}
                        className="p-1 text-gray-400 hover:text-app-primary"
                        title="复制"
                      >
                        <Copy size={14} />
                      </button>
                      {!code.usedAt && (
                        <button
                          onClick={() => handleDelete(code.id)}
                          className="p-1 text-gray-400 hover:text-red-600"
                          title="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                      {code.usedAt && !code.archivedAt && (
                        <button
                          onClick={() => handleArchive(code.id)}
                          className="p-1 text-gray-400 hover:text-amber-600"
                          title="归档"
                        >
                          归档
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex flex-wrap justify-center gap-2 border-t border-app-border px-4 py-4 sm:px-6">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`px-3 py-1 text-sm rounded ${
                  page === p ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
