import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  LayoutDashboard,
  Ticket,
  Users,
  ClipboardList,
  LogOut,
  Settings,
} from 'lucide-react';
import clsx from 'clsx';
import { roleLabel } from '../utils/labels';

const ADMIN_NAV = [
  { to: '/admin', label: '看板', icon: LayoutDashboard },
  { to: '/admin/codes', label: '本地兑换码', icon: Ticket },
  { to: '/admin/outsourced-activation-codes', label: '外包兑换码', icon: Ticket },
  { to: '/admin/workers', label: '工人管理', icon: Users },
  { to: '/admin/orders', label: '订单管理', icon: ClipboardList },
  { to: '/admin/settings', label: '系统设置', icon: Settings },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-app-body text-app-primary lg:flex lg:h-screen">
      <aside className="hidden w-64 flex-col border-r border-app-border bg-app-surface shadow-checkout lg:flex">
        <div className="border-b border-app-border p-6">
          <h1 className="text-xl font-extrabold text-app-primary">Pix 协议支付</h1>
          <p className="mt-1 text-sm text-app-secondary">{user?.displayName ?? user?.username}</p>
          <span className="mt-2 inline-block rounded-full border border-app-border bg-white px-2 py-0.5 text-xs font-medium text-app-secondary">
            {roleLabel(user?.role)}
          </span>
        </div>

        <nav className="flex-1 py-4">
          {ADMIN_NAV.map((item) => {
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

      <div className="min-w-0 flex-1 lg:overflow-auto">
        <header className="border-b border-app-border bg-app-surface/95 shadow-sm lg:hidden">
          <div className="flex items-start justify-between gap-3 px-4 py-4">
            <div className="min-w-0">
              <h1 className="text-lg font-extrabold text-app-primary">Pix 协议支付</h1>
              <p className="mt-1 truncate text-sm text-app-secondary">{user?.displayName ?? user?.username}</p>
              <span className="mt-2 inline-block rounded-full border border-app-border bg-white px-2 py-0.5 text-xs font-medium text-app-secondary">
                {roleLabel(user?.role)}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="flex shrink-0 items-center gap-2 rounded-lg border border-app-border px-3 py-2 text-sm text-app-secondary transition-colors hover:bg-red-50 hover:text-red-600"
            >
              <LogOut size={16} />
              退出
            </button>
          </div>

          <nav className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-3">
            {ADMIN_NAV.map((item) => {
              const Icon = item.icon;
              const active = location.pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={clsx(
                    'flex min-w-0 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-center text-sm font-medium transition-colors',
                    active
                      ? 'border-app-accent bg-app-accent text-white'
                      : 'border-app-border bg-white text-app-secondary hover:text-app-primary',
                  )}
                >
                  <Icon size={16} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>

        <main className="min-w-0 overflow-x-hidden p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
