import { matchPath } from 'react-router-dom';

// Routes that render for logged-out users. When a user logs out (or their session
// expires), AppRoutes swaps to the logged-out route table — so any authed-only URL
// they were sitting on (e.g. /forms) would fall through to the 404 page. This sends
// them home instead, while leaving them in place on genuinely public routes (a
// shared /form/:id link, an /app/:slug runtime, legal/marketing pages, etc.).
const PUBLIC_PATHS = [
  '/',
  '/login',
  '/signup',
  '/connect-ai',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
  '/form/:formId',
  '/packs',
  '/packs/:slug',
  '/docs',
  '/ai-setup',
  '/aokie',
  '/privacy',
  '/terms',
  '/app/:appSlug/*',
  '/open/app/:appSlug/*',
  '/device-check',
  '/download',
  // OAuth consent renders signed-out too (it routes through login and back) — don't bounce
  // a mid-flow visitor to the landing page on logout/session expiry.
  '/oauth/authorize',
  // Signing in to an app on its own domain goes the same way through login.
  '/sign-in/domain',
];

/** Whether the logged-out route table has a page for this URL. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((pattern) => matchPath(pattern, pathname));
}
