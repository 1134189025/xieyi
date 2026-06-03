import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../middleware/error-handler.ts';
import {
  createCheckoutUrl,
  isAccessToken,
  parseChatGptSessionInput,
} from './chatgpt-session.service.ts';

const ACCESS_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwcyJ9.signature';
const SESSION_TOKEN = 'eyJhbGciOiJkaXIifQ..iv.ciphertext.tag';

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
    });

    expect(parseChatGptSessionInput(input)).toEqual({
      kind: 'access_token',
      accessToken: ACCESS_TOKEN,
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('ChatGPT checkout 响应缺少 URL 时返回稳定错误码', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'checkout_without_url' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCheckoutUrl(ACCESS_TOKEN)).rejects.toMatchObject({
      statusCode: 502,
      code: 'CHATGPT_CHECKOUT_FAILED',
      message: '无法创建 ChatGPT 结算链接，请稍后重试',
    });
  });

  it('通过 oaipay 生成 hosted 长链接并透传代理', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        stripe_hosted_url: 'https://pay.openai.com/c/pay/cs_test_oaipay_123',
        long_url: 'https://pay.openai.com/c/pay/cs_test_fallback_456',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutUrl(ACCESS_TOKEN, {
        proxyUrl: 'http://user:pass@proxy.example:10000',
        retry: { attempts: 1 },
      }),
    ).resolves.toBe('https://pay.openai.com/c/pay/cs_test_oaipay_123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://oaipay.im-run.com/api/long-link',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          accessToken: ACCESS_TOKEN,
          link_type: 'hosted',
          proxy: 'http://user:pass@proxy.example:10000',
          billing_country: 'BR',
          checkout_ui_mode: 'hosted',
          payment_locale: 'pt-BR',
          stripe_publishable_key: '',
          device_id: '',
          user_agent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        }),
      }),
    );
  });

  it('oaipay 只返回 provider 链接时不进入后续 Pix 协议', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        provider_redirect_url: 'https://provider.example/pay/redirect',
        long_url: 'https://provider.example/pay/redirect',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createCheckoutUrl(ACCESS_TOKEN)).rejects.toMatchObject({
      statusCode: 502,
      code: 'CHATGPT_CHECKOUT_FAILED',
    });
  });

  it('oaipay 业务失败不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'checkout create failed: invalid token',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutUrl(ACCESS_TOKEN, {
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).rejects.toMatchObject({
      code: 'CHATGPT_CHECKOUT_FAILED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('oaipay 瞬时 502 会按配置重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          stripe_hosted_url: 'https://pay.openai.com/c/pay/cs_test_123',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutUrl(ACCESS_TOKEN, {
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).resolves.toBe('https://pay.openai.com/c/pay/cs_test_123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('oaipay 超时会转换为可重试错误', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutUrl(ACCESS_TOKEN, {
        timeoutMs: 1,
        retry: { attempts: 1, backoffMs: [0] },
      }),
    ).rejects.toMatchObject({
      statusCode: 504,
      code: 'UPSTREAM_TIMEOUT',
    });
  });
});
