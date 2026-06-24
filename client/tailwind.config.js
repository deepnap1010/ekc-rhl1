// client/tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Driven by CSS variables (see styles/index.css) so the palette can switch
      // between light/dark themes. `<alpha-value>` keeps opacity utilities working.
      colors: {
        base:    'rgb(var(--c-base) / <alpha-value>)',     // main page background
        surface: 'rgb(var(--c-surface) / <alpha-value>)',  // panels / sidebar
        raised:  'rgb(var(--c-raised) / <alpha-value>)',   // cards inside panels
        line:    'rgb(var(--c-line) / <alpha-value>)',     // borders / dividers
        steel:   'rgb(var(--c-steel) / <alpha-value>)',    // muted / secondary text
        primary: 'rgb(var(--c-primary) / <alpha-value>)',  // primary body text
        accent:  'rgb(var(--c-accent) / <alpha-value>)',   // teal (EKC brand action color)
        idle:    'rgb(var(--c-idle) / <alpha-value>)',     // amber
        stopped: 'rgb(var(--c-stopped) / <alpha-value>)',  // red
        running: 'rgb(var(--c-running) / <alpha-value>)',  // same as accent
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
