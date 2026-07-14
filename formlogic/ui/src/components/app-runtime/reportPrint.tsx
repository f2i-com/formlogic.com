import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

/** Read the app runtime's accent colour so the detached print root (outside [data-app-runtime]) matches. */
export function readAppPrimary(): string {
  const host = document.querySelector('[data-app-runtime]') as HTMLElement | null;
  const v = host ? getComputedStyle(host).getPropertyValue('--app-primary').trim() : '';
  return v || '#6366f1';
}

/**
 * Render a document into a detached root and open the browser's print dialog ("Save as PDF").
 * Charts use fixed dimensions + no animation (print mode) so they're fully drawn before printing.
 * The print stylesheet (index.css) hides the app and shows only #fl-print-root while printing.
 */
export function printReportDocument(node: ReactElement): void {
  const host = document.createElement('div');
  host.id = 'fl-print-root';
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(node);

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', cleanup);
    try { root.unmount(); } catch { /* already gone */ }
    host.remove();
  };

  window.addEventListener('afterprint', cleanup);
  // Give React + recharts a beat to commit the SVGs, then print.
  window.setTimeout(() => {
    window.print();
    // Fallback cleanup for browsers that print asynchronously without firing afterprint.
    window.setTimeout(cleanup, 1000);
  }, 450);
}
