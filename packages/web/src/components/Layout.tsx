import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  LayoutDashboard,
  Ticket,
  Users,
  ClipboardList,
  BarChart3,
  LogOut,
  QrCode,
  Settings,
} from 'lucide-react';
import clsx from 'clsx';
import { roleLabel } from '../utils/labels';

const ADMIN_NAV = [
  { to: '/admin', label: '看板', icon: LayoutDashboard },
  { to: '/admin/codes', label: '兑换码', icon: Ticket },
  { to: '/admin/workers', label: '工人管理', icon: Users },
  { to: '/admin/orders', label: '订单管理', icon: ClipboardList },
  { to: '/admin/settings', label: '系统设置', icon: Settings },
];

const WORKER_NAV = [
  { to: '/worker', label: '待处理订单', icon: QrCode },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, isAdmin } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const navItems = isAdmin ? ADMIN_NAV : WORKER_NAV;

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-app-body text-app-primary">
      <aside className="flex w-64 flex-col border-r border-app-border bg-app-surface shadow-checkout">
        <div className="border-b border-app-border p-6">
          <h1 className="text-xl font-extrabold tracking-tight text-app-primary">Pix 协议支付</h1>
          <p className="mt-1 text-sm text-app-secondary">{user?.displayName ?? user?.username}</p>
          <span className="mt-2 inline-block rounded-full border border-app-border bg-white px-2 py-0.5 text-xs font-medium text-app-secondary">
            {roleLabel(user?.role)}
          </span>
        </div>

        <nav className="flex-1 py-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = location.pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={clsx(
                  'flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors',
                  active
                    ? 'border-r-4 border-app-accent bg-neutral-100 text-app-primary'
                    : 'text-app-secondary hover:bg-neutral-50 hover:text-app-primary',
                )}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-app-border p-4">
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-4 py-2 text-sm text-app-secondary transition-colors hover:bg-red-50 hover:text-red-600"
          >
            <LogOut size={16} />
            退出登录
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-8">{children}</main>
    </div>
  );
}
