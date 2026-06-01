import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Save, Trash2 } from 'lucide-react';
import api from '../../api/client';
import Layout from '../../components/Layout';
import { safeErrorMessage } from '../../utils/labels';

interface ProxySetting {
  enabled: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  maskedProxy: string | null;
}

interface AutoPaymentDetectionSetting {
  enabled: boolean;
}

const EMPTY_PROXY_SETTING: ProxySetting = {
  enabled: false,
  host: null,
  port: null,
  username: null,
  maskedProxy: null,
};

export default function ProxySettingsPage() {
  const [proxySetting, setProxySetting] = useState<ProxySetting>(EMPTY_PROXY_SETTING);
  const [autoDetection, setAutoDetection] = useState<AutoPaymentDetectionSetting>({ enabled: true });
  const [proxy, setProxy] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingProxy, setSavingProxy] = useState(false);
  const [savingAutoDetection, setSavingAutoDetection] = useState(false);
  const [error, setError] = useState('');

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const [proxyResponse, autoDetectionResponse] = await Promise.all([
        api.get('/admin/settings/proxy'),
        api.get('/admin/settings/auto-payment-detection'),
      ]);
      setProxySetting(proxyResponse.data);
      setAutoDetection(autoDetectionResponse.data);
      setError('');
    } catch {
      setError('系统设置加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const saveProxy = async (nextProxy: string | null) => {
    setSavingProxy(true);
    try {
      const response = await api.put('/admin/settings/proxy', { proxy: nextProxy });
      setProxySetting(response.data);
      setProxy('');
      toast.success(nextProxy ? '代理设置已保存' : '代理设置已清空');
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '保存代理设置失败'));
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

  const handleProxySubmit = (event: React.FormEvent) => {
    event.preventDefault();
    saveProxy(proxy.trim() || null);
  };

  const handleClearProxy = () => {
    if (!confirm('确认清空代理设置？清空后 ChatGPT 和 Stripe 将直连。')) return;
    saveProxy(null);
  };

  const handleAutoDetectionToggle = () => {
    saveAutoDetection(!autoDetection.enabled);
  };

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-app-primary">系统设置</h2>
        <p className="mt-1 text-sm text-app-secondary">
          管理全局代理和 Pix 支付完成自动检测。代理会同时用于 ChatGPT 长链接生成和 Stripe Pix 协议请求。
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
          <div className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout xl:col-span-2">
            <h3 className="mb-4 text-lg font-semibold">全局代理</h3>
            <form onSubmit={handleProxySubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm text-app-secondary">代理地址</label>
                <input
                  type="text"
                  value={proxy}
                  onChange={(event) => setProxy(event.target.value)}
                  placeholder="host:port:username:password"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-app-border px-3 py-2 font-mono text-sm outline-none focus:border-app-accent"
                />
                <p className="mt-2 text-xs text-app-secondary">
                  示例：proxy.example:10000:proxy-user-zone-custom-region-JP-session-demo-sessTime-5-sessAuto-1:proxy-pass
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={savingProxy}
                  className="flex items-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover disabled:opacity-50"
                >
                  {savingProxy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  保存代理
                </button>
                <button
                  type="button"
                  onClick={handleClearProxy}
                  disabled={savingProxy || !proxySetting.enabled}
                  className="flex items-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-app-primary hover:bg-neutral-200 disabled:opacity-50"
                >
                  <Trash2 size={16} />
                  清空代理
                </button>
              </div>
            </form>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout">
            <h3 className="mb-4 text-lg font-semibold">代理状态</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">状态</span>
                <span className={proxySetting.enabled ? 'font-medium text-green-600' : 'text-app-secondary'}>
                  {proxySetting.enabled ? '已启用' : '未启用'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">Host</span>
                <span className="break-all text-right font-mono">{proxySetting.host ?? '-'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">端口</span>
                <span>{proxySetting.port ?? '-'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">用户名</span>
                <span className="break-all text-right font-mono">{proxySetting.username ?? '-'}</span>
              </div>
              <div>
                <span className="mb-1 block text-app-secondary">脱敏代理</span>
                <span className="block break-all rounded-lg bg-neutral-50 p-3 font-mono text-xs">
                  {proxySetting.maskedProxy ?? '未配置'}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout xl:col-span-3">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-lg font-semibold">自动检测支付完成</h3>
                <p className="mt-1 text-sm text-app-secondary">
                  开启后，后端会定时查询 Stripe SetupIntent 状态；检测到 succeeded 后自动把订单标记为已完成。
                </p>
              </div>
              <button
                type="button"
                onClick={handleAutoDetectionToggle}
                disabled={savingAutoDetection}
                className={`flex min-w-32 items-center justify-center gap-2 rounded-lg px-4 py-2 font-medium text-white disabled:opacity-50 ${
                  autoDetection.enabled ? 'bg-green-600 hover:bg-green-700' : 'bg-neutral-500 hover:bg-neutral-600'
                }`}
              >
                {savingAutoDetection && <Loader2 size={16} className="animate-spin" />}
                {autoDetection.enabled ? '已开启' : '已关闭'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
