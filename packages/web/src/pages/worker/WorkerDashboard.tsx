import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import { useSocket } from '../../hooks/useSocket';
import toast from 'react-hot-toast';
import { CheckCircle, Copy, Loader2 } from 'lucide-react';

type WorkerViewMode = 'qr' | 'pix';

interface OrderItem {
  id: string;
  trackingToken: string;
  status: string;
  pixCode: string | null;
  pixQrPngBase64: string | null;
  pixExpiresAt: string | null;
  pixImageUrl: string | null;
  claimedById: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  createdAt: string;
}

interface CompletionSummary {
  completedTotal: number;
  completedToday: number;
  completedThisWeek: number;
  claimedCount: number;
  availableCount: number;
}

interface FetchOrdersOptions {
  silent?: boolean;
}

export default function WorkerDashboard() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [summary, setSummary] = useState<CompletionSummary>({
    completedTotal: 0,
    completedToday: 0,
    completedThisWeek: 0,
    claimedCount: 0,
    availableCount: 0,
  });
  const [viewMode, setViewMode] = useState<WorkerViewMode>('qr');
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const { token } = useAuth();
  const socket = useSocket('/worker', token);

  const fetchSummary = async () => {
    const summaryResponse = await api.get('/worker/summary');
    setSummary({
      completedTotal: Number(summaryResponse.data.completedTotal) || 0,
      completedToday: Number(summaryResponse.data.completedToday) || 0,
      completedThisWeek: Number(summaryResponse.data.completedThisWeek) || 0,
      claimedCount: Number(summaryResponse.data.claimedCount) || 0,
      availableCount: Number(summaryResponse.data.availableCount) || 0,
    });
  };

  const fetchOrders = async (options: FetchOrdersOptions = {}) => {
    try {
      const ordersResponse = await api.get('/worker/orders/mine?limit=50');
      setOrders(sortWorkerOrders(ordersResponse.data.orders.filter(isPendingPaymentOrder)));
    } catch {
      if (!options.silent) {
        toast.error('订单加载失败');
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void fetchOrders();
    fetchSummary().catch(() => toast.error('完成计数加载失败'));
  }, []);

  useEffect(() => {
    if (!socket) return;

    const handleNew = (order: OrderItem) => {
      if (isPendingPaymentOrder(order)) {
        fetchSummary().catch(() => undefined);
        toast.success('有新任务可领取');
      }
    };

    const handleCompleted = (data: { id: string }) => {
      setOrders((previousOrders) => previousOrders.filter((order) => order.id !== data.id));
      fetchSummary().catch(() => toast.error('完成计数刷新失败'));
    };

    socket.on('order:new', handleNew);
    socket.on('order:completed', handleCompleted);

    return () => {
      socket.off('order:new', handleNew);
      socket.off('order:completed', handleCompleted);
    };
  }, [socket]);

  useAutoRefresh(
    () => Promise.all([
      fetchOrders({ silent: true }),
      fetchSummary(),
    ]).then(() => undefined),
    AUTO_REFRESH_INTERVAL_MS,
  );

  const handleComplete = async (orderId: string) => {
    if (!confirm('确认这笔 Pix 已完成付款？')) return;
    setCompleting(orderId);
    try {
      await api.post(`/worker/orders/${orderId}/complete`);
      setOrders((previousOrders) => previousOrders.filter((order) => order.id !== orderId));
      await fetchSummary();
      toast.success('订单已标记完成');
    } catch {
      toast.error('标记完成失败');
    } finally {
      setCompleting(null);
    }
  };

  const handleClaimNext = async () => {
    setClaiming(true);
    try {
      const res = await api.post('/worker/orders/claim-next');
      if (res.data.order) {
        toast.success('任务已领取');
      } else {
        toast.error('暂无可领取任务');
      }
      await Promise.all([fetchOrders({ silent: true }), fetchSummary()]);
    } catch {
      toast.error('领取任务失败');
    } finally {
      setClaiming(false);
    }
  };

  useEffect(() => {
    if (orders.length === 0) return;

    const interval = window.setInterval(() => {
      void Promise.all(
        orders.map((order) => api.post(`/worker/orders/${order.id}/renew`).catch(() => undefined)),
      );
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [orders]);

  return (
    <main className="min-h-screen bg-app-body px-4 py-5 text-app-primary sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <header className="rounded-card border border-app-border bg-app-surface p-4 shadow-checkout">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="grid gap-2 text-sm font-semibold text-app-primary sm:grid-cols-3">
              <span>我的总完成 {summary.completedTotal} 单</span>
              <span>我的今日 {summary.completedToday} 单</span>
              <span>我的本周 {summary.completedThisWeek} 单</span>
              <span>我的任务 {summary.claimedCount} 单</span>
              <span>可领取 {summary.availableCount} 单</span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={handleClaimNext}
                disabled={claiming}
                className="rounded-lg bg-app-accent px-4 py-2 text-sm font-semibold text-white hover:bg-app-accentHover disabled:opacity-50"
              >
                {claiming ? '领取中...' : '领取任务'}
              </button>
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-app-muted p-1">
                <button
                  type="button"
                  aria-pressed={viewMode === 'qr'}
                  onClick={() => setViewMode('qr')}
                  className={viewMode === 'qr' ? activeModeClass : inactiveModeClass}
                >
                  二维码
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === 'pix'}
                  onClick={() => setViewMode('pix')}
                  className={viewMode === 'pix' ? activeModeClass : inactiveModeClass}
                >
                  Pix 付款码
                </button>
              </div>
            </div>
          </div>
        </header>

        {loading ? (
          <div className="flex min-h-[60vh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
          </div>
        ) : orders.length === 0 ? (
          <div className="flex min-h-[60vh] items-center justify-center rounded-card border border-app-border bg-app-surface p-6 text-center text-app-secondary">
            暂无已领取任务，点击“领取任务”获取下一单
          </div>
        ) : (
          <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {orders.map((order, index) => (
              <OrderCard
                key={order.id}
                order={order}
                sequence={index + 1}
                viewMode={viewMode}
                completing={completing === order.id}
                onComplete={() => handleComplete(order.id)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function OrderCard({
  order,
  sequence,
  viewMode,
  completing,
  onComplete,
}: {
  order: OrderItem;
  sequence: number;
  viewMode: WorkerViewMode;
  completing: boolean;
  onComplete: () => void;
}) {
  return (
    <section className="rounded-card border border-app-border bg-app-surface p-4 shadow-checkout sm:p-5">
      <div className="mb-4 text-2xl font-bold text-app-primary">#{sequence}</div>

      {viewMode === 'qr' ? <WorkerQrBlock order={order} /> : <WorkerPixCodeBlock pixCode={order.pixCode} />}
      <button
        type="button"
        onClick={onComplete}
        disabled={completing}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-app-accent py-3 font-medium text-white transition-colors hover:bg-app-accentHover disabled:opacity-50"
      >
        {completing ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
        标记为已完成
      </button>
    </section>
  );
}

function WorkerQrBlock({ order }: { order: OrderItem }) {
  const qrImageSrc = order.pixImageUrl ?? (order.pixQrPngBase64 ? `data:image/png;base64,${order.pixQrPngBase64}` : null);

  if (!qrImageSrc) {
    return (
      <div className="rounded-xl border border-dashed border-app-border p-6 text-center text-app-secondary">
        暂无二维码
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      <img
        src={qrImageSrc}
        alt="Pix 二维码"
        className="h-auto w-full max-w-[320px] rounded-xl border border-app-border bg-white p-3"
      />
    </div>
  );
}

function WorkerPixCodeBlock({ pixCode }: { pixCode: string | null }) {
  const handleCopy = async () => {
    if (!pixCode) return;
    try {
      await navigator.clipboard.writeText(pixCode);
      toast.success('Pix 付款码已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-app-secondary">Pix 付款码</label>
      <div className="flex gap-2">
        <input
          readOnly
          value={pixCode ?? ''}
          className="min-w-0 flex-1 rounded-lg border border-app-border bg-app-muted px-3 py-2 text-sm text-app-primary"
        />
        <button
          type="button"
          onClick={handleCopy}
          disabled={!pixCode}
          className="inline-flex items-center justify-center rounded-lg border border-app-border px-3 text-app-secondary transition-colors hover:text-app-primary disabled:opacity-50"
        >
          <Copy size={16} />
          <span className="sr-only">复制</span>
        </button>
      </div>
    </div>
  );
}

function upsertVisibleOrder(previousOrders: OrderItem[], order: OrderItem) {
  if (!isPendingPaymentOrder(order)) return previousOrders;
  const nextOrders = previousOrders.filter((existingOrder) => existingOrder.id !== order.id);
  nextOrders.push(order);
  return sortWorkerOrders(nextOrders);
}

function isPendingPaymentOrder(order: OrderItem) {
  return order.status === 'PENDING_PAYMENT';
}

function sortWorkerOrders(orders: OrderItem[]) {
  return [...orders].sort((firstOrder, secondOrder) => {
    const createdAtComparison = firstOrder.createdAt.localeCompare(secondOrder.createdAt);
    if (createdAtComparison !== 0) return createdAtComparison;
    return firstOrder.id.localeCompare(secondOrder.id);
  });
}

const activeModeClass = 'rounded-lg bg-app-surface px-4 py-2 text-sm font-semibold text-app-primary shadow-sm';
const inactiveModeClass = 'rounded-lg px-4 py-2 text-sm font-medium text-app-secondary transition-colors hover:text-app-primary';
