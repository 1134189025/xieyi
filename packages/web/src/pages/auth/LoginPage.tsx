import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(username, password);
      const user = JSON.parse(localStorage.getItem('user') ?? '{}');
      navigate(user.role === 'ADMIN' ? '/admin' : '/worker');
      toast.success('登录成功');
    } catch {
      toast.error('用户名或密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="checkout-shell">
      <div className="checkout-container max-w-md">
        <form onSubmit={handleSubmit} className="checkout-content">
          <div className="checkout-brand-row">
            <div className="checkout-brand-mark">P</div>
            <div className="checkout-pill">工作人员登录</div>
          </div>

          <h1 className="checkout-title">Pix 协议支付平台</h1>
          <p className="checkout-lead">请输入账号密码进入工作台。</p>

          <div className="checkout-field">
            <label className="checkout-label" htmlFor="username">
              用户名
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="checkout-input text-left text-base tracking-normal"
            />
          </div>

          <div className="checkout-field">
            <label className="checkout-label" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="checkout-input text-left text-base tracking-normal"
            />
          </div>

          <button type="submit" disabled={loading} className="checkout-button">
            {loading ? '正在登录...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
