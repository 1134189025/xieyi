import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import toast from 'react-hot-toast';
import { Plus, Trash2, Copy, Loader2 } from 'lucide-react';

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

  const fetchCodes = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/redemption-codes', {
        params: { status: filter, page, limit: 20 },
      });
      setCodes(res.data.codes);
      setTotal(res.data.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCodes();
  }, [page, filter]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await api.post('/admin/redemption-codes', {
        count,
        batchLabel: batchLabel || undefined,
      });
      toast.success(`Generated ${res.data.codes.length} codes`);
      fetchCodes();
    } catch {
      toast.error('Failed to generate codes');
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this code?')) return;
    try {
      await api.delete(`/admin/redemption-codes/${id}`);
      toast.success('Code deleted');
      fetchCodes();
    } catch {
      toast.error('Failed to delete code');
    }
  };

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    toast.success('Copied!');
  };

  const handleCopyAll = () => {
    const unusedCodes = codes.filter((c) => !c.usedAt).map((c) => c.code);
    navigator.clipboard.writeText(unusedCodes.join('\n'));
    toast.success(`Copied ${unusedCodes.length} unused codes`);
  };

  const totalPages = Math.ceil(total / 20);

  return (
    <Layout>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Redemption Codes</h2>

      <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Generate Codes</h3>
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-sm text-gray-600 mb-1">Count</label>
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
            <label className="block text-sm text-gray-600 mb-1">Batch Label (optional)</label>
            <input
              type="text"
              value={batchLabel}
              onChange={(e) => setBatchLabel(e.target.value)}
              placeholder="e.g. batch-001"
              className="w-48 px-3 py-2 border rounded-lg"
            />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            Generate
          </button>
          <button
            onClick={handleCopyAll}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            <Copy size={16} />
            Copy All Unused
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="px-6 py-4 border-b flex items-center gap-4">
          <span className="text-sm text-gray-500">Filter:</span>
          {(['all', 'unused', 'used'] as const).map((f) => (
            <button
              key={f}
              onClick={() => { setFilter(f); setPage(1); }}
              className={`px-3 py-1 text-sm rounded-full ${
                filter === f ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {f === 'all' ? 'All' : f === 'unused' ? 'Unused' : 'Used'}
            </button>
          ))}
          <span className="ml-auto text-sm text-gray-400">{total} total</span>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Code</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Batch</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Created</th>
                <th className="px-6 py-3 text-right font-medium text-gray-500">Actions</th>
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
                        Used {code.order ? `(${code.order.status})` : ''}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">
                        Available
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
                      title="Copy"
                    >
                      <Copy size={14} />
                    </button>
                    {!code.usedAt && (
                      <button
                        onClick={() => handleDelete(code.id)}
                        className="p-1 text-gray-400 hover:text-red-600"
                        title="Delete"
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
