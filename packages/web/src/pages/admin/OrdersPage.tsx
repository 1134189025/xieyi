import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import StatusBadge from '../../components/StatusBadge';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Loader2, Search, XCircle } from 'lucide-react';
import { orderStatusLabel, safeErrorMessage } from '../../utils/labels';
import { visiblePageNumbers } from '../../utils/pagination';

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
  const [pageInput, setPageInput] = useState('1');
  const [statusFilter, setStatusFilter] = useState('');
  const [paymentHandlerFilter, setPaymentHandlerFilter] = useState('');
  const [trackingTokenSearch, setTrackingTokenSearch] = useState('');
  const [trackingTokenInput, setTrackingTokenInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchOrders = async (options: FetchOrdersOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const params: Record<string, unknown> = { page, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      if (paymentHandlerFilter) params.paymentHandler = paymentHandlerFilter;
      if (trackingTokenSearch) params.trackingToken = trackingTokenSearch;
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
  }, [page, statusFilter, paymentHandlerFilter, trackingTokenSearch]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

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
  const paymentHandlers = [
    { value: '', label: '全部方式' },
    { value: 'LOCAL_WORKER', label: '本地工人扫码' },
    { value: 'OUTSOURCED_BUYER_API', label: '外包自动支付' },
  ];
  const totalPages = Math.ceil(total / 20);
  const visiblePages = visiblePageNumbers(page, totalPages);

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setTrackingTokenSearch(trackingTokenInput.trim());
    setPage(1);
  };

  const jumpToPage = (event: React.FormEvent) => {
    event.preventDefault();
    const requestedPage = Number(pageInput);
    if (!Number.isInteger(requestedPage)) return;
    setPage(Math.min(Math.max(requestedPage, 1), Math.max(totalPages, 1)));
  };

  return (
    <Layout>
      <h2 className="mb-6 text-2xl font-bold text-app-primary">订单管理</h2>

      <div className="overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-checkout">
        <div className="grid grid-cols-1 gap-3 border-b border-app-border px-4 py-4 sm:px-6 lg:flex lg:flex-wrap lg:items-center">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-sm text-app-secondary">状态</span>
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setPage(1); }}
                className={`rounded-lg px-3 py-1 text-sm ${
                  statusFilter === s ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {s ? orderStatusLabel(s) : '全部'}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-sm text-app-secondary">方式</span>
            {paymentHandlers.map((handler) => (
              <button
                key={handler.value}
                onClick={() => { setPaymentHandlerFilter(handler.value); setPage(1); }}
                className={`rounded-lg px-3 py-1 text-sm ${
                  paymentHandlerFilter === handler.value ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {handler.label}
              </button>
            ))}
          </div>
          <form onSubmit={handleSearch} className="flex w-full min-w-0 items-center gap-2 sm:max-w-xs lg:w-auto lg:min-w-[240px] lg:flex-1">
            <input
              value={trackingTokenInput}
              onChange={(event) => setTrackingTokenInput(event.target.value)}
              placeholder="追踪码"
              className="min-w-0 flex-1 rounded-lg border border-app-border px-3 py-2 text-sm outline-none focus:border-app-accent"
            />
            <button
              type="submit"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-app-accent text-white hover:bg-app-accentHover"
              title="搜索追踪码"
            >
              <Search size={16} />
            </button>
          </form>
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
                      <GenerationDiagnostic order={order} />
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
                      {canCancelOrder(order) && (
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
            {orders.length === 0 && (
              <div className="border-t border-app-border px-6 py-10 text-center text-sm text-app-secondary">
                没有符合筛选条件的订单
              </div>
            )}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-app-border px-4 py-4 sm:px-6">
            <button
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
              disabled={page <= 1}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-app-border text-app-secondary hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
              title="上一页"
            >
              <ChevronLeft size={16} />
            </button>
            {visiblePages.map((p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`h-9 min-w-9 rounded px-3 text-sm ${
                  page === p ? 'bg-app-accent text-white' : 'text-app-secondary hover:bg-neutral-100'
                }`}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => setPage((currentPage) => Math.min(totalPages, currentPage + 1))}
              disabled={page >= totalPages}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-app-border text-app-secondary hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
              title="下一页"
            >
              <ChevronRight size={16} />
            </button>
            <form onSubmit={jumpToPage} className="ml-2 flex items-center gap-2 text-sm text-app-secondary">
              <span>第</span>
              <input
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                className="h-9 w-16 rounded border border-app-border px-2 text-center outline-none focus:border-app-accent"
              />
              <span>/ {totalPages} 页</span>
              <button type="submit" className="rounded px-3 py-2 text-app-secondary hover:bg-neutral-100">
                跳转
              </button>
            </form>
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

function GenerationDiagnostic({ order }: { order: OrderItem }) {
  if (!order.generationErrorCode && !order.generationErrorStage && !order.generationErrorDetail) {
    return '-';
  }

  const title = order.generationErrorStage ?? order.generationErrorCode ?? '-';
  const detail = order.generationErrorDetail ?? order.generationErrorCode;

  return (
    <div className="max-w-xs space-y-1">
      <p className="font-medium text-app-primary">
        {title}
        {order.generationErrorHttpStatus ? ` / HTTP ${order.generationErrorHttpStatus}` : ''}
      </p>
      {detail && <p className="break-words text-xs">{detail}</p>}
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

function canCancelOrder(order: OrderItem): boolean {
  if (order.status !== 'PENDING_PAYMENT') return false;
  return !(order.paymentHandler === 'OUTSOURCED_BUYER_API' && order.outsourcedTicketId);
}
