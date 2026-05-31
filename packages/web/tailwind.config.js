/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        app: {
          body: 'var(--bg-body)',
          surface: 'var(--surface)',
          primary: 'var(--fg-primary)',
          secondary: 'var(--fg-secondary)',
          border: 'var(--border-light)',
          accent: 'var(--accent)',
          accentHover: 'var(--accent-hover)',
          success: 'var(--success)',
          error: 'var(--error)',
        },
      },
      borderRadius: {
        card: 'var(--radius-card)',
      },
      boxShadow: {
        checkout:
          '0 24px 48px -12px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.04)',
      },
      transitionTimingFunction: {
        checkout: 'cubic-bezier(0.25, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
};
