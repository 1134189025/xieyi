// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { publicApi } from '../../api/client';
import SubmitOrderPage from './SubmitOrderPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../api/client', () => ({
  publicApi: {
    post: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderSubmitOrderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <MemoryRouter>
        <SubmitOrderPage />
      </MemoryRouter>,
    );
  });

  return { container, root };
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(field, 'value')?.set;
    const prototype = Object.getPrototypeOf(field) as HTMLInputElement | HTMLTextAreaElement;
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(field, value);
    } else if (valueSetter) {
      valueSetter.call(field, value);
    } else {
      field.value = value;
    }

    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitForm(form: HTMLFormElement) {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('SubmitOrderPage', () => {
  let mountedRoot: Root | null = null;

  afterEach(() => {
    vi.clearAllMocks();
    if (mountedRoot) {
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
    }
    document.body.innerHTML = '';
  });

  it('未确认协议时不创建订单并显示协议错误', () => {
    const { container, root } = renderSubmitOrderPage();
    mountedRoot = root;

    const redemptionCodeInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    const sessionTextarea = container.querySelector<HTMLTextAreaElement>('textarea');
    const form = container.querySelector<HTMLFormElement>('form');

    expect(redemptionCodeInput).not.toBeNull();
    expect(sessionTextarea).not.toBeNull();
    expect(form).not.toBeNull();

    setFieldValue(redemptionCodeInput!, 'abcd-2026');
    setFieldValue(sessionTextarea!, 'eyJhbGciOi.test.token');
    submitForm(form!);

    expect(publicApi.post).not.toHaveBeenCalled();
    expect(container.textContent).toContain('请先确认已核对信息并同意继续创建支付订单');
    expect(container.querySelector('.shake-active')).not.toBeNull();
  });

  it('确认协议后使用原请求体创建订单', async () => {
    (publicApi.post as Mock).mockResolvedValue({
      data: { trackingToken: 'trk_test_token' },
    });

    const { container, root } = renderSubmitOrderPage();
    mountedRoot = root;

    const redemptionCodeInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    const sessionTextarea = container.querySelector<HTMLTextAreaElement>('textarea');
    const protocolCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const form = container.querySelector<HTMLFormElement>('form');

    expect(redemptionCodeInput).not.toBeNull();
    expect(sessionTextarea).not.toBeNull();
    expect(protocolCheckbox).not.toBeNull();
    expect(form).not.toBeNull();

    setFieldValue(redemptionCodeInput!, ' abcd-2026 ');
    setFieldValue(sessionTextarea!, ' eyJhbGciOi.test.token ');

    act(() => {
      protocolCheckbox!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(publicApi.post).toHaveBeenCalledWith('/orders', {
      redemptionCode: 'ABCD-2026',
      session: 'eyJhbGciOi.test.token',
    });
  });

  it('输入提示只引导用户提交 accessToken 或包含 accessToken 的 JSON', () => {
    const { container, root } = renderSubmitOrderPage();
    mountedRoot = root;

    const sessionTextarea = container.querySelector<HTMLTextAreaElement>('textarea');

    expect(sessionTextarea).not.toBeNull();
    expect(sessionTextarea!.placeholder).toContain('accessToken');
    expect(sessionTextarea!.placeholder).toContain('access_token');
    expect(sessionTextarea!.placeholder).toContain('at');
    expect(sessionTextarea!.placeholder).not.toContain('session cookie');
  });
});
