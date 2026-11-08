// The page's head on a customer's domain whose SoftN app opens there: the app's name in the tab and
// on a home screen, its description and theme colour, and the domain's manifest, from the first
// moment rather than once the app has loaded (NativeAppView, appLook.ts). Three things put them there,
// each where the others can't:
//   - the backend, in the domain's root page (AppLookController::withAppHead): a first visit, and a
//     search engine;
//   - public/domain-head.js, before the bundle, from what this browser last heard of the domain: a
//     page the service worker answers from its copy, a reload or an installed app opening;
//   - nameDomainPage() here, once the domain's answer has come: a first visit to any other path.
// Each element of the head they may change carries the site's own value (data-fl-original), and one
// they changed carries the value given it (data-fl-applied). Wherever the domain shows anything but
// its app, restorePlatformHead() gives the site's own back, where nothing else has changed it since.
import type { LaunchConfig, SoftnAccess } from './domainLaunchApi';

export const SIGN_IN_PATHS = ['/login', '/signup'];
export const PASSWORD_PATHS = ['/forgot-password', '/reset-password', '/accept-invite'];
export const LEGAL_PATHS = ['/privacy', '/terms'];
export const SIGN_IN_RETURN_PATH = '/sign-in/complete';

const ORIGINAL = 'data-fl-original';
const APPLIED = 'data-fl-applied';

/**
 * Whether a domain shows its app at this path (DomainLaunchRouter, which draws by it). Never on
 * FormLogic's own address, a page that takes a password, the legal pages, a form, the end of the way
 * back from signing in, or at the root of a domain that opens on its launch page.
 * public/domain-head.js decides the same, from the same inputs (domainHead.test.ts holds them equal).
 */
export function showsAppAt({ config, softnAccess, host, pathname, origin }: {
  config: LaunchConfig | null | undefined;
  softnAccess: SoftnAccess | undefined;
  host: string;
  pathname: string;
  /** This page's origin: where FormLogic is this very address, nobody leaves to sign in. */
  origin: string;
}): boolean {
  if (!config || !softnAccess) return false;
  // As the router matches: `/LOGIN/` is the login page too.
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  const signsInElsewhere = !!config.platformUrl && config.platformUrl !== origin;
  if ([...SIGN_IN_PATHS, ...PASSWORD_PATHS, ...LEGAL_PATHS].includes(path)) return false;
  if (signsInElsewhere && path === SIGN_IN_RETURN_PATH) return false;
  // FormLogic's own address, if an older version let an app connect to it.
  if (config.platformUrl?.endsWith(`//${host}`)) return false;
  if (path.startsWith('/form/')) return false;
  return !(pathname === '/' && config.domain.mode !== 'runtime_direct');
}

const valueOf = (element: Element): string | null =>
  element.tagName === 'TITLE' ? element.textContent ?? '' : element.getAttribute(element.tagName === 'LINK' ? 'href' : 'content');

function write(element: Element, value: string): void {
  if (element.tagName === 'TITLE') element.textContent = value;
  else element.setAttribute(element.tagName === 'LINK' ? 'href' : 'content', value);
}

/** Gives $selector's element $value where it still says what the site does. */
function name(selector: string, value: string): void {
  const element = document.head.querySelector(selector);
  const original = element?.getAttribute(ORIGINAL);
  if (!element || original === null || original === undefined || valueOf(element) !== original) return;
  write(element, value);
  element.setAttribute(APPLIED, value);
}

/**
 * The app's name and description, once the domain's answer has said them, where the head still says
 * the site's: a first visit to a path the backend doesn't write. Only an element whose site value
 * domain-head.js kept is changed, so none is ever taken for the site's that isn't.
 */
export function nameDomainPage(app: { name: string; description?: string | null }): void {
  if (!app.name) return;
  name('title', app.name);
  name('meta[name="apple-mobile-web-app-title"]', app.name);
  if (app.description) name('meta[name="description"]', app.description);
}

/**
 * The site's own head back, where the domain shows anything but its app: every element named for the
 * app that still says what it was given (a page that has since named itself is left as it is).
 */
export function restorePlatformHead(): void {
  for (const element of document.head.querySelectorAll(`[${APPLIED}]`)) {
    const original = element.getAttribute(ORIGINAL);
    if (original === null || valueOf(element) !== element.getAttribute(APPLIED)) continue;
    write(element, original);
    element.removeAttribute(APPLIED);
  }
}
