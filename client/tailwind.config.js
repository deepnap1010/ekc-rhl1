// client/tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        base:    '#F4F6F9',   // main page background
        surface: '#FFFFFF',   // panels / sidebar
        raised:  '#F8F9FB',   // cards inside panels
        line:    '#E2E8F0',   // borders / dividers
        steel:   '#64748B',   // muted / secondary text
        primary: '#1E293B',   // primary body text
        accent:  '#0D9488',   // teal-600 (EKC brand action color)
        idle:    '#D97706',   // amber-600
        stopped: '#DC2626',   // red-600
        running: '#0D9488',   // same as accent
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { card: '10px' },
      boxShadow: {
        card: '0 1px 3px 0 rgba(0,0,0,0.07), 0 1px 2px -1px rgba(0,0,0,0.05)',
        panel: '0 1px 4px 0 rgba(0,0,0,0.06)',
      },
    },
  },
  plugins: [],
};
