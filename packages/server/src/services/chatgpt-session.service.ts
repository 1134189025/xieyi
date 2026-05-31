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

export function isAccessToken(session: string): boolean {
  return session.startsWith('eyJ');
}

export async function resolveAccessToken(session: string): Promise<string> {
  if (isAccessToken(session)) {
    return session;
  }

  const response = await fetch('https://chatgpt.com/api/auth/session', {
    headers: {
      cookie: `__Secure-next-auth.session-token=${session}`,
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new AppError(502, `ChatGPT session API returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.accessToken !== 'string' || !data.accessToken) {
    throw new AppError(502, 'No accessToken in ChatGPT session response');
  }

  return data.accessToken;
}

export async function createCheckoutUrl(accessToken: string): Promise<string> {
  const response = await fetch('https://chatgpt.com/backend-api/payments/checkout', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify(CHECKOUT_PAYLOAD),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AppError(502, `ChatGPT checkout API failed: ${response.status} ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const url = data.url ?? data.checkout_url ?? data.redirect_url;
  if (typeof url !== 'string' || !url) {
    throw new AppError(502, 'No checkout URL in ChatGPT response');
  }

  return url;
}
