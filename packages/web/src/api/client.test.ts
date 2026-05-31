import { describe, expect, it } from 'vitest';
import { shouldAttachAuth } from './client';
import { safeErrorMessage } from '../utils/labels';

describe('shouldAttachAuth', () => {
  it('只给受保护的后台接口附加鉴权 token', () => {
    expect(shouldAttachAuth('/admin/orders')).toBe(true);
    expect(shouldAttachAuth('/worker/orders')).toBe(true);
    expect(shouldAttachAuth('/auth/me')).toBe(true);
    expect(shouldAttachAuth('/auth/login')).toBe(false);
    expect(shouldAttachAuth('/orders')).toBe(false);
    expect(shouldAttachAuth('/orders/track/abc')).toBe(false);
  });
});

describe('safeErrorMessage', () => {
  it('把无法识别 ChatGPT Session 的错误码映射成中文提示', () => {
    const error = {
      response: {
        data: {
          code: 'CHATGPT_SESSION_UNRECOGNIZED',
          error: 'raw upstream detail',
        },
      },
    };

    expect(safeErrorMessage(error, '创建订单失败')).toBe(
      '无法识别 ChatGPT Session，请粘贴完整 session JSON、accessToken 或 session cookie',
    );
  });

  it('把订单状态变化错误码映射成中文提示', () => {
    const error = {
      response: {
        data: {
          code: 'ORDER_STATE_CHANGED',
          error: 'Order is CANCELLED, cannot update',
        },
      },
    };

    expect(safeErrorMessage(error, '创建订单失败')).toBe('订单状态已变化，请重新提交或联系管理员');
  });

  it('把账号无资格错误码映射成中文提示', () => {
    const error = {
      response: {
        data: {
          code: 'ACCOUNT_NOT_ELIGIBLE',
          error: 'internal stripe detail',
        },
      },
    };

    expect(safeErrorMessage(error, '创建订单失败')).toBe('账号无资格，无法生成 Pix 支付');
  });
});
