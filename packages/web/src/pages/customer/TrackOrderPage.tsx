import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../api/client';
import { useOrderTracking } from '../../hooks/useSocket';
import QrCodeDisplay from '../../components/QrCodeDisplay';
import StatusBadge from '../../components/StatusBadge';
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

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

  useEffect(() => {
    if (!trackingToken) return;
    api
      .get(`/orders/track/${trackingToken}`)
      .then((res) => setOrder(res.data))
      .catch((err) => setError(err.response?.data?.error ?? 'Failed to load order'))
      .finally(() => setLoading(false));
  }, [trackingToken]);

  const handleStatusChange = useCallback((data: { status: string; completedAt: string | null }) => {
    setOrder((prev) => (prev ? { ...prev, status: data.status, completedAt: data.completedAt } : prev));
  }, []);

  useOrderTracking(trackingToken, handleStatusChange);

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
          <p className="text-lg text-gray-600">{error || 'Order not found'}</p>
          <Link to="/" className="mt-4 inline-block text-indigo-600 hover:underline">
            Back to home
          </Link>
        </div>
      </div>
    );
  }

  const isCompleted = order.status === 'PAYMENT_COMPLETED';
  const isFailed = order.status === 'FAILED';
  const isPending = order.status === 'PENDING_PAYMENT';

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 px-8 py-6 text-center">
          <h1 className="text-xl font-bold text-white">Order Status</h1>
          <p className="text-indigo-200 text-sm mt-1 font-mono">{order.trackingToken}</p>
        </div>

        <div className="p-8">
          <div className="text-center mb-6">
            <StatusBadge status={order.status} />
            <p className="text-sm text-gray-500 mt-2">
              Created: {new Date(order.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>

          {isCompleted && (
            <div className="flex flex-col items-center gap-4 py-8">
              <CheckCircle className="w-20 h-20 text-green-500" />
              <h2 className="text-xl font-bold text-green-700">Payment Completed!</h2>
              {order.completedAt && (
                <p className="text-sm text-gray-500">
                  Completed at: {new Date(order.completedAt).toLocaleString('zh-CN')}
                </p>
              )}
            </div>
          )}

          {isFailed && (
            <div className="flex flex-col items-center gap-4 py-8">
              <AlertCircle className="w-20 h-20 text-red-400" />
              <h2 className="text-lg font-bold text-red-700">Order Failed</h2>
              {order.errorMessage && (
                <p className="text-sm text-gray-500 text-center max-w-sm">{order.errorMessage}</p>
              )}
            </div>
          )}

          {isPending && (
            <div>
              <div className="flex items-center justify-center gap-2 mb-6">
                <div className="w-3 h-3 bg-yellow-400 rounded-full animate-pulse" />
                <span className="text-sm text-gray-600">Waiting for payment...</span>
              </div>
              <QrCodeDisplay
                pixCode={order.pixCode}
                pixQrPngBase64={order.pixQrPngBase64}
                pixImageUrl={order.pixImageUrl}
                pixExpiresAt={order.pixExpiresAt}
              />
            </div>
          )}
        </div>

        <div className="px-8 pb-6 text-center">
          <Link to="/" className="text-sm text-indigo-600 hover:underline">
            Submit another order
          </Link>
        </div>
      </div>
    </div>
  );
}
