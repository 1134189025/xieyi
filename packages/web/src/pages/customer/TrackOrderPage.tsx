import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { publicApi } from '../../api/client';
import { useOrderTracking } from '../../hooks/useSocket';
import { useAutoRefresh } from '../../hooks/useAutoRefresh';
import QrCodeDisplay from '../../components/QrCodeDisplay';
import StatusBadge from '../../components/StatusBadge';
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { safeErrorMessage } from '../../utils/labels';

interface OrderData {
  trackingToken: string;
  status: string;
  pixCode: string | null;
  pixQrPngBase64: string | null;
  pixExpiresAt: string | null;
  pixImageUrl: string | null;
  completedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  queueEstimate: QueueEstimate | null;
}

interface QueueEstimate {
  ordersAhead: number;
  position: number;
  pendingTotal: number;
  estimatedQueueSeconds: number;
  secondsPerOrder: number;
  calculationSource: 'recent_completion_cadence' | 'default' | 'generation_queue';
  calculatedAt: string;
  currentGenerationCount?: number;
}

interface FetchOrderOptions {
  silent?: boolean;
}

export default function TrackOrderPage() {
  const { trackingToken } = useParams<{ trackingToken: string }>();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchOrder = useCallback(async (options: FetchOrderOptions = {}) => {
    if (!trackingToken) return;
    try {
      const res = await publicApi.get(`/orders/track/${trackingToken}`);
      setOrder(res.data);
      setError('');
    } catch (err) {
      if (!options.silent) {
        setError(safeErrorMessage(err, '订单加载失败'));
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }, [trackingToken]);

  const refreshOrderFromSocket = useCallback(() => {
    void fetchOrder({ silent: true });
  }, [fetchOrder]);

  useEffect(() => {
    void fetchOrder();
  }, [fetchOrder]);

  useAutoRefresh(
    () => fetchOrder({ silent: true }),
    order?.status === 'CREATING_PAYMENT' ? 5_000 : 10_000,
    order?.status === 'PENDING_PAYMENT' || order?.status === 'CREATING_PAYMENT',
  );

  useOrderTracking(trackingToken, refreshOrderFromSocket);

  if (loading) {
    return (
      <div className="checkout-shell">
        <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="checkout-shell">
        <div className="checkout-container">
          <div className="checkout-content text-center">
            <AlertCircle className="mx-auto mb-4 h-16 w-16 text-app-error" />
            <p className="text-lg text-app-secondary">{error || '未找到订单'}</p>
            <Link to="/" className="checkout-link mt-4">
              返回首页
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isCompleted = order.status === 'PAYMENT_COMPLETED';
  const isFailed = order.status === 'FAILED';
  const isPending = order.status === 'PENDING_PAYMENT';
  const isCreating = order.status === 'CREATING_PAYMENT';
  const isClosed = order.status === 'EXPIRED' || order.status === 'CANCELLED';

  return (
    <div className="checkout-shell">
      <div className="checkout-container">
        <div className="checkout-content">
          <div className="checkout-brand-row flex-col items-start sm:flex-row sm:items-center">
            <div className="min-w-0">
              <h1 className="checkout-title">{isPending ? '等待 Pix 付款' : '订单状态'}</h1>
              <p className="mt-2 break-all font-mono text-xs text-app-secondary">{order.trackingToken}</p>
            </div>
            <StatusBadge status={order.status} />
          </div>

          <p className="checkout-lead">
            创建时间：{new Date(order.createdAt).toLocaleString('zh-CN')}
          </p>

          {isCompleted && <CompletedOrder order={order} />}
          {isFailed && <FailedOrder order={order} />}
          {isCreating && <CreatingPaymentOrder queueEstimate={order.queueEstimate} />}
          {isPending && (
            <div className="view-section">
              <p className="checkout-lead">请让工人扫描二维码，或复制 Pix 付款码完成付款确认。</p>
              {order.queueEstimate && <PendingQueueEstimateCard queueEstimate={order.queueEstimate} />}
              <QrCodeDisplay
                pixCode={order.pixCode}
                pixQrPngBase64={order.pixQrPngBase64}
                pixImageUrl={order.pixImageUrl}
                pixExpiresAt={order.pixExpiresAt}
              />
            </div>
          )}
          {isClosed && <ClosedOrder />}

          {!isCompleted && (
            <div className="mt-6 text-center">
              <Link to="/" className="checkout-link">
                提交新订单
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CompletedOrder({ order }: { order: OrderData }) {
  return (
    <div className="view-section py-8 text-center">
      <div className="success-icon">
        <CheckCircle />
      </div>
      <h2 className="text-2xl font-extrabold tracking-tight text-app-primary">支付已完成</h2>
      <p className="mt-2 text-sm text-app-secondary">Pix 付款已经确认，订单状态已同步更新。</p>
      {order.completedAt && (
        <div className="mt-6 flex justify-between border-t border-app-border pt-4 text-sm">
          <span className="text-app-secondary">完成时间</span>
          <strong className="text-app-primary">
            {new Date(order.completedAt).toLocaleString('zh-CN')}
          </strong>
        </div>
      )}
      <Link to="/" className="checkout-button mt-6 inline-block text-center">
        提交新订单
      </Link>
    </div>
  );
}

function FailedOrder({ order }: { order: OrderData }) {
  return (
    <div className="view-section py-8 text-center">
      <AlertCircle className="mx-auto h-16 w-16 text-app-error" />
      <h2 className="mt-4 text-xl font-extrabold text-app-primary">订单失败</h2>
      {order.errorMessage && (
        <p className="mx-auto mt-2 max-w-sm text-sm text-app-secondary">{order.errorMessage}</p>
      )}
    </div>
  );
}

function CreatingPaymentOrder({ queueEstimate }: { queueEstimate: QueueEstimate | null }) {
  return (
    <div className="view-section py-8 text-center">
      <Loader2 className="mx-auto h-12 w-12 animate-spin text-app-accent" />
      <h2 className="mt-4 text-xl font-extrabold text-app-primary">正在排队生成 Pix 二维码</h2>
      <p className="mt-2 text-sm text-app-secondary">订单已经记录，worker 空闲后会自动生成 Pix。</p>
      {queueEstimate && <GenerationQueueEstimateCard queueEstimate={queueEstimate} />}
    </div>
  );
}

function ClosedOrder() {
  return (
    <div className="view-section py-8 text-center">
      <AlertCircle className="mx-auto h-16 w-16 text-app-secondary" />
      <p className="mt-4 text-sm text-app-secondary">订单已关闭，无法继续支付。</p>
    </div>
  );
}

function GenerationQueueEstimateCard({ queueEstimate }: { queueEstimate: QueueEstimate }) {
  const estimatedMinutes = Math.max(1, Math.ceil(queueEstimate.estimatedQueueSeconds / 60));
  return (
    <div className="mt-5 rounded-2xl border border-app-border bg-[#fbfcfd] p-4 text-left shadow-sm">
      <div className="text-sm font-bold text-app-primary">排队 #{queueEstimate.position}</div>
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-app-secondary sm:grid-cols-3">
        <span>前方 {queueEstimate.ordersAhead} 单</span>
        <span>生成中 {queueEstimate.currentGenerationCount ?? 0} 单</span>
        <span>预计约 {estimatedMinutes} 分钟</span>
      </div>
    </div>
  );
}

function PendingQueueEstimateCard({ queueEstimate }: { queueEstimate: QueueEstimate }) {
  const estimatedMinutes = Math.max(1, Math.ceil(queueEstimate.estimatedQueueSeconds / 60));
  const estimateText = queueEstimate.ordersAhead === 0
    ? '前方无排队订单，预计很快处理'
    : `前方 ${queueEstimate.ordersAhead} 单 · 排队第 ${queueEstimate.position} 位 · 预计约 ${estimatedMinutes} 分钟`;

  return (
    <div className="mb-5 rounded-2xl border border-app-border bg-[#fbfcfd] p-4 shadow-sm">
      <div className="text-sm font-bold text-app-primary">{estimateText}</div>
      <div className="mt-2 text-xs text-app-secondary">
        当前待处理 {queueEstimate.pendingTotal} 单，估算时间会随队列变化自动刷新。
      </div>
    </div>
  );
}
