import clsx from 'clsx';
import { orderStatusLabel } from '../utils/labels';

const STATUS_STYLES: Record<string, string> = {
  CREATING_PAYMENT: 'status-muted',
  PENDING_PAYMENT: 'status-pending',
  PAYMENT_COMPLETED: 'status-success',
  FAILED: 'status-error',
  EXPIRED: 'status-muted',
  CANCELLED: 'status-muted',
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx('status-pill', STATUS_STYLES[status] ?? 'status-muted')}>
      {orderStatusLabel(status)}
    </span>
  );
}
