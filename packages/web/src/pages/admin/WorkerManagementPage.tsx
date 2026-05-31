import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import toast from 'react-hot-toast';
import { Plus, UserX, Loader2, Shield } from 'lucide-react';

interface WorkerItem {
  id: string;
  username: string;
  displayName: string | null;
  enabled: boolean;
  createdAt: string;
  completedOrderCount: number;
}

export default function WorkerManagementPage() {
  const [workers, setWorkers] = useState<WorkerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ username: '', password: '', displayName: '' });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const fetchWorkers = async () => {
    try {
      const res = await api.get('/admin/workers');
      setWorkers(res.data.workers);
      setError('');
    } catch {
      setError('工人列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWorkers();
  }, []);

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

  return (
    <Layout>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">工人管理</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          <Plus size={16} />
          添加工人
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">新建工人</h3>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-sm text-gray-600 mb-1">用户名</label>
              <input
                type="text"
                required
                value={formData.username}
                onChange={(e) => setFormData((p) => ({ ...p, username: e.target.value }))}
                className="w-48 px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">密码</label>
              <input
                type="password"
                required
                minLength={6}
                value={formData.password}
                onChange={(e) => setFormData((p) => ({ ...p, password: e.target.value }))}
                className="w-48 px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">显示名称</label>
              <input
                type="text"
                value={formData.displayName}
                onChange={(e) => setFormData((p) => ({ ...p, displayName: e.target.value }))}
                className="w-48 px-3 py-2 border rounded-lg"
                placeholder="可选"
              />
            </div>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {creating ? '正在创建...' : '创建'}
            </button>
          </form>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
          </div>
        ) : error ? (
          <div className="py-10 text-center text-gray-500">{error}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left font-medium text-gray-500">用户名</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">显示名称</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">完成订单</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">状态</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">创建时间</th>
                <th className="px-6 py-3 text-right font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {workers.map((worker) => (
                <tr key={worker.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium">{worker.username}</td>
                  <td className="px-6 py-3 text-gray-500">{worker.displayName ?? '-'}</td>
                  <td className="px-6 py-3">
                    <span className="px-2 py-0.5 text-xs bg-indigo-100 text-indigo-700 rounded-full">
                      {worker.completedOrderCount}
                    </span>
                  </td>
                  <td className="px-6 py-3">
                    {worker.enabled ? (
                      <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">启用</span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded-full">禁用</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-gray-500">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}
