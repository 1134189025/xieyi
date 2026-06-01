import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useSocket } from '../../hooks/useSocket';
import QrCodeDisplay from '../../components/QrCodeDisplay';
import toast from 'react-hot-toast';
import { CheckCircle, Loader2 } from 'lucide-react';

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
    <main className="min-h-screen bg-app-body px-4 py-5 text-app-primary sm:px-6 lg:px-8">
      {loading ? (
        <div className="flex min-h-[70vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
        </div>
      ) : orders.length === 0 ? (
        <div className="flex min-h-[70vh] items-center justify-center text-center text-app-secondary">
          暂无待付款
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-5 sm:gap-6 md:grid-cols-2 xl:grid-cols-3">
          {orders.map((order) => (
            <section key={order.id} className="rounded-card border border-app-border bg-app-surface p-4 shadow-checkout sm:p-5">
              <QrCodeDisplay
                pixCode={order.pixCode}
                pixQrPngBase64={order.pixQrPngBase64}
                pixImageUrl={order.pixImageUrl}
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
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
