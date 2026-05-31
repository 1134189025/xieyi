import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/auth/LoginPage';
import SubmitOrderPage from './pages/customer/SubmitOrderPage';
import TrackOrderPage from './pages/customer/TrackOrderPage';
import WorkerDashboard from './pages/worker/WorkerDashboard';
import AdminDashboard from './pages/admin/AdminDashboard';
import RedemptionCodesPage from './pages/admin/RedemptionCodesPage';
import WorkerManagementPage from './pages/admin/WorkerManagementPage';
import OrdersPage from './pages/admin/OrdersPage';
import ProxySettingsPage from './pages/admin/ProxySettingsPage';

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      {/* Customer pages - no auth */}
      <Route path="/" element={<SubmitOrderPage />} />
      <Route path="/track/:trackingToken" element={<TrackOrderPage />} />

      {/* Auth */}
      <Route
        path="/login"
        element={
          user ? (
            <Navigate to={user.role === 'ADMIN' ? '/admin' : '/worker'} replace />
          ) : (
            <LoginPage />
          )
        }
      />

      {/* Worker */}
      <Route
        path="/worker"
        element={
          <ProtectedRoute roles={['WORKER', 'ADMIN']}>
            <WorkerDashboard />
          </ProtectedRoute>
        }
      />

      {/* Admin */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={['ADMIN']}>
            <AdminDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/codes"
        element={
          <ProtectedRoute roles={['ADMIN']}>
            <RedemptionCodesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/workers"
        element={
          <ProtectedRoute roles={['ADMIN']}>
            <WorkerManagementPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/orders"
        element={
          <ProtectedRoute roles={['ADMIN']}>
            <OrdersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <ProtectedRoute roles={['ADMIN']}>
            <ProxySettingsPage />
          </ProtectedRoute>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
