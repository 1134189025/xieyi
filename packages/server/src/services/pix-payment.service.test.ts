import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateBrazilBillingProfile = vi.fn();
const runPixGoEngine = vi.fn();

class TestPixGoEngineError extends Error {
  code: string;
  statusCode: number;
  stage: string | null;
  detail: string | null;
  httpStatus: number | null;

  constructor(message: string, options: {
    code?: string;
    statusCode?: number;
    stage?: string | null;
    detail?: string | null;
    httpStatus?: number | null;
  } = {}) {
    super(message);
    this.code = options.code ?? 'PAYMENT_FAILED';
    this.statusCode = options.statusCode ?? 502;
    this.stage = options.stage ?? null;
    this.detail = options.detail ?? null;
    this.httpStatus = options.httpStatus ?? null;
  }
}

vi.mock('@pix/core', () => ({
  generateBrazilBillingProfile,
}));

vi.mock('./pix-go-engine.service.ts', () => ({
  runPixGoEngine,
  PixGoEngineError: TestPixGoEngineError,
}));

const { generatePixPayment } = await import('./pix-payment.service.ts');

const credential = {
  kind: 'access_token' as const,
  accessToken: 'access-token-value',
  sessionToken: 'session-token-value',
  deviceId: 'device-123',
  email: 'chatgpt-user@example.com',
};

const profile = {
  name: 'Cliente Teste',
  email: 'generated@example.com',
  cpf: '123.456.789-09',
  address: {
    country: 'BR',
    state: 'SP',
    city: 'Sao Paulo',
    line1: 'Rua Teste 123',
    postalCode: '01000-000',
  },
};

const engineSuccess = {
  checkoutSessionId: 'cs_test_123',
  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123?redirect_pm_type=pix&ui_mode=custom',
  processorEntity: 'openai_llc',
  paymentMethodId: 'pm_123',
  paymentIntentId: 'pi_123',
  amount: 0,
  amountPresent: true,
  currency: 'brl',
  qrData: '000201valid-pix-payload',
  imageUrlPng: 'https://stripe.test/pix.png',
  imageUrlSvg: 'https://stripe.test/pix.svg',
  hostedInstructionsUrl: 'https://stripe.test/instructions',
  expiresAt: 1781111404,
  setupIntentId: 'seti_123',
  setupIntentClientSecret: 'seti_123_secret_456',
  setupIntentStatus: 'requires_action',
};

describe('pix-payment.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateBrazilBillingProfile.mockReturnValue(profile);
    runPixGoEngine.mockResolvedValue(engineSuccess);
  });

  it('调用 Go 引擎生成 0 元 Pix 并映射回现有订单结果形状', async () => {
    const result = await generatePixPayment(credential, {
      proxy: {
        proxyUrl: 'http://stripe:user@br-proxy.example:10001',
        poolName: 'stripe',
      },
    });

    expect(runPixGoEngine).toHaveBeenCalledWith(expect.objectContaining({
      credential,
      proxyUrl: 'http://stripe:user@br-proxy.example:10001',
      billingProfile: expect.objectContaining({
        ...profile,
        email: 'chatgpt-user@example.com',
      }),
      useTrial: true,
      maxApproveBlockedRetries: 3,
    }));
    expect(result.checkoutUrl).toBe(engineSuccess.checkoutUrl);
    expect(result.profile.email).toBe('chatgpt-user@example.com');
    expect(result.stripeResult).toEqual({
      checkoutSessionId: 'cs_test_123',
      checkoutConfigId: undefined,
      paymentMethodId: 'pm_123',
      pix: {
        data: '000201valid-pix-payload',
        hostedInstructionsUrl: 'https://stripe.test/instructions',
        imageUrlPng: 'https://stripe.test/pix.png',
        expiresAt: 1781111404,
        setupIntentId: 'seti_123',
        setupIntentClientSecret: 'seti_123_secret_456',
        setupIntentStatus: 'requires_action',
      },
    });
    expect(result.qrPngBuffer.length).toBeGreaterThan(0);
  });

  it('Go 引擎没有返回 setup_intent 时不伪造自动检测字段', async () => {
    runPixGoEngine.mockResolvedValue({
      ...engineSuccess,
      setupIntentId: undefined,
      setupIntentClientSecret: undefined,
      setupIntentStatus: undefined,
    });

    const result = await generatePixPayment({ ...credential, email: null });

    expect(result.profile.email).toBe('generated@example.com');
    expect(result.stripeResult.pix.setupIntentId).toBeUndefined();
    expect(result.stripeResult.pix.setupIntentClientSecret).toBeUndefined();
  });

  it('非 0 元错误带着代理池和脱敏诊断继续向队列层抛出', async () => {
    const error = new TestPixGoEngineError('account not eligible', {
      code: 'ACCOUNT_NOT_ELIGIBLE',
      statusCode: 400,
      stage: 'stripe_init',
      detail: 'amount_nonzero',
      httpStatus: 200,
    });
    runPixGoEngine.mockRejectedValue(error);

    await expect(
      generatePixPayment(credential, {
        proxy: {
          proxyUrl: 'http://stripe:user@br-proxy.example:10001',
          poolName: 'stripe',
        },
      }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ELIGIBLE',
      statusCode: 400,
      proxyPoolName: 'stripe',
      generationFailureDiagnostic: {
        stage: 'stripe_init',
        detail: 'amount_nonzero',
        httpStatus: 200,
      },
    });
  });

  it('Go 子进程 JSON 损坏按 engine_io 安全失败', async () => {
    const error = new TestPixGoEngineError('invalid engine json', {
      code: 'PAYMENT_FAILED',
      statusCode: 502,
      stage: 'engine_io',
      detail: 'invalid_json',
    });
    runPixGoEngine.mockRejectedValue(error);

    try {
      await generatePixPayment(credential);
      throw new Error('expected generatePixPayment to fail');
    } catch (caught) {
      expect(caught).toMatchObject({
        code: 'PAYMENT_FAILED',
        generationFailureDiagnostic: {
          stage: 'engine_io',
          detail: 'invalid_json',
          httpStatus: null,
        },
      });
      expect(caught).not.toHaveProperty('proxyPoolName');
    }
  });
});
