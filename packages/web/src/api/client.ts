import axios from 'axios';

const commonConfig = {
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
};

const api = axios.create(commonConfig);
export const publicApi = axios.create(commonConfig);

export function shouldAttachAuth(url?: string): boolean {
  if (!url) return false;
  return url.startsWith('/admin') || url.startsWith('/worker') || url === '/auth/me';
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token && shouldAttachAuth(config.url)) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

export default api;
