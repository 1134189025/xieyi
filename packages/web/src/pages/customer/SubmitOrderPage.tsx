import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../api/client';
import toast from 'react-hot-toast';

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
      setStep('Validating code...');
      const res = await api.post('/orders', {
        redemptionCode: redemptionCode.trim(),
        session: session.trim(),
      });

      toast.success('Order created successfully!');
      navigate(`/track/${res.data.trackingToken}`);
    } catch (error: unknown) {
      const msg =
        (error as { response?: { data?: { error?: string } } }).response?.data?.error ??
        'Failed to create order';
      toast.error(msg);
    } finally {
      setLoading(false);
      setStep('');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 px-8 py-8 text-center">
          <h1 className="text-2xl font-bold text-white">Pix Payment</h1>
          <p className="text-indigo-100 mt-2">Enter your redemption code and session to get started</p>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Redemption Code</label>
            <input
              type="text"
              value={redemptionCode}
              onChange={(e) => setRedemptionCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              required
              className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none font-mono text-lg tracking-wider text-center"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ChatGPT Session
              <span className="text-gray-400 font-normal ml-1">(accessToken or session cookie)</span>
            </label>
            <textarea
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder="Paste your accessToken (eyJ...) or session cookie here"
              required
              rows={4}
              className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-xs font-mono resize-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {loading ? step || 'Processing...' : 'Submit Order'}
          </button>

          {loading && (
            <div className="text-center">
              <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500 mt-2">{step || 'Please wait...'}</p>
            </div>
          )}
        </form>

        <div className="px-8 pb-6 text-center">
          <Link to="/login" className="text-sm text-indigo-600 hover:underline">
            Staff Login
          </Link>
        </div>
      </div>
    </div>
  );
}
