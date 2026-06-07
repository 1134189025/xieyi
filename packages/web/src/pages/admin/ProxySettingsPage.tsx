import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Save } from 'lucide-react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import { AUTO_REFRESH_INTERVAL_MS, useAutoRefresh } from '../../hooks/useAutoRefresh';
import { safeErrorMessage } from '../../utils/labels';

interface ProxySettings {
  chatGpt: ProxyPoolSetting;
  stripe: ProxyPoolSetting;
}

interface ProxyPoolSetting {
  enabled: boolean;
  proxies: ProxyView[];
}

interface ProxyView {
  id: string;
  host: string;
  port: number;
  username: string;
  maskedProxy: string;
  consecutiveFailures?: number;
  coolingDownUntil?: string | null;
  healthy?: boolean;
}

interface ToggleSetting {
  enabled: boolean;
}

type PaymentHandler = 'LOCAL_WORKER' | 'OUTSOURCED_BUYER_API';

interface PaymentProcessingSetting {
  handler: PaymentHandler;
  outsourcedBuyerApiBaseUrl: string;
  outsourcedActivationCodeCount: number;
  outsourcedActivationCodePreview: string[];
}

interface FetchSettingsOptions {
  silent?: boolean;
}

const EMPTY_PROXY_SETTINGS: ProxySettings = {
  chatGpt: { enabled: false, proxies: [] },
  stripe: { enabled: false, proxies: [] },
};

const EMPTY_PAYMENT_PROCESSING_SETTING: PaymentProcessingSetting = {
  handler: 'LOCAL_WORKER',
  outsourcedBuyerApiBaseUrl: 'https://scan.amazo.indevs.in',
  outsourcedActivationCodeCount: 0,
  outsourcedActivationCodePreview: [],
};

export default function ProxySettingsPage() {
  const [proxySettings, setProxySettings] = useState<ProxySettings>(EMPTY_PROXY_SETTINGS);
  const [autoDetection, setAutoDetection] = useState<ToggleSetting>({ enabled: true });
  const [maintenanceMode, setMaintenanceMode] = useState<ToggleSetting>({ enabled: false });
  const [paymentProcessing, setPaymentProcessing] = useState<PaymentProcessingSetting>(EMPTY_PAYMENT_PROCESSING_SETTING);
  const [paymentHandler, setPaymentHandler] = useState<PaymentHandler>('LOCAL_WORKER');
  const [outsourcedBuyerApiBaseUrl, setOutsourcedBuyerApiBaseUrl] = useState(
    EMPTY_PAYMENT_PROCESSING_SETTING.outsourcedBuyerApiBaseUrl,
  );
  const [outsourcedActivationCodePool, setOutsourcedActivationCodePool] = useState('');
  const [clearOutsourcedActivationCodes, setClearOutsourcedActivationCodes] = useState(false);
  const [chatGptProxyPool, setChatGptProxyPool] = useState('');
  const [stripeProxyPool, setStripeProxyPool] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingProxy, setSavingProxy] = useState(false);
  const [savingPaymentProcessing, setSavingPaymentProcessing] = useState(false);
  const [savingAutoDetection, setSavingAutoDetection] = useState(false);
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [error, setError] = useState('');

  const fetchSettings = async (options: FetchSettingsOptions = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const [proxyResponse, autoDetectionResponse, maintenanceResponse, paymentProcessingResponse] = await Promise.all([
        api.get('/admin/settings/proxy'),
        api.get('/admin/settings/auto-payment-detection'),
        api.get('/admin/settings/maintenance-mode'),
        api.get('/admin/settings/payment-processing'),
      ]);
      const nextPaymentProcessing = paymentProcessingResponse.data as PaymentProcessingSetting;
      setProxySettings(proxyResponse.data);
      setAutoDetection(autoDetectionResponse.data);
      setMaintenanceMode(maintenanceResponse.data);
      setPaymentProcessing(nextPaymentProcessing);
      if (!options.silent) {
        setPaymentHandler(nextPaymentProcessing.handler);
        setOutsourcedBuyerApiBaseUrl(nextPaymentProcessing.outsourcedBuyerApiBaseUrl);
        setOutsourcedActivationCodePool('');
        setClearOutsourcedActivationCodes(false);
      }
      setError('');
    } catch {
      if (!options.silent) {
        setError('系统设置加载失败');
      }
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void fetchSettings();
  }, []);

  useAutoRefresh(() => fetchSettings({ silent: true }), AUTO_REFRESH_INTERVAL_MS);

  const saveProxyPools = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingProxy(true);
    try {
      const response = await api.put('/admin/settings/proxy', {
        chatGptProxyPool: chatGptProxyPool.trim(),
        stripeProxyPool: stripeProxyPool.trim(),
      });
      setProxySettings(response.data);
      setChatGptProxyPool('');
      setStripeProxyPool('');
      toast.success('代理池设置已保存');
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '保存代理池失败'));
    } finally {
      setSavingProxy(false);
    }
  };

  const saveAutoDetection = async (enabled: boolean) => {
    setSavingAutoDetection(true);
    try {
      const response = await api.put('/admin/settings/auto-payment-detection', { enabled });
      setAutoDetection(response.data);
      toast.success(enabled ? '自动检测支付完成已开启' : '自动检测支付完成已关闭');
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '保存自动检测设置失败'));
    } finally {
      setSavingAutoDetection(false);
    }
  };

  const savePaymentProcessing = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingPaymentProcessing(true);
    try {
      const payload: {
        handler: PaymentHandler;
        outsourcedBuyerApiBaseUrl: string;
        outsourcedActivationCodePool?: string | null;
      } = {
        handler: paymentHandler,
        outsourcedBuyerApiBaseUrl: outsourcedBuyerApiBaseUrl.trim(),
      };
      if (outsourcedActivationCodePool.trim()) {
        payload.outsourcedActivationCodePool = outsourcedActivationCodePool.trim();
      } else if (clearOutsourcedActivationCodes) {
        payload.outsourcedActivationCodePool = null;
      }

      const response = await api.put('/admin/settings/payment-processing', payload);
      setPaymentProcessing(response.data);
      setPaymentHandler(response.data.handler);
      setOutsourcedBuyerApiBaseUrl(response.data.outsourcedBuyerApiBaseUrl);
      setOutsourcedActivationCodePool('');
      setClearOutsourcedActivationCodes(false);
      toast.success('付款处理方式已保存');
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '保存付款处理方式失败'));
    } finally {
      setSavingPaymentProcessing(false);
    }
  };

  const saveMaintenanceMode = async (enabled: boolean) => {
    setSavingMaintenance(true);
    try {
      const response = await api.put('/admin/settings/maintenance-mode', { enabled });
      setMaintenanceMode(response.data);
      toast.success(enabled ? '维护模式已开启' : '维护模式已关闭');
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '保存维护模式失败'));
    } finally {
      setSavingMaintenance(false);
    }
  };

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-app-primary">系统设置</h2>
        <p className="mt-1 text-sm text-app-secondary">
          分别维护 ChatGPT 和 Stripe 代理池；高峰期订单会排队，只有维护模式会拒绝新订单。
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-app-border bg-app-surface p-10 text-center text-app-secondary shadow-checkout">
          {error}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <form onSubmit={saveProxyPools} className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6 xl:col-span-2">
            <h3 className="mb-4 text-lg font-semibold">代理池</h3>
            <ProxyPoolTextarea
              title="ChatGPT 代理池"
              value={chatGptProxyPool}
              onChange={setChatGptProxyPool}
            />
            <ProxyPoolTextarea
              title="Stripe 代理池"
              value={stripeProxyPool}
              onChange={setStripeProxyPool}
            />
            <button
              type="submit"
              disabled={savingProxy}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover disabled:opacity-50 sm:w-auto"
            >
              {savingProxy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              保存代理池
            </button>
          </form>

          <div className="space-y-6">
            <ProxyPoolStatus title="ChatGPT 代理池" setting={proxySettings.chatGpt} />
            <ProxyPoolStatus title="Stripe 代理池" setting={proxySettings.stripe} />
          </div>

          <PaymentProcessingCard
            setting={paymentProcessing}
            handler={paymentHandler}
            apiBaseUrl={outsourcedBuyerApiBaseUrl}
            activationCodePool={outsourcedActivationCodePool}
            clearActivationCodes={clearOutsourcedActivationCodes}
            saving={savingPaymentProcessing}
            onHandlerChange={setPaymentHandler}
            onApiBaseUrlChange={setOutsourcedBuyerApiBaseUrl}
            onActivationCodePoolChange={setOutsourcedActivationCodePool}
            onClearActivationCodesChange={setClearOutsourcedActivationCodes}
            onSubmit={savePaymentProcessing}
          />

          <SettingToggleCard
            title="自动检测支付完成"
            body="开启后后端会定时查询 Stripe SetupIntent，检测到 succeeded 后自动把订单标记为已完成。"
            enabled={autoDetection.enabled}
            enabledText="自动检测已开启"
            disabledText="自动检测已关闭"
            saving={savingAutoDetection}
            onToggle={() => void saveAutoDetection(!autoDetection.enabled)}
          />

          <SettingToggleCard
            title="维护模式"
            body="开启后新提交订单会直接返回维护提示，不会占用兑换码；关闭后合法订单继续进入生成队列。"
            enabled={maintenanceMode.enabled}
            enabledText="维护已开启"
            disabledText="维护已关闭"
            saving={savingMaintenance}
            onToggle={() => void saveMaintenanceMode(!maintenanceMode.enabled)}
          />
        </div>
      )}
    </Layout>
  );
}

function PaymentProcessingCard({
  setting,
  handler,
  apiBaseUrl,
  activationCodePool,
  clearActivationCodes,
  saving,
  onHandlerChange,
  onApiBaseUrlChange,
  onActivationCodePoolChange,
  onClearActivationCodesChange,
  onSubmit,
}: {
  setting: PaymentProcessingSetting;
  handler: PaymentHandler;
  apiBaseUrl: string;
  activationCodePool: string;
  clearActivationCodes: boolean;
  saving: boolean;
  onHandlerChange: (handler: PaymentHandler) => void;
  onApiBaseUrlChange: (value: string) => void;
  onActivationCodePoolChange: (value: string) => void;
  onClearActivationCodesChange: (value: boolean) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6 xl:col-span-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-lg font-semibold">付款处理方式</h3>
          <p className="mt-1 text-sm text-app-secondary">
            切换只影响新订单；已创建订单会按创建时固化的处理方式继续执行。
          </p>
        </div>
        <div className="text-sm text-app-secondary">
          当前码池：{setting.outsourcedActivationCodeCount} 个
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <PaymentHandlerButton
          active={handler === 'LOCAL_WORKER'}
          title="本地工人扫码"
          body="Pix 生成后进入本地工人队列，由工人扫码完成付款。"
          onClick={() => onHandlerChange('LOCAL_WORKER')}
        />
        <PaymentHandlerButton
          active={handler === 'OUTSOURCED_BUYER_API'}
          title="外包自动支付"
          body="Pix 生成后提交到买家端外包 API，失败不会回退给本地工人。"
          onClick={() => onHandlerChange('OUTSOURCED_BUYER_API')}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-app-primary">外包 API Base URL</label>
          <input
            value={apiBaseUrl}
            onChange={(event) => onApiBaseUrlChange(event.target.value)}
            placeholder="https://scan.amazo.indevs.in"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-app-border px-3 py-2 font-mono text-sm outline-none focus:border-app-accent"
          />
          <p className="mt-2 text-xs text-app-secondary">保存时只接受 http/https 地址；填写 /buyer 会自动规整到站点根地址。</p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-app-primary">外包激活码池</label>
          <textarea
            value={activationCodePool}
            onChange={(event) => {
              onActivationCodePoolChange(event.target.value);
              if (event.target.value.trim()) onClearActivationCodesChange(false);
            }}
            placeholder="每行一个外包激活码；留空保存会保留现有码池"
            rows={4}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-app-border px-3 py-2 font-mono text-sm outline-none focus:border-app-accent"
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-app-secondary">
            <input
              type="checkbox"
              checked={clearActivationCodes}
              disabled={Boolean(activationCodePool.trim())}
              onChange={(event) => onClearActivationCodesChange(event.target.checked)}
              className="h-4 w-4 rounded border-app-border"
            />
            清空已保存外包码池
          </label>
        </div>
      </div>

      {setting.outsourcedActivationCodePreview.length > 0 && (
        <div className="mt-4 rounded-lg bg-neutral-50 p-3 text-xs text-app-secondary">
          脱敏预览：{setting.outsourcedActivationCodePreview.join('、')}
        </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover disabled:opacity-50 sm:w-auto"
      >
        {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
        保存付款处理方式
      </button>
    </form>
  );
}

function PaymentHandlerButton({
  active,
  title,
  body,
  onClick,
}: {
  active: boolean;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition ${
        active
          ? 'border-app-accent bg-app-accent/10 text-app-primary'
          : 'border-app-border bg-white text-app-secondary hover:border-app-accent'
      }`}
    >
      <div className="font-semibold">{title}</div>
      <div className="mt-1 text-sm">{body}</div>
    </button>
  );
}

function ProxyPoolTextarea({
  title,
  value,
  onChange,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mb-4">
      <label className="mb-1 block text-sm font-medium text-app-primary">{title}</label>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="host:port:username:password，每行一个"
        rows={4}
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-lg border border-app-border px-3 py-2 font-mono text-sm outline-none focus:border-app-accent"
      />
    </div>
  );
}

function ProxyPoolStatus({ title, setting }: { title: string; setting: ProxyPoolSetting }) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6">
      <h3 className="mb-4 text-lg font-semibold">{title}</h3>
      {setting.proxies.length === 0 ? (
        <p className="text-sm text-app-secondary">未配置</p>
      ) : (
        <div className="space-y-2">
          {setting.proxies.map((proxy) => (
            <div key={proxy.id} className="rounded-lg bg-neutral-50 p-3 text-xs">
              <div className="break-all font-mono">{proxy.maskedProxy}</div>
              <div className={proxy.healthy === false ? 'mt-1 text-amber-700' : 'mt-1 text-emerald-700'}>
                {proxy.healthy === false ? '冷却中' : '健康'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingToggleCard({
  title,
  body,
  enabled,
  enabledText,
  disabledText,
  saving,
  onToggle,
}: {
  title: string;
  body: string;
  enabled: boolean;
  enabledText: string;
  disabledText: string;
  saving: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-checkout sm:p-6 xl:col-span-3">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-app-secondary">{body}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={saving}
          className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 font-medium text-white disabled:opacity-50 md:w-auto md:min-w-36 ${
            enabled ? 'bg-green-600 hover:bg-green-700' : 'bg-neutral-500 hover:bg-neutral-600'
          }`}
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          {enabled ? enabledText : disabledText}
        </button>
      </div>
    </div>
  );
}
