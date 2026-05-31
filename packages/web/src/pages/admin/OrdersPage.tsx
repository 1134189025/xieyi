import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import StatusBadge from '../../components/StatusBadge';
import toast from 'react-hot-toast';
import { Loader2, XCircle } from 'lucide-react';

interface OrderItem {
  id: string;
  trackingToken: string;
  status: string;
  pixCode: string | null;
  checkoutSessionId: string | null;
  errorMessage: string | null;
  completedBy: { id: string; displayName: string } | null;
  completedAt: string | null;
  createdAt: string;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/admin/orders', { params });
      setOrders(res.data.orders);
      setTotal(res.data.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [page, statusFilter]);

  const handleCancel = async (orderId: string) => {
    if (!confirm('Cancel this order?')) return;
    try {
      await api.patch(`/admin/orders/${orderId}`, { status: 'CANCELLED' });
      toast.success('Order cancelled');
      fetchOrders();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Failed';
      toast.error(msg);
    }
  };

  const statuses = ['', 'PENDING_PAYMENT', 'PAYMENT_COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'];
  const totalPages = Math.ceil(total / 20);

  return (
    <Layout>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">Orders</h2>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="px-6 py-4 border-b flex items-center gap-4 flex-wrap">
          <span className="text-sm text-gray-500">Status:</span>
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`px-3 py-1 text-sm rounded-full ${
                statusFilter === s ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {s || 'All'}
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
                <th className="px-6 py-3 text-left font-medium text-gray-500">Tracking</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Worker</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Created</th>
                <th className="px-6 py-3 text-left font-medium text-gray-500">Completed</th>
                <th className="px-6 py-3 text-right font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-mono text-xs">{order.trackingToken}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-6 py-3 text-gray-500">
                    {order.completedBy?.displayName ?? '-'}
                  </td>
                  <td className="px-6 py-3 text-gray-500">
                    {new Date(order.createdAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-6 py-3 text-gray-500">
                    {order.completedAt
                      ? new Date(order.completedAt).toLocaleString('zh-CN')
                      : '-'}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {order.status === 'PENDING_PAYMENT' && (
                      <button
                        onClick={() => handleCancel(order.id)}
                        className="p-1 text-gray-400 hover:text-red-600"
                        title="Cancel"
                      >
                        <XCircle size={16} />
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
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
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
