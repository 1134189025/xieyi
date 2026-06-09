import { lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import ProtectedRoute from './components/ProtectedRoute';

const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const SubmitOrderPage = lazy(() => import('./pages/customer/SubmitOrderPage'));
const TrackOrderPage = lazy(() => import('./pages/customer/TrackOrderPage'));
const WorkerDashboard = lazy(() => import('./pages/worker/WorkerDashboard'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const RedemptionCodesPage = lazy(() => import('./pages/admin/RedemptionCodesPage'));
const OutsourcedActivationCodesPage = lazy(() => import('./pages/admin/OutsourcedActivationCodesPage'));
const WorkerManagementPage = lazy(() => import('./pages/admin/WorkerManagementPage'));
const OrdersPage = lazy(() => import('./pages/admin/OrdersPage'));
const ProxySettingsPage = lazy(() => import('./pages/admin/ProxySettingsPage'));

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      {/* Customer pages - no auth */}
      <Route path="/" element={withPageLoading(<SubmitOrderPage />)} />
      <Route path="/track/:trackingToken" element={withPageLoading(<TrackOrderPage />)} />

      {/* Auth */}
      <Route
        path="/login"
        element={
          user ? (
            <Navigate to={user.role === 'ADMIN' ? '/admin' : '/worker'} replace />
          ) : (
            withPageLoading(<LoginPage />)
          )
        }
      />

      {/* Worker */}
      <Route
        path="/worker"
        element={
          withPageLoading(
            <ProtectedRoute roles={['WORKER', 'ADMIN']}>
              <WorkerDashboard />
            </ProtectedRoute>,
          )
        }
      />

      {/* Admin */}
      <Route
        path="/admin"
        element={
          withPageLoading(
            <ProtectedRoute roles={['ADMIN']}>
              <AdminDashboard />
            </ProtectedRoute>,
          )
        }
      />
      <Route
        path="/admin/codes"
        element={
          withPageLoading(
            <ProtectedRoute roles={['ADMIN']}>
              <RedemptionCodesPage />
            </ProtectedRoute>,
          )
        }
      />
      <Route
        path="/admin/outsourced-activation-codes"
        element={
          withPageLoading(
            <ProtectedRoute roles={['ADMIN']}>
              <OutsourcedActivationCodesPage />
            </ProtectedRoute>,
          )
        }
      />
      <Route
        path="/admin/workers"
        element={
          withPageLoading(
            <ProtectedRoute roles={['ADMIN']}>
              <WorkerManagementPage />
            </ProtectedRoute>,
          )
        }
      />
      <Route
        path="/admin/orders"
        element={
          withPageLoading(
            <ProtectedRoute roles={['ADMIN']}>
              <OrdersPage />
            </ProtectedRoute>,
          )
        }
      />
      <Route
        path="/admin/settings"
        element={
          withPageLoading(
            <ProtectedRoute roles={['ADMIN']}>
              <ProxySettingsPage />
            </ProtectedRoute>,
          )
        }
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function withPageLoading(page: ReactNode) {
  return <Suspense fallback={<PageLoading />}>{page}</Suspense>;
}

function PageLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app-body">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-app-border border-t-app-accent"
        aria-label="页面加载中"
      />
    </div>
  );
}
