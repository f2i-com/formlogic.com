import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ConfirmProvider } from './ConfirmDialog';
import { ToastProvider } from './Toasts';
import { applyTheme, initialTheme } from './theme';
import './styles.css';

// Set the theme class before first paint to avoid a flash of the wrong theme.
applyTheme(initialTheme(), { persist: false });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </React.StrictMode>,
);
