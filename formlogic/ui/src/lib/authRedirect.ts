/**
 * Where signing in (or signing up) leads: the `?redirect=` a page put on /login or
 * /signup when it sent a visitor there, else home.
 *
 * Only a same-origin path is honoured: protocol-relative (`//host`) and backslash
 * (`/\host`) forms would be open redirects to another origin. Nor is a target that is
 * itself a sign-in page: once signed in, /login and /signup only send you on, so a
 * redirect to one of them has nowhere to go (and `/login?redirect=/login?…` is exactly
 * what a page that built its return address from the wrong URL produced).
 */
export function signInDestination(redirect: string | null | undefined): string {
  if (!redirect || !/^\/(?![/\\])/.test(redirect)) return '/';
  const pathname = redirect.split(/[?#]/, 1)[0].replace(/\/+$/, '').toLowerCase();
  if (pathname === '/login' || pathname === '/signup') return '/';
  return redirect;
}
