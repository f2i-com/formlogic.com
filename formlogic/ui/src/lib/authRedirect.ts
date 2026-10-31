/**
 * Where signing in (or signing up) leads: the `?redirect=` a page put on /login or
 * /signup when it sent a visitor there, else home.
 *
 * Only a same-origin path is honoured, judged as the browser will read it: `//host`, `/\host`
 * and `/<tab>/host` (a URL parser drops tabs and newlines) all lead to another origin, so the
 * answer is what parsing left, never the text that came in. Nor is a target that is itself a
 * sign-in page: once signed in, /login and /signup only send you on, so a
 * redirect to one of them has nowhere to go (and `/login?redirect=/login?…` is exactly
 * what a page that built its return address from the wrong URL produced).
 */
export function signInDestination(redirect: string | null | undefined): string {
  if (!redirect?.startsWith('/')) return '/';
  const base = 'https://formlogic.invalid';
  let target: URL;
  try {
    target = new URL(redirect, base);
  } catch {
    return '/';
  }
  if (target.origin !== base) return '/';
  const pathname = target.pathname.replace(/\/+$/, '').toLowerCase();
  if (pathname === '/login' || pathname === '/signup') return '/';
  return target.pathname + target.search + target.hash;
}
