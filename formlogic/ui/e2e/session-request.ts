import type { APIRequestContext } from '@playwright/test';
import { sessionJsonHeaders } from '../../../scripts/session-request.mjs';

// Share the frontend setting with playwright.config.ts, including split-origin API tests.
export const E2E_FRONTEND_BASE_URL = process.env.E2E_BASE_URL || 'http://formlogic.local';
export const sessionHeaders = () => sessionJsonHeaders(E2E_FRONTEND_BASE_URL);

export async function registerTestAccount(request: APIRequestContext, data: { name: string; email: string; password: string }) {
  const register = () => request.post('/api/auth/register', { headers: sessionHeaders(), data });
  const response = await register();
  // A browser matrix can fill the local server's shared, one-minute signup window.
  const retryAfter = response.headers()['retry-after'];
  if (response.status() === 429 && retryAfter && /^\d+$/.test(retryAfter) && Number(retryAfter) <= 60) {
    await response.dispose();
    await new Promise(resolve => setTimeout(resolve, Number(retryAfter) * 1000 + 250));
    return register();
  }
  return response;
}
