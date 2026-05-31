import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { publicApi } from '../../api/client';
import toast from 'react-hot-toast';
import { safeErrorMessage } from '../../utils/labels';

export default function SubmitOrderPage() {
  const [redemptionCode, setRedemptionCode] = useState('');
  const [session, setSession] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      setStep('正在验证兑换码...');
      const res = await publicApi.post('/orders', {
        redemptionCode: redemptionCode.trim(),
        session: session.trim(),
      });

      toast.success('订单创建成功');
      setSession('');
      navigate(`/track/${res.data.trackingToken}`);
    } catch (error: unknown) {
      toast.error(safeErrorMessage(error, '创建订单失败'));
    } finally {
      setLoading(false);
      setStep('');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 px-8 py-8 text-center">
          <h1 className="text-2xl font-bold text-white">Pix 协议支付</h1>
          <p className="text-indigo-100 mt-2">输入兑换码和 ChatGPT Session 后生成 Pix 二维码</p>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">兑换码</label>
            <input
              type="text"
              value={redemptionCode}
              onChange={(e) => setRedemptionCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              required
              autoComplete="off"
              spellCheck={false}
              className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-mono text-lg tracking-wider text-center"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ChatGPT Session
              <span className="text-gray-400 font-normal ml-1">（accessToken 或 session cookie）</span>
            </label>
            <textarea
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder="粘贴 accessToken（eyJ...）或 session cookie"
              required
              rows={4}
              autoComplete="off"
              spellCheck={false}
              className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-xs font-mono resize-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {loading ? step || '处理中...' : '提交订单'}
          </button>

          {loading && (
            <div className="text-center">
              <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500 mt-2">{step || '请稍候...'}</p>
            </div>
          )}
        </form>

        <div className="px-8 pb-6 text-center">
          <Link to="/login" className="text-sm text-indigo-600 hover:underline">
            工作人员登录
          </Link>
        </div>
      </div>
    </div>
  );
}
