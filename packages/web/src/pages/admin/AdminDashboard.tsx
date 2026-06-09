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
    pixWorkerConcurrency: number;
    paymentDetectionConcurrency: number;
    averageGenerationSeconds: number;
    successRateLastHour: number;
  };
  proxyHealth: {
    chatGpt: ProxyHealthGroup;
    stripe: ProxyHealthGroup;
  };
  workerPerformance: {
    totalWorkers: number;
    enabledWorkers: number;
    claimedOrders: number;
    unclaimedPendingOrders: number;
    assignedCompletedToday: number;
    assignedCompletedThisWeek: number;
    unassignedCompletedToday: number;
    unassignedCompletedThisWeek: number;
    topWorkers: Array<{
      id: string;
      username: string;
      displayName: string | null;
      enabled: boolean;
      completedTotal: number;
      completedToday: number;
      completedThisWeek: number;
      claimedCount: number;
      lastCompletedAt: string | null;
    }>;
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
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchDashboard = async (options: FetchDashboardOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const res = await api.get('/admin/dashboard');
      setDashboardData(res.data);
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

  if (loading || !dashboardData) {
    return (
      <Layout>
        <div className="flex justify-center py-20">
          {loading ? <Loader2 className="h-8 w-8 animate-spin text-app-accent" /> : <p className="text-app-secondary">{error}</p>}
        </div>
      </Layout>
    );
  }

  const statCards = [
    { label: '订单总数', value: dashboardData.totals.totalOrders, icon: ShoppingCart, color: 'bg-neutral-950' },
    { label: '待支付', value: dashboardData.totals.pendingOrders, icon: Clock, color: 'bg-amber-600' },
    { label: '总已完成', value: dashboardData.totals.completedTotal, icon: CheckCircle, color: 'bg-emerald-700' },
    { label: '今日已完成', value: dashboardData.totals.completedToday, icon: CalendarDays, color: 'bg-sky-700' },
    { label: '本周已完成', value: dashboardData.totals.completedThisWeek, icon: CalendarDays, color: 'bg-cyan-700' },
    { label: '失败订单', value: dashboardData.totals.failedOrders, icon: AlertTriangle, color: 'bg-red-600' },
    { label: '本地兑换码', value: dashboardData.totals.totalCodes, icon: Ticket, color: 'bg-neutral-800' },
    { label: '未用本地码', value: dashboardData.totals.unusedCodes, icon: Ticket, color: 'bg-neutral-700' },
  ];

  return (
    <Layout>
      <h2 className="mb-6 text-2xl font-bold text-app-primary">数据看板</h2>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout">
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
        <QueueMetricCard label="队列等待" value={dashboardData.queue.waitingCount + dashboardData.queue.delayedCount} />
        <QueueMetricCard label="处理中" value={dashboardData.queue.activeCount} />
        <QueueMetricCard label="失败任务" value={dashboardData.queue.failedCount} />
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <OperationalNote
          title={`最老等待 ${formatMinutes(dashboardData.queue.oldestWaitingSeconds)} 分钟`}
          body={`生成并发 ${dashboardData.queue.pixWorkerConcurrency}，检测并发 ${dashboardData.queue.paymentDetectionConcurrency}，平均生成耗时 ${formatSeconds(dashboardData.queue.averageGenerationSeconds)}，近 1 小时成功率 ${dashboardData.queue.successRateLastHour}%`}
        />
        <ProxyHealthCard title="ChatGPT 代理" health={dashboardData.proxyHealth.chatGpt} />
        <ProxyHealthCard title="Stripe 代理" health={dashboardData.proxyHealth.stripe} />
      </div>

      <div className="mb-8 rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">工人绩效</h3>
            <p className="text-sm text-app-secondary">
              启用工人 {dashboardData.workerPerformance.enabledWorkers} / {dashboardData.workerPerformance.totalWorkers}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <span>已领取 {dashboardData.workerPerformance.claimedOrders}</span>
            <span>未领取 {dashboardData.workerPerformance.unclaimedPendingOrders}</span>
            <span>归属今日 {dashboardData.workerPerformance.assignedCompletedToday}</span>
            <span>未归属今日 {dashboardData.workerPerformance.unassignedCompletedToday}</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[640px] w-full text-sm">
            <thead className="bg-neutral-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-app-secondary">工人</th>
                <th className="px-4 py-2 text-left font-medium text-app-secondary">今日</th>
                <th className="px-4 py-2 text-left font-medium text-app-secondary">本周</th>
                <th className="px-4 py-2 text-left font-medium text-app-secondary">总完成</th>
                <th className="px-4 py-2 text-left font-medium text-app-secondary">已领取</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {dashboardData.workerPerformance.topWorkers.map((worker) => (
                <tr key={worker.id}>
                  <td className="px-4 py-2">{worker.displayName ?? worker.username}</td>
                  <td className="px-4 py-2">今日 {worker.completedToday} 单</td>
                  <td className="px-4 py-2">{worker.completedThisWeek}</td>
                  <td className="px-4 py-2">{worker.completedTotal}</td>
                  <td className="px-4 py-2">{worker.claimedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6">
        <h3 className="mb-4 text-lg font-semibold">近 30 天趋势</h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={dashboardData.dailyTrend}>
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
    <div className="rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout">
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
    <div className="rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout">
      <p className="font-semibold text-app-primary">{title}</p>
      <p className="mt-2 text-sm text-app-secondary">{body}</p>
    </div>
  );
}

function ProxyHealthCard({ title, health }: { title: string; health: ProxyHealthGroup }) {
  return (
    <div className="rounded-lg border border-app-border bg-app-surface p-4 shadow-checkout">
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
