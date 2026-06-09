export const ORDER_STATUS_LABELS: Record<string, string> = {
  CREATING_PAYMENT: '正在排队生成 Pix',
  PENDING_PAYMENT: '待支付',
  PAYMENT_COMPLETED: '已完成',
  FAILED: '失败',
  EXPIRED: '已过期',
  CANCELLED: '已取消',
};

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: '管理员',
  WORKER: '工人',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? '未知状态';
}

export function roleLabel(role: string | undefined): string {
  return role ? ROLE_LABELS[role] ?? '未知角色' : '';
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
  if (code && ERROR_CODE_LABELS[code]) return ERROR_CODE_LABELS[code];
  const message = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
  return typeof message === 'string' && message.length <= 80 ? message : fallback;
}

const ERROR_CODE_LABELS: Record<string, string> = {
  INVALID_CODE: '兑换码无效',
  CODE_USED: '兑换码已被使用',
  PAYMENT_FAILED: '支付创建失败，请稍后重试',
  CHATGPT_SESSION_UNRECOGNIZED: '无法识别 ChatGPT Session，请粘贴 accessToken，或包含 accessToken/access_token/at 的 session JSON',
  CHATGPT_CHECKOUT_FAILED: '无法创建 ChatGPT 结算链接，请稍后重试',
  ACCOUNT_NOT_ELIGIBLE: '账号无资格，无法生成 Pix 支付',
  ORDER_STATE_CHANGED: '订单状态已变化，请重新提交或联系管理员',
  ORDER_CREATE_BUSY: '订单创建繁忙，请稍后重试',
  ORDER_QUEUE_UNAVAILABLE: '订单排队失败，请稍后重试',
  MAINTENANCE_MODE: '系统维护中，请稍后再提交',
  NO_HEALTHY_PROXY: '暂无可用代理，请稍后重试',
  OUTSOURCED_CODE_UNAVAILABLE: '暂无可用外包兑换码，请先导入或刷新外包兑换码',
  OUTSOURCED_CODE_REQUIRED: '请先导入外包兑换码，再开启外包自动支付',
  OUTSOURCED_CODE_RESERVATION_CONFLICT: '外包兑换码正在被其他订单占用，请稍后重试',
  OUTSOURCED_PIX_CODE_MISSING: '外包支付缺少 Pix 付款码，请稍后重试',
  OUTSOURCED_SUBMIT_FAILED: '外包支付提交失败，请稍后重试',
  OUTSOURCED_API_INVALID_RESPONSE: '外包 API 响应异常，请检查外包服务',
  OUTSOURCED_API_TIMEOUT: '外包 API 请求超时，请稍后重试',
  OUTSOURCED_API_UNAVAILABLE: '外包 API 暂不可用，请检查外包服务',
  OUTSOURCED_ORDER_CANCEL_BLOCKED: '已有外包票据的订单不能直接取消，请等待外包支付返回终态',
  UPSTREAM_TIMEOUT: '外部服务请求超时，请稍后重试',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  INTERNAL_ERROR: '服务器内部错误，请稍后重试',
};
