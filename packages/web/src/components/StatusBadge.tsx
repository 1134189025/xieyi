import clsx from 'clsx';

const STATUS_STYLES: Record<string, string> = {
  PENDING_PAYMENT: 'bg-yellow-100 text-yellow-800',
  PAYMENT_COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-gray-100 text-gray-600',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: '待支付',
  PAYMENT_COMPLETED: '已完成',
  FAILED: '失败',
  EXPIRED: '已过期',
  CANCELLED: '已取消',
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
        STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600',
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
