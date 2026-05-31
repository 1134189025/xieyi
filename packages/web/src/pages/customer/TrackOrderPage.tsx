import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { publicApi } from '../../api/client';
import { useOrderTracking } from '../../hooks/useSocket';
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
}

export default function TrackOrderPage() {
  const { trackingToken } = useParams<{ trackingToken: string }>();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchOrder = useCallback(async () => {
    if (!trackingToken) return;
    try {
      const res = await publicApi.get(`/orders/track/${trackingToken}`);
      setOrder(res.data);
      setError('');
    } catch (err) {
      setError(safeErrorMessage(err, '订单加载失败'));
    } finally {
      setLoading(false);
    }
  }, [trackingToken]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  useOrderTracking(trackingToken, fetchOrder);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
          <p className="text-lg text-gray-600">{error || '未找到订单'}</p>
          <Link to="/" className="mt-4 inline-block text-indigo-600 hover:underline">
            返回首页
          </Link>
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
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 px-8 py-6 text-center">
          <h1 className="text-xl font-bold text-white">订单状态</h1>
          <p className="text-indigo-200 text-sm mt-1 font-mono">{order.trackingToken}</p>
        </div>

        <div className="p-8">
          <div className="text-center mb-6">
            <StatusBadge status={order.status} />
            <p className="text-sm text-gray-500 mt-2">
              创建时间：{new Date(order.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>

          {isCompleted && (
            <div className="flex flex-col items-center gap-4 py-8">
              <CheckCircle className="w-20 h-20 text-green-500" />
              <h2 className="text-xl font-bold text-green-700">支付已完成</h2>
              {order.completedAt && (
                <p className="text-sm text-gray-500">
                  完成时间：{new Date(order.completedAt).toLocaleString('zh-CN')}
                </p>
              )}
            </div>
          )}

          {isFailed && (
            <div className="flex flex-col items-center gap-4 py-8">
              <AlertCircle className="w-20 h-20 text-red-400" />
              <h2 className="text-lg font-bold text-red-700">订单失败</h2>
              {order.errorMessage && (
                <p className="text-sm text-gray-500 text-center max-w-sm">{order.errorMessage}</p>
              )}
            </div>
          )}

          {isCreating && (
            <div className="flex flex-col items-center gap-4 py-8">
              <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
              <p className="text-sm text-gray-600">正在生成 Pix 二维码，请稍候...</p>
            </div>
          )}

          {isPending && (
            <div>
              <div className="flex items-center justify-center gap-2 mb-6">
                <div className="w-3 h-3 bg-yellow-400 rounded-full animate-pulse" />
                <span className="text-sm text-gray-600">等待工人扫码付款...</span>
              </div>
              <QrCodeDisplay
                pixCode={order.pixCode}
                pixQrPngBase64={order.pixQrPngBase64}
                pixImageUrl={order.pixImageUrl}
                pixExpiresAt={order.pixExpiresAt}
              />
            </div>
          )}

          {isClosed && (
            <div className="flex flex-col items-center gap-4 py-8">
              <AlertCircle className="w-16 h-16 text-gray-400" />
              <p className="text-sm text-gray-600">订单已关闭，无法继续支付。</p>
            </div>
          )}
        </div>

        <div className="px-8 pb-6 text-center">
          <Link to="/" className="text-sm text-indigo-600 hover:underline">
            提交新订单
          </Link>
        </div>
      </div>
    </div>
  );
}
