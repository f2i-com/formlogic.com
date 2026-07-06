// Branded launch page shown when an app is served on its own custom domain.
//
// This is the "it's OUR app, on OUR domain" surface (spec §21): the app's identity
// and accent take over the whole page; the primary action is opening the app. It
// renders from PUBLIC-SAFE launch metadata only (no form/field/report internals)
// and works logged-out.
import { useEffect, useMemo, useState } from 'react';
import { readableForegroundColor } from '../lib/color';
import type { LaunchConfig } from '../lib/domainLaunchApi';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function AppLaunchPage({ config }: { config: LaunchConfig }) {
  const { app, landing, native } = config;
  const accent = app.theme.primaryColor || '#6366f1';
  const onAccent = useMemo(() => (accent.startsWith('#') ? readableForegroundColor(accent) : '#fff'), [accent]);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  // Set when the `formlogic://` handoff didn't take (the runtime isn't installed) so we can offer a
  // clear "Get the app" fallback instead of silently dropping the user onto the web app.
  const [nativeMissing, setNativeMissing] = useState(false);

  // Brand the tab + browser chrome for the app.
  useEffect(() => {
    const prevTitle = document.title;
    document.title = landing.headline || app.name;
    const meta = document.querySelector('meta[name="theme-color"]');
    const prevTheme = meta?.getAttribute('content') ?? null;
    if (meta) meta.setAttribute('content', accent);
    return () => {
      document.title = prevTitle;
      if (meta && prevTheme !== null) meta.setAttribute('content', prevTheme);
    };
  }, [accent, landing.headline, app.name]);

  // Capture the install prompt so the "Install app" button can trigger it directly.
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Point the browser's install manifest at THIS domain's app manifest. `/manifest.json` is served
  // per-Host by the backend, so "Install app" installs the custom-domain app — not the default platform
  // manifest. Create the <link rel="manifest"> if it's missing; restore the previous href (or remove a
  // link we created) on unmount. Mirrors the title/theme-color effect above.
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const created = !link;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    const prevHref = created ? null : link.getAttribute('href');
    link.setAttribute('href', '/manifest.json');
    return () => {
      if (!link) return;
      if (created) {
        link.parentNode?.removeChild(link);
      } else if (prevHref !== null) {
        link.setAttribute('href', prevHref);
      } else {
        link.removeAttribute('href');
      }
    };
  }, []);

  const openUrl = `/app/${app.slug}`;
  const monogram = (app.name || '?').trim().charAt(0).toUpperCase();

  // Native-runtime affordances, from the public-safe native section of the launch config.
  const requireNative = !!native?.requireNativeRuntime;
  // Show the native CTA when the launch page opts in, when the domain flags it, or when the app REQUIRES
  // the runtime (in which case it becomes the primary way in).
  const showNativeCta = landing.showInstallNative || !!native?.showNativeCta || requireNative;
  // Prefer the domain's own install URL (store listing / white-label build); fall back to the platform
  // download page only when the domain didn't set one.
  const nativeInstallUrl = native?.installUrl || 'https://formlogic.com/download';

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  // Hand off to the installed FormLogic Native Runtime via a deep link, so the user
  // never types a URL. `formlogic://open?url=…` is claimed by the runtime's intent
  // filter (Android) / scheme registration (desktop) — the guaranteed handoff that
  // needs no per-domain App-Links verification. If nothing handles it — the runtime
  // isn't installed — the tab stays visible and we reveal a "Get the app" fallback
  // (rather than silently dropping to the web app).
  function openInNativeRuntime() {
    setNativeMissing(false);
    const target = window.location.origin + openUrl;
    const deepLink = `formlogic://open?url=${encodeURIComponent(target)}`;
    let handedOff = false;
    const markHandedOff = () => {
      handedOff = true;
    };
    document.addEventListener('visibilitychange', markHandedOff, { once: true });
    window.setTimeout(() => {
      document.removeEventListener('visibilitychange', markHandedOff);
      if (!handedOff && document.visibilityState === 'visible') {
        setNativeMissing(true);
      }
    }, 1400);
    window.location.href = deepLink;
  }

  return (
    <div
      className="relative min-h-[100dvh] w-full overflow-x-clip flex flex-col items-center justify-center px-6 py-16 text-center bg-white dark:bg-slate-950"
      style={{ ['--accent' as string]: accent, ['--on-accent' as string]: onAccent }}
    >
      {/* Ambient accent glow behind the identity — the one bold flourish. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[45vh] opacity-[0.14] blur-3xl"
        style={{ background: `radial-gradient(60% 60% at 50% 0%, ${accent} 0%, transparent 70%)` }}
      />

      <main className="relative z-10 flex w-full max-w-md flex-col items-center">
        {/* App identity */}
        {landing.logoUrl || app.logoUrl ? (
          <img
            src={(landing.logoUrl || app.logoUrl) as string}
            alt=""
            className="h-20 w-20 rounded-2xl object-cover shadow-lg ring-1 ring-black/5"
          />
        ) : (
          <div
            className="flex h-20 w-20 items-center justify-center rounded-2xl text-3xl font-bold shadow-lg"
            style={{ background: accent, color: onAccent }}
          >
            {monogram}
          </div>
        )}

        <h1 className="mt-6 text-3xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-4xl">
          {landing.headline || app.name}
        </h1>
        {landing.subheadline && (
          <p className="mt-3 text-base leading-relaxed text-gray-600 dark:text-slate-300">{landing.subheadline}</p>
        )}

        {/* Capability chips */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Chip>Web app</Chip>
          {landing.showInstallPwa && !requireNative && <Chip>Installable</Chip>}
          {showNativeCta && <Chip>Native ready</Chip>}
        </div>

        {/* Actions */}
        <div className="mt-9 flex w-full flex-col gap-3">
          {/* When the app REQUIRES the native runtime, demote the web app: hide the primary "Open app"
              button (and the PWA install) and steer to the runtime instead. */}
          {landing.showOpenWebApp && !requireNative && (
            <a
              href={openUrl}
              className="inline-flex h-12 w-full items-center justify-center rounded-xl px-6 text-sm font-semibold shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
              style={{ background: accent, color: onAccent, ['--tw-ring-color' as string]: accent }}
            >
              Open app
            </a>
          )}
          {landing.showInstallPwa && installPrompt && !requireNative && (
            <button
              type="button"
              onClick={install}
              className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-gray-200 px-6 text-sm font-semibold text-gray-800 transition-colors hover:bg-gray-50 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-900"
            >
              Install app
            </button>
          )}
          {showNativeCta && (
            <button
              type="button"
              onClick={openInNativeRuntime}
              className={
                requireNative
                  ? 'inline-flex h-12 w-full items-center justify-center rounded-xl px-6 text-sm font-semibold shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'
                  : 'inline-flex h-12 w-full items-center justify-center rounded-xl border border-gray-200 px-6 text-sm font-semibold text-gray-800 transition-colors hover:bg-gray-50 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-900'
              }
              style={requireNative ? { background: accent, color: onAccent, ['--tw-ring-color' as string]: accent } : undefined}
            >
              Open in the app
            </button>
          )}

          {/* This app is configured to require the native runtime — make that explicit and give a way in. */}
          {requireNative && (
            <p className="text-xs leading-relaxed text-gray-500 dark:text-slate-400">
              This app opens in the FormLogic app.{' '}
              <a href={nativeInstallUrl} target="_blank" rel="noreferrer" className="font-medium underline hover:no-underline">
                Get the app
              </a>
            </p>
          )}

          {/* Fallback: the `formlogic://` handoff didn't take, so the native runtime isn't installed.
              Offer a clear way to get it — and (unless the app requires it) to continue in the browser. */}
          {showNativeCta && nativeMissing && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-left dark:border-slate-700 dark:bg-slate-900">
              <p className="text-sm font-medium text-gray-800 dark:text-slate-100">Don't have the app yet?</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-slate-400">
                {requireNative
                  ? 'Nothing on this device opened the FormLogic app. Install it to continue.'
                  : 'Nothing on this device opened the native runtime. Install it, or keep going in your browser.'}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <a
                  href={nativeInstallUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 flex-1 items-center justify-center rounded-lg px-4 text-sm font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  style={{ background: accent, color: onAccent, ['--tw-ring-color' as string]: accent }}
                >
                  Get the FormLogic app
                </a>
                {!requireNative && (
                  <a
                    href={openUrl}
                    className="inline-flex h-10 flex-1 items-center justify-center rounded-lg border border-gray-200 px-4 text-sm font-semibold text-gray-800 transition-colors hover:bg-gray-100 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    Continue in browser
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {landing.description && (
          <p className="mt-8 text-sm leading-relaxed text-gray-500 dark:text-slate-400">{landing.description}</p>
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-10 mt-14 flex flex-col items-center gap-3 text-xs text-gray-400 dark:text-slate-500">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {landing.supportEmail && (
            <a className="hover:text-gray-600 dark:hover:text-slate-300" href={`mailto:${landing.supportEmail}`}>
              Support
            </a>
          )}
          {landing.privacyUrl && (
            <a className="hover:text-gray-600 dark:hover:text-slate-300" href={landing.privacyUrl}>
              Privacy
            </a>
          )}
          {landing.termsUrl && (
            <a className="hover:text-gray-600 dark:hover:text-slate-300" href={landing.termsUrl}>
              Terms
            </a>
          )}
        </div>
        {landing.showPoweredBy && (
          <a href="https://formlogic.com" className="hover:text-gray-600 dark:hover:text-slate-300">
            Powered by FormLogic
          </a>
        )}
      </footer>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
      {children}
    </span>
  );
}
