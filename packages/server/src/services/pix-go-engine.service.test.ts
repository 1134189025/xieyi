import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();

vi.mock('node:child_process', () => ({ spawn }));

const { PixGoEngineError, runPixGoEngine } = await import('./pix-go-engine.service.ts');

class MockChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill() {
    this.killed = true;
    this.emit('close', null);
    return true;
  }
}

function mockEngineProcess(stdout: string, stderr = '', exitCode: number | null = 0): MockChildProcess {
  const child = new MockChildProcess();
  spawn.mockReturnValue(child);
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit('close', exitCode);
  });
  return child;
}

const request = {
  credential: {
    kind: 'access_token' as const,
    accessToken: 'access-token-value',
    sessionToken: 'session-token-value',
    deviceId: 'device-123',
    email: 'customer@example.com',
  },
  proxyUrl: 'http://user:secret@br-proxy.example:10001',
  billingProfile: {
    name: 'Cliente Teste',
    email: 'customer@example.com',
    cpf: '123.456.789-09',
    address: {
      country: 'BR' as const,
      line1: 'Rua Teste 123',
      city: 'Sao Paulo',
      state: 'SP',
      postalCode: '01000-000',
    },
  },
  useTrial: true,
  maxApproveBlockedRetries: 3,
};

describe('pix-go-engine.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('通过 stdin 传入 JSON 并解析 stdout 成功结果', async () => {
    const child = mockEngineProcess(JSON.stringify({
      ok: true,
      checkout_session_id: 'cs_test_123',
      checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      payment_method_id: 'pm_123',
      amount: 0,
      amount_present: true,
      currency: 'brl',
      qr_data: '000201payload',
    }));

    const result = await runPixGoEngine(request);

    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ windowsHide: true }),
    );
    expect(JSON.parse(String(child.stdin.read()))).toMatchObject({
      token: {
        access_token: 'access-token-value',
        session_token: 'session-token-value',
        device_id: 'device-123',
        email: 'customer@example.com',
      },
      proxy_url: 'http://user:secret@br-proxy.example:10001',
      use_trial: true,
      max_approve_blocked_retries: 3,
    });
    expect(result.checkoutSessionId).toBe('cs_test_123');
    expect(result.amount).toBe(0);
    expect(result.amountPresent).toBe(true);
    expect(result.qrData).toBe('000201payload');
  });

  it('接受只有 Stripe PNG 图片的成功响应', async () => {
    mockEngineProcess(JSON.stringify({
      ok: true,
      checkout_session_id: 'cs_test_123',
      checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      payment_method_id: 'pm_123',
      amount: 0,
      amount_present: true,
      currency: 'brl',
      qr_data: '',
      image_url_png: 'https://stripe.test/pix.png',
    }));

    const result = await runPixGoEngine(request);

    expect(result.qrData).toBe('');
    expect(result.imageUrlPng).toBe('https://stripe.test/pix.png');
  });

  it('接受只有 Stripe hosted instructions 链接的成功响应', async () => {
    mockEngineProcess(JSON.stringify({
      ok: true,
      checkout_session_id: 'cs_test_123',
      checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      payment_method_id: 'pm_123',
      amount: 0,
      amount_present: true,
      currency: 'brl',
      hosted_instructions_url: 'https://stripe.test/instructions',
    }));

    const result = await runPixGoEngine(request);

    expect(result.qrData).toBe('');
    expect(result.hostedInstructionsUrl).toBe('https://stripe.test/instructions');
  });

  it('引擎业务错误映射为 PixGoEngineError 且保留脱敏诊断', async () => {
    mockEngineProcess(JSON.stringify({
      ok: false,
      error: {
        code: 'ACCOUNT_NOT_ELIGIBLE',
        status_code: 400,
        stage: 'stripe_init',
        detail: 'amount_nonzero',
        http_status: 200,
      },
    }), '[stripe] proxy=http://user:secret@br-proxy.example:10001');

    await expect(runPixGoEngine(request)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ELIGIBLE',
      statusCode: 400,
      stage: 'stripe_init',
      detail: 'amount_nonzero',
      httpStatus: 200,
    });
  });

  it('stdout 不是 JSON 时返回 engine_io 错误并脱敏 stderr', async () => {
    mockEngineProcess('not-json', 'token=eyJabc.def.ghi proxy=http://user:secret@host:1000', 1);

    const promise = runPixGoEngine(request);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      statusCode: 502,
      stage: 'engine_io',
      detail: expect.stringContaining('[redacted-token]'),
    });
  });

  it('子进程超时时 kill 并返回 UPSTREAM_TIMEOUT', async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawn.mockReturnValue(child);

    const promise = runPixGoEngine({ ...request, timeoutMs: 10 });
    const expectation = expect(promise).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      statusCode: 504,
      stage: 'engine_io',
      detail: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(11);

    await expectation;
    expect(child.killed).toBe(true);
  });

  it('缺少 0 元金额或 QR 时 fail-closed', async () => {
    mockEngineProcess(JSON.stringify({
      ok: true,
      checkout_session_id: 'cs_test_123',
      payment_method_id: 'pm_123',
      amount: 0,
      amount_present: false,
      currency: 'brl',
      qr_data: '',
    }));

    const promise = runPixGoEngine(request);
    await expect(promise).rejects.toBeInstanceOf(PixGoEngineError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      stage: 'engine_io',
      detail: 'invalid_success_payload',
    });
  });

  it('0 元成功响应完全没有 QR artifact 时 fail-closed', async () => {
    mockEngineProcess(JSON.stringify({
      ok: true,
      checkout_session_id: 'cs_test_123',
      payment_method_id: 'pm_123',
      amount: 0,
      amount_present: true,
      currency: 'brl',
      qr_data: '',
    }));

    const promise = runPixGoEngine(request);
    await expect(promise).rejects.toBeInstanceOf(PixGoEngineError);
    await expect(promise).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      stage: 'engine_io',
      detail: 'invalid_success_payload',
    });
  });
});
