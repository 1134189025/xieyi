import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../middleware/error-handler.ts';
import {
  createCheckoutUrl,
  isAccessToken,
  parseChatGptSessionInput,
  resolveAccessToken,
} from './chatgpt-session.service.ts';

const ACCESS_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwcyJ9.signature';
const SESSION_TOKEN = 'eyJhbGciOiJkaXIifQ..iv.ciphertext.tag';

describe('chatgpt-session.service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('从完整 session JSON 中直接提取 accessToken', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const input = JSON.stringify({
      user: { email: 'customer@example.com' },
      accessToken: ACCESS_TOKEN,
      sessionToken: SESSION_TOKEN,
    });

    expect(parseChatGptSessionInput(input)).toEqual({
      kind: 'access_token',
      accessToken: ACCESS_TOKEN,
    });
    await expect(resolveAccessToken(input)).resolves.toBe(ACCESS_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('从只有 sessionToken 的 JSON 中提取 cookie 并换取 accessToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: ACCESS_TOKEN }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = JSON.stringify({ sessionToken: SESSION_TOKEN });

    expect(parseChatGptSessionInput(input)).toEqual({
      kind: 'session_token',
      sessionToken: SESSION_TOKEN,
    });
    await expect(resolveAccessToken(input)).resolves.toBe(ACCESS_TOKEN);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/api/auth/session',
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: `__Secure-next-auth.session-token=${SESSION_TOKEN}`,
        }),
      }),
    );
  });

  it('启用代理时 ChatGPT session 请求使用代理 dispatcher', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: ACCESS_TOKEN }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolveAccessToken(JSON.stringify({ sessionToken: SESSION_TOKEN }), {
        proxyUrl: 'http://user:pass@proxy.example:10000',
      }),
    ).resolves.toBe(ACCESS_TOKEN);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/api/auth/session',
      expect.objectContaining({
        dispatcher: expect.any(Object),
      }),
    );
  });

  it('ChatGPT session 响应缺少 accessToken 时返回稳定错误码', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: 'u1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveAccessToken(JSON.stringify({ sessionToken: SESSION_TOKEN }))).rejects.toMatchObject({
      statusCode: 502,
      code: 'CHATGPT_SESSION_FAILED',
      message: '无法验证 ChatGPT Session，请稍后重试',
    });
  });

  it('不会把 5 段 JWE sessionToken 误判为 accessToken', () => {
    expect(isAccessToken(SESSION_TOKEN)).toBe(false);
    expect(parseChatGptSessionInput(SESSION_TOKEN)).toEqual({
      kind: 'session_token',
      sessionToken: SESSION_TOKEN,
    });
  });

  it('从 cookie header 中提取 __Secure-next-auth.session-token', () => {
    expect(parseChatGptSessionInput(`other=1; __Secure-next-auth.session-token=${SESSION_TOKEN}; Path=/`)).toEqual({
      kind: 'session_token',
      sessionToken: SESSION_TOKEN,
    });
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

  it('ChatGPT checkout 瞬时 502 会按配置重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://pay.openai.com/c/pay/cs_test_123' }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createCheckoutUrl(ACCESS_TOKEN, {
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).resolves.toBe('https://pay.openai.com/c/pay/cs_test_123');

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
      createCheckoutUrl(ACCESS_TOKEN, {
        retry: { attempts: 3, backoffMs: [0, 0] },
      }),
    ).rejects.toMatchObject({
      code: 'CHATGPT_CHECKOUT_FAILED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
