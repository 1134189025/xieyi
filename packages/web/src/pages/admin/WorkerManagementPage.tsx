import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Plus, UserX, Loader2, Shield, Trash2, Search } from 'lucide-react';
import { visiblePageNumbers } from '../../utils/pagination';

interface WorkerItem {
  id: string;
  username: string;
  displayName: string | null;
  enabled: boolean;
  completedTotal: number;
  completedToday: number;
  completedThisWeek: number;
  claimedCount: number;
  lastCompletedAt: string | null;
  createdAt: string;
}

interface FetchWorkersOptions {
  silent?: boolean;
}

export default function WorkerManagementPage() {
  const [workers, setWorkers] = useState<WorkerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ username: '', password: '', displayName: '' });
  const [workerSearch, setWorkerSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const fetchWorkers = async (options: FetchWorkersOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const res = await api.get('/admin/workers', {
        params: {
          status: statusFilter,
          search: workerSearch || undefined,
          page,
          limit: 20,
        },
      });
      setWorkers(res.data.workers);
      setTotal(res.data.total ?? res.data.workers.length);
      setError('');
    } catch {
      if (!options.silent) {
        setError('工人列表加载失败');
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void fetchWorkers();
  }, [page, statusFilter, workerSearch]);

  useAutoRefresh(() => fetchWorkers({ silent: true }), AUTO_REFRESH_INTERVAL_MS);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post('/admin/workers', {
        username: formData.username,
        password: formData.password,
        displayName: formData.displayName || undefined,
      });
      toast.success('工人已创建');
      setShowForm(false);
      setFormData({ username: '', password: '', displayName: '' });
      fetchWorkers();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? '操作失败';
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (worker: WorkerItem) => {
    try {
      await api.patch(`/admin/workers/${worker.id}`, { enabled: !worker.enabled });
      toast.success(worker.enabled ? '工人已禁用' : '工人已启用');
      fetchWorkers();
    } catch {
      toast.error('更新工人失败');
    }
  };

  const handleArchive = async (worker: WorkerItem) => {
    if (!window.confirm(`确认删除工人「${worker.username}」？该账号将不可登录，历史订单归属会保留。`)) return;

    try {
      await api.delete(`/admin/workers/${worker.id}`);
      toast.success('工人已删除');
      await fetchWorkers();
    } catch {
      toast.error('删除工人失败');
    }
  };

  const totalPages = Math.ceil(total / 20);
  const visiblePages = visiblePageNumbers(page, totalPages);

  return (
    <Layout>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-2xl font-bold text-app-primary">工人管理</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover sm:w-auto"
        >
          <Plus size={16} />
          添加工人
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6">
          <h3 className="text-lg font-semibold mb-4">新建工人</h3>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-4 items-end">
            <div className="w-full sm:w-auto">
              <label className="mb-1 block text-sm text-app-secondary">用户名</label>
              <input
                type="text"
                required
                value={formData.username}
                onChange={(e) => setFormData((p) => ({ ...p, username: e.target.value }))}
                className="w-full rounded-lg border border-app-border px-3 py-2 outline-none focus:border-app-accent sm:w-48"
              />
            </div>
            <div className="w-full sm:w-auto">
              <label className="mb-1 block text-sm text-app-secondary">密码</label>
              <input
                type="password"
                required
                minLength={6}
                value={formData.password}
                onChange={(e) => setFormData((p) => ({ ...p, password: e.target.value }))}
                className="w-full rounded-lg border border-app-border px-3 py-2 outline-none focus:border-app-accent sm:w-48"
              />
            </div>
            <div className="w-full sm:w-auto">
              <label className="mb-1 block text-sm text-app-secondary">显示名称</label>
              <input
                type="text"
                value={formData.displayName}
                onChange={(e) => setFormData((p) => ({ ...p, displayName: e.target.value }))}
                className="w-full rounded-lg border border-app-border px-3 py-2 outline-none focus:border-app-accent sm:w-48"
                placeholder="可选"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="w-full rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover disabled:opacity-50 sm:w-auto"
            >
              {creating ? '正在创建...' : '创建'}
            </button>
          </form>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-checkout">
        <div className="grid grid-cols-1 gap-3 border-b border-app-border px-4 py-4 sm:px-6 lg:flex lg:flex-wrap lg:items-center">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-sm text-app-secondary">状态</span>
            {(['all', 'enabled', 'disabled'] as const).map((nextStatus) => (
              <button
                key={nextStatus}
                type="button"
                onClick={() => { setStatusFilter(nextStatus); setPage(1); }}
                className={`rounded-lg px-3 py-1 text-sm ${
                  statusFilter === nextStatus ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {nextStatus === 'all' ? '全部' : nextStatus === 'enabled' ? '启用' : '禁用'}
              </button>
            ))}
          </div>
          <label className="flex w-full min-w-0 items-center gap-2 sm:max-w-xs lg:w-auto lg:min-w-[240px] lg:flex-1">
            <Search size={16} className="text-app-secondary" />
            <input
              value={workerSearch}
              onChange={(event) => { setWorkerSearch(event.target.value); setPage(1); }}
              placeholder="搜索用户名或显示名"
              className="min-w-0 flex-1 rounded-lg border border-app-border px-3 py-2 text-sm outline-none focus:border-app-accent"
            />
          </label>
          <span className="text-sm text-app-secondary lg:ml-auto">
            显示 {workers.length} / {total} 个
          </span>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-app-accent" />
          </div>
        ) : error ? (
          <div className="py-10 text-center text-app-secondary">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[960px] w-full text-sm">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">用户名</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">显示名称</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">状态</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">今日完成</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">本周完成</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">总完成</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">已领取</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">最近完成</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">创建时间</th>
                  <th className="px-6 py-3 text-right font-medium text-app-secondary">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {workers.map((worker) => (
                  <tr key={worker.id} className="hover:bg-neutral-50">
                    <td className="px-6 py-3 font-medium">{worker.username}</td>
                    <td className="px-6 py-3 text-app-secondary">{worker.displayName ?? '-'}</td>
                    <td className="px-6 py-3">
                      {worker.enabled ? (
                        <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">启用</span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded-full">禁用</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">{worker.completedToday}</td>
                    <td className="px-6 py-3 text-app-secondary">{worker.completedThisWeek}</td>
                    <td className="px-6 py-3 text-app-secondary">{worker.completedTotal}</td>
                    <td className="px-6 py-3 text-app-secondary">{worker.claimedCount}</td>
                    <td className="px-6 py-3 text-app-secondary">
                      {worker.lastCompletedAt ? new Date(worker.lastCompletedAt).toLocaleString('zh-CN') : '-'}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">
                      {new Date(worker.createdAt).toLocaleDateString('zh-CN')}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => handleToggle(worker)}
                        className={`p-1 ${worker.enabled ? 'text-red-400 hover:text-red-600' : 'text-green-400 hover:text-green-600'}`}
                        title={worker.enabled ? '禁用' : '启用'}
                      >
                        {worker.enabled ? <UserX size={16} /> : <Shield size={16} />}
                      </button>
                      <button
                        onClick={() => handleArchive(worker)}
                        className="p-1 text-red-400 hover:text-red-600"
                        title="删除工人"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {workers.length === 0 && (
              <div className="border-t border-app-border px-6 py-10 text-center text-sm text-app-secondary">
                没有符合筛选条件的工人
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
