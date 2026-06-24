// client/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initTheme } from './lib/settings';
import './styles/index.css';

// Apply the saved theme (light / dark / system) before the first paint, and keep
// it in sync with settings changes and the OS preference.
initTheme();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
