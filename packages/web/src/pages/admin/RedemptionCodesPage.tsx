import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import toast from 'react-hot-toast';
import { Plus, Trash2, Copy, Loader2 } from 'lucide-react';
import { orderStatusLabel } from '../../utils/labels';

interface CodeItem {
  id: string;
  code: string;
  batchLabel: string | null;
  usedAt: string | null;
  createdAt: string;
  order: { id: string; trackingToken: string; status: string } | null;
}

export default function RedemptionCodesPage() {
  const [codes, setCodes] = useState<CodeItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'all' | 'unused' | 'used'>('all');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [count, setCount] = useState(10);
  const [batchLabel, setBatchLabel] = useState('');
  const [error, setError] = useState('');

  const fetchCodes = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/redemption-codes', {
        params: { status: filter, page, limit: 20 },
      });
      setCodes(res.data.codes);
      setTotal(res.data.total);
      setError('');
    } catch {
      setError('兑换码列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCodes();
  }, [page, filter]);

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
      <h2 className="text-2xl font-bold text-gray-900 mb-6">兑换码管理</h2>

      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">生成兑换码</h3>
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-sm text-gray-600 mb-1">数量</label>
            <input
              type="number"
              min={1}
              max={500}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-24 px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">批次标签（可选）</label>
            <input
              type="text"
              value={batchLabel}
              onChange={(e) => setBatchLabel(e.target.value)}
              placeholder="例如 batch-001"
              className="w-48 px-3 py-2 border rounded-lg"
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            生成
          </button>
          <button
            onClick={handleCopyAll}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            <Copy size={16} />
            复制本页未使用兑换码
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="px-6 py-4 border-b flex items-center gap-4">
          <span className="text-sm text-gray-500">筛选：</span>
          {(['all', 'unused', 'used'] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1); }}
              className={`px-3 py-1 text-sm rounded-full ${
                filter === f ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {f === 'all' ? '全部' : f === 'unused' ? '未使用' : '已使用'}
            </button>
          ))}
          <span className="ml-auto text-sm text-gray-400">共 {total} 条</span>
        </div>

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
                <th className="px-6 py-3 text-left font-medium text-gray-500">兑换码</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">批次</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">状态</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">创建时间</th>
                <th className="px-6 py-3 text-right font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {codes.map((code) => (
                <tr key={code.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-mono font-medium">{code.code}</td>
                  <td className="px-6 py-3 text-gray-500">{code.batchLabel ?? '-'}</td>
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
                  <td className="px-6 py-3 text-gray-500">
                    {new Date(code.createdAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-6 py-3 text-right space-x-2">
                    <button
                      onClick={() => handleCopy(code.code)}
                      className="p-1 text-gray-400 hover:text-indigo-600"
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {totalPages > 1 && (
          <div className="px-6 py-4 border-t flex justify-center gap-2">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`px-3 py-1 text-sm rounded ${
                  page === p ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100'
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
