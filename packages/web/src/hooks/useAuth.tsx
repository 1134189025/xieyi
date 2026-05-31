import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import api from '../api/client';

interface User {
  id: string;
  username: string;
  role: 'ADMIN' | 'WORKER';
  displayName: string | null;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isAdmin: boolean;
  isWorker: boolean;
  authStatus: 'checking' | 'authenticated' | 'anonymous';
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [authStatus, setAuthStatus] = useState<AuthContextType['authStatus']>(() =>
    localStorage.getItem('token') ? 'checking' : 'anonymous',
  );

  const clearAuth = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
    setAuthStatus('anonymous');
  }, []);

  useEffect(() => {
    if (!token) {
      setAuthStatus('anonymous');
      return;
    }

    let cancelled = false;
    setAuthStatus('checking');
    api
      .get('/auth/me')
      .then((res) => {
        if (cancelled) return;
        const currentUser = res.data.user as User;
        localStorage.setItem('user', JSON.stringify(currentUser));
        setUser(currentUser);
        setAuthStatus('authenticated');
      })
      .catch(() => {
        if (!cancelled) clearAuth();
      });

    return () => {
      cancelled = true;
    };
  }, [clearAuth, token]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post('/auth/login', { username, password });
    const { token: newToken, user: newUser } = res.data;
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
    setAuthStatus('authenticated');
  }, []);

  const logout = useCallback(() => clearAuth(), [clearAuth]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        login,
        logout,
        isAdmin: user?.role === 'ADMIN',
        isWorker: user?.role === 'WORKER',
        authStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
