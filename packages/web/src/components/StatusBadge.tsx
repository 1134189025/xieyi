import clsx from 'clsx';
import { orderStatusLabel } from '../utils/labels';

const STATUS_STYLES: Record<string, string> = {
  CREATING_PAYMENT: 'bg-blue-100 text-blue-800',
  PENDING_PAYMENT: 'bg-yellow-100 text-yellow-800',
  PAYMENT_COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-gray-100 text-gray-600',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
        STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600',
      )}
    >
      {orderStatusLabel(status)}
    </span>
  );
}
