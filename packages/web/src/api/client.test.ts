import { describe, expect, it } from 'vitest';
import { shouldAttachAuth } from './client';

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
