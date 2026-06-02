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
