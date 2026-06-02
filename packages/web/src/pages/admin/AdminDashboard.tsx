import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  ShoppingCart, CheckCircle, AlertTriangle, Ticket, Clock, Loader2, CalendarDays, Activity,
} from 'lucide-react';

interface DashboardData {
  totals: {
    totalOrders: number;
    pendingOrders: number;
    completedTotal: number;
    completedToday: number;
    completedThisWeek: number;
    failedOrders: number;
    cancelledOrders: number;
    expiredOrders: number;
    totalCodes: number;
    unusedCodes: number;
  };
  queue: {
    waitingCount: number;
    delayedCount: number;
    activeCount: number;
    failedCount: number;
    oldestWaitingSeconds: number | null;
    averageGenerationSeconds: number;
    successRateLastHour: number;
  };
  proxyHealth: {
    chatGpt: ProxyHealthGroup;
    stripe: ProxyHealthGroup;
  };
  dailyTrend: Array<{ date: string; created: number; completed: number; failed: number }>;
}

interface ProxyHealthGroup {
  total: number;
  healthy: number;
  coolingDown: number;
}

interface FetchDashboardOptions {
  silent?: boolean;
}

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchDashboard = async (options: FetchDashboardOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const res = await api.get('/admin/dashboard');
      setData(res.data);
      setError('');
    } catch {
      if (!options.silent) {
        setError('看板数据加载失败');
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void fetchDashboard();
  }, []);

  useAutoRefresh(() => fetchDashboard({ silent: true }), AUTO_REFRESH_INTERVAL_MS);

  if (loading || !data) {
    return (
      <Layout>
        <div className="flex justify-center py-20">
          {loading ? <Loader2 className="h-8 w-8 animate-spin text-app-accent" /> : <p className="text-app-secondary">{error}</p>}
        </div>
      </Layout>
    );
  }

  const statCards = [
    { label: '订单总数', value: data.totals.totalOrders, icon: ShoppingCart, color: 'bg-neutral-950' },
    { label: '待支付', value: data.totals.pendingOrders, icon: Clock, color: 'bg-amber-600' },
    { label: '总已完成', value: data.totals.completedTotal, icon: CheckCircle, color: 'bg-emerald-700' },
    { label: '今日已完成', value: data.totals.completedToday, icon: CalendarDays, color: 'bg-sky-700' },
    { label: '本周已完成', value: data.totals.completedThisWeek, icon: CalendarDays, color: 'bg-cyan-700' },
    { label: '失败订单', value: data.totals.failedOrders, icon: AlertTriangle, color: 'bg-red-600' },
    { label: '兑换码总数', value: data.totals.totalCodes, icon: Ticket, color: 'bg-neutral-800' },
    { label: '未使用兑换码', value: data.totals.unusedCodes, icon: Ticket, color: 'bg-neutral-700' },
  ];

  return (
    <Layout>
      <h2 className="mb-6 text-2xl font-bold text-app-primary">数据看板</h2>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout">
              <div className="flex items-center gap-3">
                <div className={`rounded-lg p-2 ${card.color} text-white`}>
                  <Icon size={18} />
                </div>
                <div>
                  <p className="text-2xl font-bold">{card.value}</p>
                  <p className="text-xs text-app-secondary">{card.label}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <QueueMetricCard label="队列等待" value={data.queue.waitingCount + data.queue.delayedCount} />
        <QueueMetricCard label="处理中" value={data.queue.activeCount} />
        <QueueMetricCard label="失败任务" value={data.queue.failedCount} />
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <OperationalNote
          title={`最老等待 ${formatMinutes(data.queue.oldestWaitingSeconds)} 分钟`}
          body={`平均生成耗时 ${formatSeconds(data.queue.averageGenerationSeconds)}，近 1 小时成功率 ${data.queue.successRateLastHour}%`}
        />
        <ProxyHealthCard title="ChatGPT 代理" health={data.proxyHealth.chatGpt} />
        <ProxyHealthCard title="Stripe 代理" health={data.proxyHealth.stripe} />
      </div>

      <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6">
        <h3 className="mb-4 text-lg font-semibold">近 30 天趋势</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.dailyTrend}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} />
            <YAxis />
            <Tooltip />
            <Line type="monotone" dataKey="created" stroke="#111827" name="新建" />
            <Line type="monotone" dataKey="completed" stroke="#22c55e" name="已完成" />
            <Line type="monotone" dataKey="failed" stroke="#ef4444" name="失败" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Layout>
  );
}

function QueueMetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-indigo-700 p-2 text-white">
          <Activity size={18} />
        </div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-app-secondary">{label}</p>
        </div>
      </div>
    </div>
  );
}

function OperationalNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout">
      <p className="font-semibold text-app-primary">{title}</p>
      <p className="mt-2 text-sm text-app-secondary">{body}</p>
    </div>
  );
}

function ProxyHealthCard({ title, health }: { title: string; health: ProxyHealthGroup }) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout">
      <p className="font-semibold text-app-primary">{title}</p>
      <p className="mt-2 text-sm text-app-secondary">
        健康 {health.healthy} / 总数 {health.total}，冷却 {health.coolingDown}
      </p>
    </div>
  );
}

function formatMinutes(seconds: number | null): number {
  if (!seconds) return 0;
  return Math.ceil(seconds / 60);
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}
