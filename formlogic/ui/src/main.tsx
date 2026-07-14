import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Set <html lang> to the user's browser locale so native date inputs
// (and other locale-sensitive elements) render in the correct format.
document.documentElement.lang = navigator.language || 'en';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
