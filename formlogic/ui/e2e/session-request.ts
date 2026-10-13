import { sessionJsonHeaders } from '../../../scripts/session-request.mjs';

// Share the frontend setting with playwright.config.ts, including split-origin API tests.
export const E2E_FRONTEND_BASE_URL = process.env.E2E_BASE_URL || 'http://formlogic.local';
export const sessionHeaders = () => sessionJsonHeaders(E2E_FRONTEND_BASE_URL);
