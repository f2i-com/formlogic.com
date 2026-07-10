// Public, platform-aware download page (audit FL-NATIVE-001).
//
// Custom-domain launch pages and "Get the app" prompts fall back to /download when a
// domain doesn't configure its own install URL — this route used to not exist, so a
// visitor steered to the native runtime landed on a 404 with no way into the app.
// Works logged-out, on the platform host AND on custom domains (RootGate only claims
// the root path there), and is honest about what is actually published per platform:
// Windows installers are attached to GitHub releases; everywhere else the web app /
// PWA is the supported path today.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Download, Globe, Monitor, Smartphone } from 'lucide-react';

const RELEASES_URL = 'https://github.com/f2i-com/formlogic.com/releases/latest';

type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/windows/i.test(ua)) return 'windows';
  if (/mac os x|macintosh/i.test(ua)) return 'macos';
  if (/linux/i.test(ua)) return 'linux';
  return 'unknown';
}

const PLATFORM_LABELS: Record<Platform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
  unknown: 'your device',
};

export function DownloadPage() {
  const platform = useMemo(() => detectPlatform(), []);
  const hasInstaller = platform === 'windows';

  return (
    <div className="min-h-[100dvh] w-full overflow-x-clip flex flex-col items-center justify-center px-6 py-16 bg-white dark:bg-slate-950">
      <main className="w-full max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-600 text-white shadow-lg">
          <Download className="h-8 w-8" />
        </div>
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Get the FormLogic app</h1>
        <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-slate-300">
          The FormLogic app runs your apps on the desktop with local device features — and everything also works right
          here in your browser.
        </p>

        <div className="mt-8 flex flex-col gap-3 text-left">
          {hasInstaller ? (
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-xl bg-primary-600 px-5 py-4 text-primary-foreground shadow-sm transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
            >
              <Monitor className="h-5 w-5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Download for Windows</span>
                <span className="block text-xs opacity-80">Installer from the latest release (with SHA-256 checksums)</span>
              </span>
            </a>
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-5 py-4 dark:border-slate-700 dark:bg-slate-900">
              <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-gray-400 dark:text-slate-500" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">
                  No installer for {PLATFORM_LABELS[platform]} yet
                </p>
                <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-slate-400">
                  The packaged app currently ships for Windows only. On {PLATFORM_LABELS[platform]}, use the web app —
                  you can install it to your home screen from your browser's menu for an app-like experience.
                </p>
              </div>
            </div>
          )}

          <Link
            to="/"
            className="flex items-center gap-3 rounded-xl border border-gray-200 px-5 py-4 text-gray-800 transition-colors hover:bg-gray-50 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-900"
          >
            <Globe className="h-5 w-5 shrink-0 text-gray-400 dark:text-slate-500" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Continue in your browser</span>
              <span className="block text-xs text-gray-500 dark:text-slate-400">Everything works on the web — no install needed</span>
            </span>
          </Link>

          {!hasInstaller && (
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              className="text-center text-xs font-medium text-gray-400 underline hover:no-underline dark:text-slate-500"
            >
              All releases and checksums on GitHub
            </a>
          )}
        </div>

        <p className="mt-8 text-xs leading-relaxed text-gray-400 dark:text-slate-500">
          If a business's app sent you here, it may also offer its own store listing on its launch page — and its web
          version stays available either way.
        </p>

        <button
          type="button"
          onClick={() => (window.history.length > 1 ? window.history.back() : undefined)}
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      </main>
    </div>
  );
}
