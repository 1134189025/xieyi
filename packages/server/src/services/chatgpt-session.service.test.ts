import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../middleware/error-handler.ts';
import {
  approveCheckoutSession,
  createCheckoutSession,
  isAccessToken,
  parseChatGptSessionInput,
} from './chatgpt-session.service.ts';

const ACCESS_TOKEN = buildAccessToken({ aud: 'https' });
const EMAIL_ACCESS_TOKEN = buildAccessToken({ email: 'jwt-customer@example.com' });
const SESSION_TOKEN = 'eyJhbGciOiJkaXIifQ..iv.ciphertext.tag';

function buildAccessToken(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.');
}

describe('chatgpt-session.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('从原始三段 JWT 中直接提取 accessToken，不请求 ChatGPT session 页面', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(parseChatGptSessionInput(ACCESS_TOKEN)).toEqual({
      kind: 'access_token',
      accessToken: ACCESS_TOKEN,
      sessionToken: null,
      deviceId: null,
      email: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['accessToken'],
    ['access_token'],
    ['at'],
  ])('从完整 session JSON 顶层字段 %s 直接提取 accessToken', async (fieldName) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const input = JSON.stringify({
      user: { email: 'customer@example.com' },
      [fieldName]: ACCESS_TOKEN,
      sessionToken: SESSION_TOKEN,
      deviceId: 'device-123',
      email: 'top-level@example.com',
    });

    expect(parseChatGptSessionInput(input)).toEqual({
      kind: 'access_token',
      accessToken: ACCESS_TOKEN,
      sessionToken: SESSION_TOKEN,
      deviceId: 'device-123',
      email: 'top-level@example.com',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('从 accessToken JWT claims 提取 email 作为账单邮箱兜底', () => {
    expect(parseChatGptSessionInput(EMAIL_ACCESS_TOKEN)).toEqual({
      kind: 'access_token',
      accessToken: EMAIL_ACCESS_TOKEN,
      sessionToken: null,
      deviceId: null,
      email: 'jwt-customer@example.com',
    });
  });

  it('支持 accessToken----sessionToken 组合输入并保留 sessionToken', () => {
    expect(parseChatGptSessionInput(`${EMAIL_ACCESS_TOKEN}----${SESSION_TOKEN}`)).toEqual({
      kind: 'access_token',
      accessToken: EMAIL_ACCESS_TOKEN,
      sessionToken: SESSION_TOKEN,
      deviceId: null,
      email: 'jwt-customer@example.com',
    });
  });

  it('只有 sessionToken 的 JSON 返回稳定错误码且不请求 ChatGPT session 页面', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => parseChatGptSessionInput(JSON.stringify({ sessionToken: SESSION_TOKEN }))).toThrow(AppError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不会把 5 段 JWE sessionToken 误判为 accessToken，也不再接受为兼容输入', () => {
    expect(isAccessToken(SESSION_TOKEN)).toBe(false);
    expect(() => parseChatGptSessionInput(SESSION_TOKEN)).toThrow(AppError);
  });

  it('不再接受 cookie header 或 bare session token', () => {
    expect(() => parseChatGptSessionInput(`other=1; __Secure-next-auth.session-token=${SESSION_TOKEN}; Path=/`)).toThrow(AppError);
    expect(() => parseChatGptSessionInput('bare-session-token-value-12345')).toThrow(AppError);
  });

  it('JSON 中 accessToken 不是三段 JWT 时返回稳定错误码', () => {
    expect(() => parseChatGptSessionInput(JSON.stringify({ accessToken: 'not-a-jwt' }))).toThrow(AppError);
    try {
      parseChatGptSessionInput(JSON.stringify({ accessToken: 'not-a-jwt' }));
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 400,
        code: 'CHATGPT_SESSION_UNRECOGNIZED',
      });
    }
  });

  it('无法识别的 JSON 返回稳定错误码', () => {
    expect(() => parseChatGptSessionInput(JSON.stringify({ user: { id: 'u1' } }))).toThrow(AppError);
    try {
      parseChatGptSessionInput(JSON.stringify({ user: { id: 'u1' } }));
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 400,
        code: 'CHATGPT_SESSION_UNRECOGNIZED',
      });
    }
  });

  it('创建巴西 BRL 0 元 checkout 并返回 session id、URL 和 processor', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        checkout_session_id: 'cs_test_123',
        url: 'https://pay.openai.com/c/pay/cs_test_123#fragment',
        processor_entity: 'openai_llc',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCheckoutSession(ACCESS_TOKEN)).resolves.toEqual({
      checkoutSessionId: 'cs_test_123',
      checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123#fragment',
      processorEntity: 'openai_llc',
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      entry_point: 'all_plans_pricing_modal',
      plan_name: 'chatgptplusplan',
      billing_details: { country: 'BR', currency: 'BRL' },
      promo_campaign: {
        promo_campaign_id: 'plus-1-month-free',
        is_coupon_from_query_param: false,
      },
      checkout_ui_mode: 'hosted',
    });
  });

  it('checkout 响应缺少 URL 时用 checkout session id 构造可存储 URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ checkout_session_id: 'cs_test_123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCheckoutSession(ACCESS_TOKEN)).resolves.toMatchObject({
      checkoutSessionId: 'cs_test_123',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123?redirect_pm_type=pix&ui_mode=custom',
      processorEntity: 'openai_llc',
    });
  });

  it('ChatGPT checkout 响应缺少 session id 时返回稳定错误码', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://pay.openai.com/c/pay/cs_test_123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCheckoutSession(ACCESS_TOKEN)).rejects.toMatchObject({
      statusCode: 502,
      code: 'CHATGPT_CHECKOUT_FAILED',
      message: '无法创建 ChatGPT 结算链接，请稍后重试',
    });
  });

  it('ChatGPT checkout 瞬时 502 会按配置重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ checkout_session_id: 'cs_test_123', url: 'https://pay.openai.com/c/pay/cs_test_123' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutSession(ACCESS_TOKEN, {
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).resolves.toMatchObject({ checkoutSessionId: 'cs_test_123' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ChatGPT checkout 401 业务错误不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutSession(ACCESS_TOKEN, {
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).rejects.toMatchObject({
      code: 'CHATGPT_CHECKOUT_FAILED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('approve checkout 使用 checkout session id 和 processor entity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'approved' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      approveCheckoutSession(
        ACCESS_TOKEN,
        { checkoutSessionId: 'cs_test_123', checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123', processorEntity: 'openai_llc' },
      ),
    ).resolves.toEqual({ result: 'approved', statusCode: 200 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/payments/checkout/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ checkout_session_id: 'cs_test_123', processor_entity: 'openai_llc' }),
      }),
    );
  });

  it('approve checkout 缺少明确 approved 结果时不默认放行', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      approveCheckoutSession(
        ACCESS_TOKEN,
        { checkoutSessionId: 'cs_test_123', checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123', processorEntity: 'openai_llc' },
      ),
    ).resolves.toEqual({ result: 'error', statusCode: 200 });
  });

  it('approve checkout 返回空 body 时不默认放行', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      approveCheckoutSession(
        ACCESS_TOKEN,
        { checkoutSessionId: 'cs_test_123', checkoutUrl: 'https://pay.openai.com/c/pay/cs_test_123', processorEntity: 'openai_llc' },
      ),
    ).resolves.toEqual({ result: 'error', statusCode: 200 });
  });
});
