import { useState, useEffect } from 'react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from 'recharts';
import {
  ShoppingCart, CheckCircle, AlertTriangle, Ticket, Users, Clock, Loader2,
} from 'lucide-react';

interface DashboardData {
  totals: {
    totalOrders: number;
    pendingOrders: number;
    completedOrders: number;
    failedOrders: number;
    cancelledOrders: number;
    expiredOrders: number;
    totalCodes: number;
    unusedCodes: number;
  };
  dailyTrend: Array<{ date: string; created: number; completed: number; failed: number }>;
  workerPerformance: Array<{
    workerId: string;
    displayName: string;
    completedCount: number;
    avgCompletionMinutes: number;
  }>;
}

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/admin/dashboard')
      .then((res) => setData(res.data))
      .catch(() => setError('看板数据加载失败'))
      .finally(() => setLoading(false));
  }, []);

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
    { label: '已完成', value: data.totals.completedOrders, icon: CheckCircle, color: 'bg-emerald-600' },
    { label: '失败订单', value: data.totals.failedOrders, icon: AlertTriangle, color: 'bg-red-600' },
    { label: '兑换码总数', value: data.totals.totalCodes, icon: Ticket, color: 'bg-neutral-800' },
    { label: '未使用兑换码', value: data.totals.unusedCodes, icon: Ticket, color: 'bg-neutral-700' },
  ];

  return (
    <Layout>
      <h2 className="mb-6 text-2xl font-bold text-app-primary">数据看板</h2>

      <div className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${card.color} text-white`}>
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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout">
          <h3 className="text-lg font-semibold mb-4">近 30 天趋势</h3>
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

        <div className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout">
          <h3 className="text-lg font-semibold mb-4">工人绩效</h3>
          {data.workerPerformance.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-app-secondary">
              <div className="text-center">
                <Users className="mx-auto mb-2 h-12 w-12" />
                <p>暂无工人数据</p>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.workerPerformance}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="displayName" tick={{ fontSize: 12 }} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="completedCount" fill="#111827" name="已完成" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </Layout>
  );
}
