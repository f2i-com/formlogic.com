import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Set <html lang> to the user's browser locale so native date inputs
// (and other locale-sensitive elements) render in the correct format.
document.documentElement.lang = navigator.language || 'en';

// Promote the webfont preload to a live stylesheet. This used to be an inline
// onload= handler on the <link>, but the app-shell CSP (vite.config.ts) has no
// 'unsafe-inline'/'unsafe-hashes' for scripts, so the handler was blocked and
// the fonts never applied. Doing it here keeps the load non-render-blocking.
for (const link of document.querySelectorAll<HTMLLinkElement>('link[data-fl-font-promote]')) {
  link.rel = 'stylesheet';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
