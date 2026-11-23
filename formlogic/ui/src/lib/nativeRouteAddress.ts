// Clean URL bar mapping for hosted SoftN & JavaScript apps.
//
// Visitors can navigate directly to clean paths such as:
//   - Custom domain:  https://mysite.com/about.html   -> app place "/about.html"
//   - Platform root:  /app/mysite/about.html          -> app place "/about.html"
//   - Standalone:     /app/mysite/native/about.html   -> app place "/about.html"
//
// Legacy hash bookmarks (#/about.html) are still read when on the app's root so existing shared
// links keep working. Reserved platform / Form App subroutes are never hijacked; if an app ever
// navigates to a colliding path it safely falls back to a hash address (#/path).

const MAX_PLACE_LENGTH = 2000;

/** Paths reserved on a custom domain for FormLogic auth, legal pages, APIs, and static assets. */
const DOMAIN_RESERVED_EXACT = new Set([
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
  '/privacy',
  '/terms',
  '/sign-in/complete',
  '/sign-in/domain',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.json',
]);

const DOMAIN_RESERVED_PREFIXES = [
  '/api/',
  '/form/',
  '/assets/',
  '/hosted-runtime/',
  '/app-editors/',
  '/zipp/',
  '/oauth/',
  '/plugins/',
];

/** Subroutes under `/app/:slug` that belong to FormLogic Form Apps rather than SoftN app pages. */
const FORM_APP_RESERVED_EXACT = new Set([
  '/native',
  '/project',
  '/records',
  '/reports',
  '/profile',
  '/login',
  '/signup',
  '/aokie',
  '/sitemap.xml',
]);

const FORM_APP_RESERVED_PREFIXES = [
  '/native/',
  '/project/',
  '/form/',
  '/forms/',
  '/records/',
  '/reports/',
  '/profile/',
];

export function isValidAppPlace(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PLACE_LENGTH) return false;
  if (!/^\/(?!\/)/.test(value)) return false;
  if (/[\x00-\x1f\x7f\\]/.test(value)) return false;
  const pathPart = value.split(/[?#]/, 1)[0];
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(pathPart)) return false;
  if (/%2e|%2f|%5c/i.test(pathPart)) return false;
  try {
    const parsed = new URL(value, 'https://app.invalid');
    if (parsed.origin !== 'https://app.invalid') return false;
    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) return false;
  } catch {
    return false;
  }
  return true;
}

function normalizePathname(raw: string): string {
  const pathOnly = raw.split(/[?#]/, 1)[0];
  try {
    const parsed = new URL(pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`, 'https://app.invalid');
    return parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return pathOnly.toLowerCase().replace(/\/+$/, '') || '/';
  }
}

/**
 * Extracts the subpath after `/app/<slug>` (or `null` if `pathname` is not under `/app/<slug>`).
 * Returns `""` when `pathname` is `/app/<slug>` or `/app/<slug>/`.
 */
export function extractPlatformAppSubpath(pathname: string, slug: string): string | null {
  if (!slug) return null;
  const variants = [
    `/app/${slug}`,
    `/app/${encodeURIComponent(slug)}`,
  ];
  const lower = pathname.toLowerCase();
  for (const prefix of variants) {
    const lowerPrefix = prefix.toLowerCase();
    if (lower === lowerPrefix || lower === `${lowerPrefix}/`) return '';
    if (lower.startsWith(`${lowerPrefix}/`)) {
      return pathname.slice(prefix.length);
    }
  }
  return null;
}

/**
 * True when a subpath under `/app/:slug` belongs to FormLogic's Form App runtime
 * (`/records`, `/form/:id`, `/reports`, `/profile`, `/native`, `/project`, etc.).
 */
export function isFormAppSubroute(subpath: string): boolean {
  if (!subpath || subpath === '/') return false;
  const clean = normalizePathname(subpath);
  if (FORM_APP_RESERVED_EXACT.has(clean)) return true;
  return FORM_APP_RESERVED_PREFIXES.some(prefix => clean.startsWith(prefix));
}

export function isDomainReservedPath(pathname: string): boolean {
  const clean = normalizePathname(pathname);
  if (DOMAIN_RESERVED_EXACT.has(clean)) return true;
  return DOMAIN_RESERVED_PREFIXES.some(prefix => clean.startsWith(prefix));
}

function hashPlace(hash: string): string | null {
  if (!/^#\/(?!\/)/.test(hash) || hash.length > MAX_PLACE_LENGTH + 1) return null;
  const candidate = hash.slice(1);
  return isValidAppPlace(candidate) ? candidate : null;
}

/**
 * Determines the platform URL base prefix for the current address:
 *   - `""` on a custom domain
 *   - `"/app/<slug>/native"` when mounted under `/app/<slug>/native...`
 *   - `"/app/<slug>"` when mounted under `/app/<slug>...`
 *   - `null` when mounted inside another page (e.g. Studio preview)
 */
export function resolveAppBasePrefix(pathname: string, slug: string, onDomain: boolean): string | null {
  if (onDomain) return '';
  const sub = extractPlatformAppSubpath(pathname, slug);
  if (sub === null) return null;
  const prefix = pathname.slice(0, pathname.length - sub.length).replace(/\/+$/, '');
  if (/^\/native(?:\/|$)/i.test(sub)) {
    return `${prefix}/native`;
  }
  return prefix;
}

/**
 * Reads the SoftN app place (e.g. `"/about.html"`, `"/docs/guide.html#team"`) from the browser's
 * current address. Returns `null` when the browser is at the app's root with no subpage or hash.
 */
export function readAppPlace(opts: {
  pathname: string;
  search?: string;
  hash?: string;
  slug: string;
  onDomain: boolean;
}): string | null {
  const { pathname, search = '', hash = '', slug, onDomain } = opts;
  // Strip local dev preview override (`__flhost`) before passing search params into the app.
  const appSearch = stripInternalQueryParams(search);
  const fromHash = hashPlace(hash);

  if (onDomain) {
    const normalized = pathname || '/';
    if (normalized === '/' || isDomainReservedPath(normalized)) {
      return fromHash;
    }
    const candidate = `${normalized}${appSearch}${hash}`;
    return isValidAppPlace(candidate) ? candidate : fromHash;
  }

  const base = resolveAppBasePrefix(pathname, slug, false);
  if (base === null) return fromHash;
  const rest = pathname.slice(base.length);
  if (!rest || rest === '/') {
    return fromHash;
  }
  // Never misinterpret a reserved Form App subroute as a SoftN page when at `/app/<slug>`.
  if (!base.toLowerCase().endsWith('/native') && isFormAppSubroute(rest)) {
    return fromHash;
  }
  const candidate = `${rest}${appSearch}${hash}`;
  return isValidAppPlace(candidate) ? candidate : fromHash;
}

/**
 * Builds the browser address bar URL (path + query + hash) representing `place` inside the app.
 * Uses clean paths (`/about.html`, `/app/mysite/about.html`, `/app/mysite/native/about.html`)
 * and falls back to `#/path` only when the path collides with a reserved FormLogic route.
 */
export function buildAppAddress(place: string, opts: {
  pathname: string;
  search?: string;
  slug: string;
  onDomain: boolean;
}): string | null {
  if (!isValidAppPlace(place)) return null;
  const { pathname, search = '', slug, onDomain } = opts;

  // Split place into path, query, and hash.
  const hashAt = place.indexOf('#');
  const withoutHash = hashAt >= 0 ? place.slice(0, hashAt) : place;
  const placeHash = hashAt >= 0 ? place.slice(hashAt) : '';
  const queryAt = withoutHash.indexOf('?');
  const placePath = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
  const placeQuery = queryAt >= 0 ? withoutHash.slice(queryAt + 1) : '';

  // Preserve internal platform query params (e.g. `?__flhost=` for local custom-domain previews).
  const preserved = keepInternalQueryParams(search);
  const mergedSearch = mergeQueryStrings(preserved, placeQuery);

  if (onDomain) {
    if (placePath === '/') {
      return `/${mergedSearch}${placeHash}`;
    }
    if (isDomainReservedPath(placePath)) {
      return `/${preserved ? `?${preserved}` : ''}#${place}`;
    }
    return `${placePath}${mergedSearch}${placeHash}`;
  }

  const base = resolveAppBasePrefix(pathname, slug, false);
  if (base === null) {
    const clean = place === '/' ? '' : `#${place}`;
    return `${pathname}${search}${clean}`;
  }

  if (placePath === '/') {
    return `${base}${mergedSearch}${placeHash}`;
  }

  // On `/app/<slug>`, avoid colliding with `/app/<slug>/native`, `/project`, `/form/...`, etc.
  if (!base.toLowerCase().endsWith('/native') && isFormAppSubroute(placePath)) {
    return `${base}${preserved ? `?${preserved}` : ''}#${place}`;
  }

  return `${base}${placePath}${mergedSearch}${placeHash}`;
}

function stripInternalQueryParams(search: string): string {
  if (!search || search === '?') return '';
  const params = new URLSearchParams(search);
  params.delete('__flhost');
  const text = params.toString();
  return text ? `?${text}` : '';
}

function keepInternalQueryParams(search: string): string {
  if (!search || search === '?') return '';
  const params = new URLSearchParams(search);
  const kept = new URLSearchParams();
  const flhost = params.get('__flhost');
  if (flhost !== null) kept.set('__flhost', flhost);
  return kept.toString();
}

function mergeQueryStrings(internalQuery: string, placeQuery: string): string {
  if (!internalQuery && !placeQuery) return '';
  if (!internalQuery) return `?${placeQuery}`;
  if (!placeQuery) return `?${internalQuery}`;
  return `?${internalQuery}&${placeQuery}`;
}
