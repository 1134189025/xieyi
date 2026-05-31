import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import StatusBadge from '../../components/StatusBadge';
import toast from 'react-hot-toast';
import { Loader2, XCircle } from 'lucide-react';
import { orderStatusLabel, safeErrorMessage } from '../../utils/labels';

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
  const [error, setError] = useState('');

  const fetchOrders = async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/admin/orders', { params });
      setOrders(res.data.orders);
      setTotal(res.data.total);
      setError('');
    } catch {
      setError('订单列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, [page, statusFilter]);

  const handleCancel = async (orderId: string) => {
    if (!confirm('确认取消这个订单？')) return;
    try {
      await api.patch(`/admin/orders/${orderId}`, { status: 'CANCELLED' });
      toast.success('订单已取消');
      fetchOrders();
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '取消订单失败'));
    }
  };

  const statuses = ['', 'CREATING_PAYMENT', 'PENDING_PAYMENT', 'PAYMENT_COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'];
  const totalPages = Math.ceil(total / 20);

  return (
    <Layout>
      <h2 className="mb-6 text-2xl font-bold text-app-primary">订单管理</h2>

      <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-checkout">
        <div className="flex flex-wrap items-center gap-4 border-b border-app-border px-6 py-4">
          <span className="text-sm text-app-secondary">状态：</span>
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`px-3 py-1 text-sm rounded-full ${
                statusFilter === s ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
              }`}
            >
              {s ? orderStatusLabel(s) : '全部'}
            </button>
          ))}
          <span className="ml-auto text-sm text-app-secondary">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-app-accent" />
          </div>
        ) : error ? (
          <div className="py-10 text-center text-app-secondary">{error}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className="px-6 py-3 text-left font-medium text-app-secondary">追踪码</th>
                <th className="px-6 py-3 text-left font-medium text-app-secondary">状态</th>
                <th className="px-6 py-3 text-left font-medium text-app-secondary">工人</th>
                <th className="px-6 py-3 text-left font-medium text-app-secondary">创建时间</th>
                <th className="px-6 py-3 text-left font-medium text-app-secondary">完成时间</th>
                <th className="px-6 py-3 text-right font-medium text-app-secondary">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-neutral-50">
                  <td className="px-6 py-3 font-mono text-xs">{order.trackingToken}</td>
                  <td className="px-6 py-3">
                    <StatusBadge status={order.status} />
                  </td>
                  <td className="px-6 py-3 text-app-secondary">
                    {order.completedBy?.displayName ?? '-'}
                  </td>
                  <td className="px-6 py-3 text-app-secondary">
                    {new Date(order.createdAt).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-6 py-3 text-app-secondary">
                    {order.completedAt
                      ? new Date(order.completedAt).toLocaleString('zh-CN')
                      : '-'}
                  </td>
                  <td className="px-6 py-3 text-right">
                    {order.status === 'PENDING_PAYMENT' && (
                      <button
                        onClick={() => handleCancel(order.id)}
                        className="p-1 text-gray-400 hover:text-red-600"
                        title="取消订单"
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
          <div className="flex justify-center gap-2 border-t border-app-border px-6 py-4">
            {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1).map((p) => (
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
