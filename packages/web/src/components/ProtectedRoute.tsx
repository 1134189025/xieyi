import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  roles?: Array<'ADMIN' | 'WORKER'>;
}

export default function ProtectedRoute({ children, roles }: ProtectedRouteProps) {
  const { user, authStatus } = useAuth();

  if (authStatus === 'checking') {
    return <div className="checkout-shell text-app-secondary">正在验证登录状态...</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;

  return <>{children}</>;
}
