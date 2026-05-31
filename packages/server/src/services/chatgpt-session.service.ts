import { AppError } from '../middleware/error-handler.ts';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const CHECKOUT_PAYLOAD = {
  entry_point: 'all_plans_pricing_modal',
  plan_name: 'chatgptplusplan',
  billing_details: { country: 'BR', currency: 'BRL' },
  promo_campaign: {
    promo_campaign_id: 'plus-1-month-free',
    is_coupon_from_query_param: false,
  },
  checkout_ui_mode: 'redirect',
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function isAccessToken(session: string): boolean {
  return session.startsWith('eyJ');
}

export async function resolveAccessToken(session: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  if (isAccessToken(session)) {
    return session;
  }

  const response = await fetchWithTimeout('https://chatgpt.com/api/auth/session', {
    headers: {
      cookie: `__Secure-next-auth.session-token=${session}`,
      'user-agent': USER_AGENT,
    },
  }, timeoutMs);

  if (!response.ok) {
    throw new AppError(502, '无法验证 ChatGPT Session，请稍后重试', 'CHATGPT_SESSION_FAILED');
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.accessToken !== 'string' || !data.accessToken) {
    throw new AppError(502, 'No accessToken in ChatGPT session response');
  }

  return data.accessToken;
}

export async function createCheckoutUrl(accessToken: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const response = await fetchWithTimeout('https://chatgpt.com/backend-api/payments/checkout', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(CHECKOUT_PAYLOAD),
  }, timeoutMs);

  if (!response.ok) {
    throw new AppError(502, '无法创建 ChatGPT 结算链接，请稍后重试', 'CHATGPT_CHECKOUT_FAILED');
  }

  const data = (await response.json()) as Record<string, unknown>;
  const url = data.url ?? data.checkout_url ?? data.redirect_url;
  if (typeof url !== 'string' || !url) {
    throw new AppError(502, 'No checkout URL in ChatGPT response');
  }

  return url;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AppError(504, '外部服务请求超时，请稍后重试', 'UPSTREAM_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
