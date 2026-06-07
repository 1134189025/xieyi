import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import StatusBadge from '../../components/StatusBadge';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import toast from 'react-hot-toast';
import { Loader2, XCircle } from 'lucide-react';
import { orderStatusLabel, safeErrorMessage } from '../../utils/labels';

interface OrderItem {
  id: string;
  trackingToken: string;
  status: string;
  paymentHandler?: 'LOCAL_WORKER' | 'OUTSOURCED_BUYER_API';
  checkoutSessionId: string | null;
  outsourcedTicketId?: string | null;
  outsourcedPaymentStatus?: string | null;
  outsourcedLastError?: string | null;
  errorMessage: string | null;
  generationErrorCode: string | null;
  generationErrorStage: string | null;
  generationErrorDetail: string | null;
  generationErrorHttpStatus: number | null;
  claimedBy: WorkerRef | null;
  completedBy: WorkerRef | null;
  completedAt: string | null;
  createdAt: string;
}

interface WorkerRef {
  id: string;
  username: string;
  displayName: string | null;
}

interface FetchOrdersOptions {
  silent?: boolean;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchOrders = async (options: FetchOrdersOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const params: Record<string, unknown> = { page, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/admin/orders', { params });
      setOrders(res.data.orders);
      setTotal(res.data.total);
      setError('');
    } catch {
      if (!options.silent) {
        setError('订单列表加载失败');
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void fetchOrders();
  }, [page, statusFilter]);

  useAutoRefresh(() => fetchOrders({ silent: true }), AUTO_REFRESH_INTERVAL_MS);

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
        <div className="flex flex-wrap items-center gap-3 border-b border-app-border px-4 py-4 sm:gap-4 sm:px-6">
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
            <table className="min-w-[1240px] w-full text-sm">
              <thead className="bg-neutral-50">
                <tr>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">追踪码</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">状态</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">处理方式</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">归属工人</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">外包信息</th>
                  <th className="px-6 py-3 text-left font-medium text-app-secondary">失败诊断</th>
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
                      {paymentHandlerLabel(order.paymentHandler)}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">
                      {workerOwnershipLabel(order)}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">
                      {outsourcedPaymentLabel(order)}
                    </td>
                    <td className="px-6 py-3 text-app-secondary">
                      {order.generationErrorStage || order.generationErrorDetail ? (
                        <div className="max-w-xs space-y-1">
                          <p className="font-medium text-app-primary">
                            {order.generationErrorStage ?? '-'}
                            {order.generationErrorHttpStatus ? ` / HTTP ${order.generationErrorHttpStatus}` : ''}
                          </p>
                          <p className="break-words text-xs">{order.generationErrorDetail ?? order.generationErrorCode}</p>
                        </div>
                      ) : '-'}
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
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex flex-wrap justify-center gap-2 border-t border-app-border px-4 py-4 sm:px-6">
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

function workerName(worker: WorkerRef | null): string | null {
  if (!worker) return null;
  return worker.displayName ?? worker.username;
}

function paymentHandlerLabel(handler: OrderItem['paymentHandler']): string {
  return handler === 'OUTSOURCED_BUYER_API' ? '外包自动支付' : '本地工人扫码';
}

function outsourcedPaymentLabel(order: OrderItem): ReactNode {
  if (order.paymentHandler !== 'OUTSOURCED_BUYER_API') return '-';
  return (
    <div className="max-w-xs space-y-1">
      <p className="break-all font-mono text-xs text-app-primary">{order.outsourcedTicketId ?? '未提交票据'}</p>
      <p className="text-xs">状态：{order.outsourcedPaymentStatus ?? '-'}</p>
      {order.outsourcedLastError && <p className="break-words text-xs text-amber-700">{order.outsourcedLastError}</p>}
    </div>
  );
}

function workerOwnershipLabel(order: OrderItem): string {
  const completedWorker = workerName(order.completedBy);
  if (completedWorker) return `完成：${completedWorker}`;
  if (order.paymentHandler === 'OUTSOURCED_BUYER_API' && order.status === 'PAYMENT_COMPLETED') {
    return '外包自动完成';
  }

  const claimedWorker = workerName(order.claimedBy);
  return claimedWorker ? `领取：${claimedWorker}` : '-';
}
