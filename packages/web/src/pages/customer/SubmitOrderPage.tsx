import { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { publicApi } from '../../api/client';
import toast from 'react-hot-toast';
import { safeErrorMessage } from '../../utils/labels';

export default function SubmitOrderPage() {
  const [redemptionCode, setRedemptionCode] = useState('');
  const [session, setSession] = useState('');
  const [acceptedProtocol, setAcceptedProtocol] = useState(false);
  const [protocolError, setProtocolError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('');
  const protocolSectionRef = useRef<HTMLLabelElement>(null);
  const navigate = useNavigate();

  const triggerProtocolError = () => {
    setProtocolError('请先确认已核对信息并同意继续创建支付订单');
    const protocolSection = protocolSectionRef.current;
    if (!protocolSection) return;

    protocolSection.classList.remove('shake-active');
    void protocolSection.offsetWidth;
    protocolSection.classList.add('shake-active');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!acceptedProtocol) {
      triggerProtocolError();
      return;
    }

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
    <div className="checkout-shell">
      <div className="checkout-container">
        <form onSubmit={handleSubmit} className="checkout-content">
          <div className="checkout-brand-row">
            <div className="checkout-brand-mark">P</div>
            <div className="checkout-pill">安全收银台</div>
          </div>

          <h1 className="checkout-title">创建 Pix 支付订单</h1>
          <p className="checkout-lead">
            输入兑换码和 ChatGPT Session，系统会验证资格并生成 Pix 二维码。
          </p>

          <div className="checkout-field">
            <label className="checkout-label" htmlFor="redemption-code">
              兑换码
            </label>
            <input
              id="redemption-code"
              type="text"
              value={redemptionCode}
              onChange={(e) => setRedemptionCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              required
              autoComplete="off"
              spellCheck={false}
              className="checkout-input"
            />
          </div>

          <div className="checkout-field">
            <label className="checkout-label" htmlFor="session">
              ChatGPT Session
            </label>
            <textarea
              id="session"
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder="粘贴完整 session JSON、accessToken（3 段 eyJ...）或 session cookie"
              required
              rows={4}
              autoComplete="off"
              spellCheck={false}
              className="checkout-textarea"
            />
          </div>

          <label
            ref={protocolSectionRef}
            className="checkbox-wrapper protocol-section"
            onAnimationEnd={(e) => e.currentTarget.classList.remove('shake-active')}
          >
            <input
              type="checkbox"
              checked={acceptedProtocol}
              aria-describedby={protocolError ? 'protocol-error' : undefined}
              aria-invalid={protocolError ? 'true' : undefined}
              onChange={(e) => {
                setAcceptedProtocol(e.target.checked);
                if (e.target.checked) setProtocolError('');
              }}
            />
            <span className="custom-checkbox" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span>我确认已核对兑换码和 Session 信息，并同意继续创建支付订单。</span>
          </label>

          {protocolError && (
            <p id="protocol-error" className="protocol-error">
              {protocolError}
            </p>
          )}

          <button type="submit" disabled={loading} className="checkout-button">
            {loading ? step || '处理中...' : '提交订单'}
          </button>

          {loading && (
            <div className="view-section mt-5 text-center">
              <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
              <p className="mt-2 text-sm text-app-secondary">{step || '请稍候...'}</p>
            </div>
          )}

          <div className="mt-5 text-center">
            <Link to="/login" className="checkout-link">
              工作人员入口
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
