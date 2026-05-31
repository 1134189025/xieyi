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
} from 'lucide-react';
import clsx from 'clsx';

const ADMIN_NAV = [
  { to: '/admin', label: '看板', icon: LayoutDashboard },
  { to: '/admin/codes', label: '兑换码', icon: Ticket },
  { to: '/admin/workers', label: '工人管理', icon: Users },
  { to: '/admin/orders', label: '订单管理', icon: ClipboardList },
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
    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-white shadow-lg flex flex-col">
        <div className="p-6 border-b">
          <h1 className="text-xl font-bold text-indigo-600">Pix Payment</h1>
          <p className="text-sm text-gray-500 mt-1">{user?.displayName ?? user?.username}</p>
          <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium rounded bg-indigo-100 text-indigo-700">
            {user?.role}
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
                    ? 'bg-indigo-50 text-indigo-700 border-r-3 border-indigo-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
                )}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
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
