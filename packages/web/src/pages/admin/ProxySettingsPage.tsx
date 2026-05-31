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

const EMPTY_SETTING: ProxySetting = {
  enabled: false,
  host: null,
  port: null,
  username: null,
  maskedProxy: null,
};

export default function ProxySettingsPage() {
  const [setting, setSetting] = useState<ProxySetting>(EMPTY_SETTING);
  const [proxy, setProxy] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fetchSetting = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/settings/proxy');
      setSetting(res.data);
      setError('');
    } catch {
      setError('代理设置加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSetting();
  }, []);

  const saveProxy = async (nextProxy: string | null) => {
    setSaving(true);
    try {
      const res = await api.put('/admin/settings/proxy', { proxy: nextProxy });
      setSetting(res.data);
      setProxy('');
      toast.success(nextProxy ? '代理设置已保存' : '代理设置已清空');
    } catch (err: unknown) {
      toast.error(safeErrorMessage(err, '保存代理设置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    saveProxy(proxy.trim() || null);
  };

  const handleClear = () => {
    if (!confirm('确认清空代理设置？清空后 ChatGPT 和 Stripe 将直连。')) return;
    saveProxy(null);
  };

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-app-primary">代理设置</h2>
        <p className="mt-1 text-sm text-app-secondary">
          这里配置的 HTTP/HTTPS 代理会同时用于 ChatGPT 结算长链接和 Stripe Pix 协议请求。
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-app-border bg-app-surface p-10 text-center text-app-secondary shadow-checkout">{error}</div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout xl:col-span-2">
            <h3 className="text-lg font-semibold mb-4">全局代理</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
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
                  disabled={saving}
                  className="flex items-center gap-2 rounded-lg bg-app-accent px-4 py-2 text-white hover:bg-app-accentHover disabled:opacity-50"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  保存代理
                </button>
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={saving || !setting.enabled}
                  className="flex items-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-app-primary hover:bg-neutral-200 disabled:opacity-50"
                >
                  <Trash2 size={16} />
                  清空代理
                </button>
              </div>
            </form>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface p-6 shadow-checkout">
            <h3 className="text-lg font-semibold mb-4">当前状态</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">状态</span>
                <span className={setting.enabled ? 'text-green-600 font-medium' : 'text-app-secondary'}>
                  {setting.enabled ? '已启用' : '未启用'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">Host</span>
                <span className="font-mono text-right break-all">{setting.host ?? '-'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">端口</span>
                <span>{setting.port ?? '-'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-app-secondary">用户名</span>
                <span className="font-mono text-right break-all">{setting.username ?? '-'}</span>
              </div>
              <div>
                <span className="mb-1 block text-app-secondary">脱敏代理</span>
                <span className="block break-all rounded-lg bg-neutral-50 p-3 font-mono text-xs">
                  {setting.maskedProxy ?? '未配置'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
