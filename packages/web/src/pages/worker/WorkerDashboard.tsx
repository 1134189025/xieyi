import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useSocket } from '../../hooks/useSocket';
import QrCodeDisplay from '../../components/QrCodeDisplay';
import Layout from '../../components/Layout';
import toast from 'react-hot-toast';
import { CheckCircle, Loader2, QrCode } from 'lucide-react';

interface OrderItem {
  id: string;
  trackingToken: string;
  status: string;
  pixCode: string;
  pixQrPngBase64: string | null;
  pixExpiresAt: string | null;
  pixImageUrl: string | null;
  createdAt: string;
}

export default function WorkerDashboard() {
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState<string | null>(null);
  const { token } = useAuth();
  const socket = useSocket('/worker', token);

  const fetchOrders = async () => {
    try {
      const res = await api.get('/worker/orders?limit=50');
      setOrders(res.data.orders);
    } catch {
      toast.error('订单加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  useEffect(() => {
    if (!socket) return;

    const handleNew = (order: OrderItem) => {
      setOrders((prev) => [...prev, order]);
      toast.success('收到新订单');
    };

    const handleCompleted = (data: { id: string }) => {
      setOrders((prev) => prev.filter((o) => o.id !== data.id));
    };

    socket.on('order:new', handleNew);
    socket.on('order:completed', handleCompleted);

    return () => {
      socket.off('order:new', handleNew);
      socket.off('order:completed', handleCompleted);
    };
  }, [socket]);

  const handleComplete = async (orderId: string) => {
    if (!confirm('确认这笔 Pix 已完成付款？')) return;
    setCompleting(orderId);
    try {
      await api.post(`/worker/orders/${orderId}/complete`);
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
      toast.success('订单已标记完成');
    } catch {
      toast.error('标记完成失败');
    } finally {
      setCompleting(null);
    }
  };

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-app-primary">待处理订单</h2>
        <p className="mt-1 text-app-secondary">{orders.length} 个订单等待付款</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
        </div>
      ) : orders.length === 0 ? (
        <div className="py-20 text-center">
          <QrCode className="mx-auto mb-4 h-16 w-16 text-neutral-300" />
          <p className="text-lg text-app-secondary">暂无待处理订单</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {orders.map((order) => (
            <div key={order.id} className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <p className="font-mono text-xs text-app-secondary">{order.trackingToken}</p>
                  <p className="mt-1 text-xs text-app-secondary">
                    {new Date(order.createdAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                <span className="rounded-full border border-[#e7dfca] bg-[#fffaf0] px-2 py-0.5 text-xs text-[#6b4e16]">
                  待支付
                </span>
              </div>

              <QrCodeDisplay
                pixCode={order.pixCode}
                pixQrPngBase64={order.pixQrPngBase64}
                pixImageUrl={order.pixImageUrl}
                pixExpiresAt={order.pixExpiresAt}
              />

              <button
                onClick={() => handleComplete(order.id)}
                disabled={completing === order.id}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-app-accent py-3 font-medium text-white transition-colors hover:bg-app-accentHover disabled:opacity-50"
              >
                {completing === order.id ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <CheckCircle size={16} />
                )}
                标记为已完成
              </button>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}
