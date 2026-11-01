// Resolves the current custom-domain host to its app and decides what the host shows (spec §20.1
// Option A — same SPA, host-aware). On a domain of an installed SoftN app the app is the site: it
// opens full screen at the domain's own address, on every path but the legal pages. Other apps show
// their launch page at the root, and deeper paths (/app/:slug, /form/:id) render the normal app.
// Anything that takes a password happens on FormLogic itself, whose address the server gives
// (see domainSignIn). The site's own address, which the server names as such, renders the normal
// app. So does a host the server doesn't know, past its root, which says so.
//
// That makes every page of a self-hosted site a question for the server, and a real domain has two
// rules: no sign-in form on it, and its app or launch page on a first visit. A slow network must
// break neither, so only a real answer decides anything. No answer is asked for again for as long
// as the page is open, and when one comes it applies, over whatever is showing. Until then a page
// goes by what this browser last heard. A domain draws from its stored config, as if that had just
// been answered, but only an answer sends a password page to the address it names. A host
// remembered as none shows its pages, after a short wait where a password could be typed, or at a
// root that an answer could change. A host it knows nothing of waits, which costs a site one
// lookup in each browser: every path on a domain is its app's, so no platform page can show first.
// Only a form and the legal pages don't wait, as they open the same on any host.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { DomainNativeApp } from '../components/app-runtime/AppEntryRouter';
import { api } from '../lib/api';
import { signInDestination } from '../lib/authRedirect';
import { lookUpHost, rememberedHost, rememberHost, type LaunchConfig, type SoftnAccess } from '../lib/domainLaunchApi';
import { DomainSignInContext, finishDomainSignIn, startDomainSignIn } from '../lib/domainSignIn';
import { AppLaunchPage } from './AppLaunchPage';

const SIGN_IN_PATHS = ['/login', '/signup'];
const PASSWORD_PATHS = ['/forgot-password', '/reset-password', '/accept-invite'];
const LEGAL_PATHS = ['/privacy', '/terms'];
const SIGN_IN_RETURN_PATH = '/sign-in/complete';
/** The longest a page that takes a password waits, on a host remembered as no domain, for news that it has become one. */
const BRIEF_WAIT_MS = 2_500;
/** How long a page on a host nothing is known of waits before saying it can't reach the site. */
const LONG_WAIT_MS = 8_000;
/** Pauses between tries, the last repeating. */
const ASK_AGAIN_AFTER_MS = [3_000, 6_000, 12_000, 15_000];
/** As long as a host lookup may take: this request has no limit of its own. */
const ENTRY_TIMEOUT_MS = 15_000;

/** What a page goes by: the server's answer, or the last one this browser kept. */
interface HostAnswer {
  config?: LaunchConfig | null;
  softnAccess?: SoftnAccess;
  platform?: boolean;
}

/**
 * What the host is, and what its app is if it has one, or null while either has no real answer.
 * `isDomain` hears as soon as the host is known to be a customer's, before its app is.
 */
async function askServer(host: string, isDomain: (config: LaunchConfig) => void): Promise<HostAnswer | null> {
  const { config, answered, platform } = await lookUpHost(host);
  if (!answered) return null;
  if (!config) return { config, platform };
  isDomain(config);
  const entry = await Promise.race([
    api.getNativeEntry(config.app.slug),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ENTRY_TIMEOUT_MS)),
  ]);
  // This says no more about the app than a failed lookup does about the host, and taken for "no
  // SoftN app" it would show a SoftN app's domain the platform's pages.
  if (!entry || (entry.error && (entry.status === undefined || entry.status === 429 || entry.status >= 500))) {
    return null;
  }
  const softnAccess = entry.data?.native ? entry.data.access : undefined;
  rememberHost(host, config, softnAccess);
  return { config, softnAccess };
}

/** Where this domain's visitors sign in. Null where FormLogic is this very address: a local `?__flhost=` preview signs in as usual. */
function signInAddress(config: LaunchConfig | null | undefined): string | null {
  return config?.platformUrl && config.platformUrl !== window.location.origin ? config.platformUrl : null;
}

function Spinner() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-white dark:bg-slate-950">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600 dark:border-slate-700 dark:border-t-slate-300" />
    </div>
  );
}

/**
 * A host nothing is known of, with no answer from the server: it may be a customer's domain, so a
 * sign-in form never shows here. The page goes on asking, and an answer replaces this.
 */
function DomainUnreachable({ onTryAgain }: { onTryAgain: () => void }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-slate-950">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-white">Can't reach this site right now</h1>
      <p role="alert" className="max-w-sm text-sm text-gray-500 dark:text-slate-400">Check your connection and try again.</p>
      <button type="button" className="min-h-11 text-sm text-primary-600 dark:text-primary-400" onClick={onTryAgain}>Try again</button>
    </div>
  );
}

/** The end of the trip to FormLogic: the code in the address becomes this domain's session. */
function DomainSignInComplete({ platformUrl }: { platformUrl: string }) {
  const [failed, setFailed] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    // Out of the address bar and the history before anything else can read it.
    window.history.replaceState(null, '', window.location.pathname);
    void finishDomainSignIn(params.get('code'), params.get('state')).then(next => {
      if (next === null) setFailed(true);
      else window.location.replace(next);
    });
  }, []);
  if (!failed) return <Spinner />;
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-slate-950">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-white">That sign-in didn't finish</h1>
      <p role="alert" className="max-w-sm text-sm text-gray-500 dark:text-slate-400">It may have expired. Please try again.</p>
      <button type="button" className="min-h-11 text-sm text-primary-600 dark:text-primary-400" onClick={() => startDomainSignIn(platformUrl, 'login', '/')}>Sign in</button>
    </div>
  );
}

/** The domain's app manifest, so installing the page installs the app and not the platform. */
function useDomainManifest(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const created = !link;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    const previous = link.getAttribute('href');
    link.setAttribute('href', '/manifest.json');
    return () => {
      if (created) link.remove();
      else if (previous !== null) link.setAttribute('href', previous);
    };
  }, [active]);
}

export function DomainLaunchRouter({ host, children }: { host: string; children: ReactNode }) {
  const { pathname, search } = useLocation();
  const [heard, setHeard] = useState<HostAnswer | null>(null);
  // What the last visit learned. It stays as it was for this page: the answer on its way is `heard`.
  const [remembered] = useState(() => rememberedHost(host));
  // The server has said this is a customer's domain, and hasn't yet said what its app is.
  const [lookedUp, setLookedUp] = useState<LaunchConfig | null>(null);
  const [waited, setWaited] = useState(0);
  const askAgain = useRef(() => {});

  useEffect(() => {
    let over = false;
    let asking = false;
    let failures = 0;
    let nextTry: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (over || asking) return;
      asking = true;
      clearTimeout(nextTry);
      const answer = await askServer(host, setLookedUp);
      asking = false;
      if (over) return;
      if (answer) {
        over = true;
        setHeard(answer);
        return;
      }
      nextTry = setTimeout(() => void ask(), ASK_AGAIN_AFTER_MS[Math.min(failures, ASK_AGAIN_AFTER_MS.length - 1)]);
      failures += 1;
    };
    const askNow = () => {
      failures = 0;
      void ask();
    };
    askAgain.current = askNow;
    window.addEventListener('online', askNow);
    void ask();
    return () => {
      over = true;
      clearTimeout(nextTry);
      window.removeEventListener('online', askNow);
    };
  }, [host]);

  const answer: HostAnswer | null = heard ?? (remembered?.kind === 'domain' && remembered.config ? remembered : null);
  const asking = heard === null;
  useEffect(() => {
    if (!asking) return;
    const timers = [BRIEF_WAIT_MS, LONG_WAIT_MS].map((ms) => setTimeout(() => setWaited(ms), ms));
    return () => timers.forEach(clearTimeout);
  }, [asking]);

  const config = answer?.config ?? null;
  const softnAccess = answer?.softnAccess;
  const direct = config?.domain.mode === 'runtime_direct';
  // As the router matches: `/LOGIN/` is the login page too.
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  const platformUrl = signInAddress(config ?? lookedUp);
  const takesPassword = SIGN_IN_PATHS.includes(path) || PASSWORD_PATHS.includes(path);
  // On the server's word alone: a reset link's token goes with it, and storage can be old or wrong.
  const leavesFor = takesPassword ? signInAddress(heard ? heard.config : lookedUp) : null;
  const finishing = !!platformUrl && path === SIGN_IN_RETURN_PATH;
  const accountPage = takesPassword || LEGAL_PATHS.includes(path);
  // FormLogic's own address, if an older version let an app connect to it: /admin and /forms stay.
  const ownAddress = !!config?.platformUrl?.endsWith(`//${host}`);
  // A form's link and its embed are the same address. It opens the form, whatever the app.
  const formPage = path.startsWith('/form/');
  const showsApp = !!config && !!softnAccess && !ownAddress && !accountPage && !formPage && !finishing && !(pathname === '/' && !direct);
  useDomainManifest(showsApp);

  useEffect(() => {
    if (!leavesFor) return;
    if (SIGN_IN_PATHS.includes(path)) {
      const after = new URLSearchParams(search).get('redirect');
      startDomainSignIn(leavesFor, path === '/signup' ? 'signup' : 'login', signInDestination(after));
    } else {
      window.location.replace(`${leavesFor}${path}${search}`);
    }
  }, [leavesFor, path, search]);

  // runtime_direct on any other kind of app: this domain IS the app, at the app's usual URL.
  const redirects = !!config && !softnAccess && direct && pathname === '/';
  useEffect(() => {
    if (redirects && config) window.location.replace(`/app/${config.app.slug}`);
  }, [redirects, config]);

  if (redirects || leavesFor) return <Spinner />;
  const waitOrSayUnreachable = () => (waited < LONG_WAIT_MS ? <Spinner /> : <DomainUnreachable onTryAgain={() => askAgain.current()} />);
  if (platformUrl && takesPassword) return waitOrSayUnreachable();
  if (!answer) {
    if (!lookedUp && remembered?.kind === 'not-domain') {
      const asksToSignIn = takesPassword || path === SIGN_IN_RETURN_PATH || /^\/app(\/|$)/.test(path);
      // A host no list names, or the site's own with an app connected to it. Its root is the answer's to decide.
      const homeMayChange = pathname === '/' && !remembered.platform;
      if ((asksToSignIn || homeMayChange) && waited < BRIEF_WAIT_MS) return <Spinner />;
    } else if (!formPage && !LEGAL_PATHS.includes(path)) {
      return waitOrSayUnreachable();
    }
  }
  if (finishing && platformUrl) return <DomainSignInComplete platformUrl={platformUrl} />;
  if (showsApp && config && softnAccess) {
    return <DomainSignInContext.Provider value={platformUrl}><DomainNativeApp slug={config.app.slug} access={softnAccess} /></DomainSignInContext.Provider>;
  }
  if (!answer || answer.platform || pathname !== '/' || (config && softnAccess && accountPage)) {
    return <DomainSignInContext.Provider value={platformUrl}>{children}</DomainSignInContext.Provider>;
  }
  if (config) return <AppLaunchPage config={config} />;

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-2 bg-white px-6 text-center dark:bg-slate-950">
      <h1 className="text-lg font-semibold text-gray-900 dark:text-white">This domain isn't connected yet</h1>
      <p className="max-w-sm text-sm text-gray-500 dark:text-slate-400">
        <span className="font-mono">{host}</span> isn't pointing at a published FormLogic app. If you're the owner,
        finish connecting it in the app's settings.
      </p>
    </div>
  );
}
