import { useEffect, useState } from 'react';
import { API_BASE, openExternal } from './api';
import { applyTheme, initialTheme, type ThemeMode } from './theme';
import ServicesPanel from './ServicesPanel';
import PluginsPanel from './PluginsPanel';
import ModelsPanel from './ModelsPanel';
import PythonPanel from './PythonPanel';
import SettingsPanel from './SettingsPanel';

/**
 * FormLogic Desktop top-level UI — a tray-resident dashboard with five tabs:
 *   Services · Plugins · Models · Python · Settings.
 *
 * The HTTP API is bound to 127.0.0.1:17872; the indicator in the header
 * just polls /api/health to confirm the Rust side is up. If it's not,
 * everything else gracefully shows "unreachable" without crashing.
 */

interface HealthResponse {
  status: string;
  companion: string;
  /** Pre-rebrand id ('formlogic-desktop'), kept for older web builds. */
  legacyCompanion?: string;
  version: string;
  apiVersion?: number;
  pluginApiVersion?: number;
}

type Tab = 'services' | 'plugins' | 'models' | 'python' | 'settings';

const TABS: { value: Tab; label: string }[] = [
  { value: 'services', label: 'Services' },
  { value: 'plugins', label: 'Plugins' },
  { value: 'models', label: 'Models' },
  { value: 'python', label: 'Python' },
  { value: 'settings', label: 'Settings' },
];

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('services');
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme);

  const toggleTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    applyTheme(next);
  };

  useEffect(() => {
    let id: number | undefined;
    const tick = async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/health`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setHealth(await resp.json());
        setHealthError(null);
      } catch (e) {
        setHealthError(e instanceof Error ? e.message : String(e));
        setHealth(null);
      }
    };
    // Tray-resident: run the interval only while the window is visible, so a
    // hidden window costs zero timer wake-ups (not just early-returning ticks).
    const start = () => {
      if (id !== undefined) return;
      tick();
      id = window.setInterval(tick, 3000);
    };
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVis = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    // Second, reliable start trigger: the Rust tray-reveal calls set_focus() right
    // after show(), and some webview backends don't emit visibilitychange on a
    // programmatic show — without this the badge can stick on "checking…" on the
    // launch-to-tray-then-Open path. start() is idempotent, so this can't double-run.
    window.addEventListener('focus', start);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', start);
    };
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">FL</span>
          <div className="brand-titles">
            <h1>FormLogic Desktop</h1>
            <p className="tagline">Local models, plugins &amp; hardware for FormLogic apps</p>
          </div>
        </div>
        <div className="header-status">
          <button
            type="button"
            className="icon-btn"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? (
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <a
            className="brand-link"
            href="https://formlogic.com"
            onClick={(e) => {
              e.preventDefault();
              openExternal('https://formlogic.com');
            }}
          >
            formlogic.com ↗
          </a>
          <code>{API_BASE}</code>
          {health ? (
            <span className="badge badge-ok">v{health.version}</span>
          ) : healthError ? (
            <span
              className="badge badge-err"
              role="status"
              aria-label={`FormLogic Desktop API unreachable: ${healthError}`}
              title={healthError}
            >
              unreachable
            </span>
          ) : (
            <span className="badge badge-pending">checking…</span>
          )}
        </div>
      </header>

      <nav
        className="tabs"
        role="tablist"
        aria-label="FormLogic Desktop sections"
        onKeyDown={(e) => {
          // Arrow-key roving between tabs (WAI-ARIA tabs pattern).
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const i = TABS.findIndex((t) => t.value === tab);
          const next =
            e.key === 'ArrowRight'
              ? (i + 1) % TABS.length
              : (i - 1 + TABS.length) % TABS.length;
          setTab(TABS[next].value);
          document.getElementById(`tab-${TABS[next].value}`)?.focus();
        }}
      >
        {TABS.map((t) => (
          <TabButton key={t.value} current={tab} value={t.value} onSelect={setTab}>
            {t.label}
          </TabButton>
        ))}
      </nav>

      <main className="app-main">
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'services' && <ServicesPanel />}
          {tab === 'plugins' && <PluginsPanel />}
          {tab === 'models' && <ModelsPanel />}
          {tab === 'python' && <PythonPanel />}
          {tab === 'settings' && <SettingsPanel />}
        </div>
      </main>
    </div>
  );
}

interface TabButtonProps {
  current: Tab;
  value: Tab;
  onSelect: (t: Tab) => void;
  children: React.ReactNode;
}

function TabButton({ current, value, onSelect, children }: TabButtonProps) {
  const selected = current === value;
  return (
    <button
      role="tab"
      id={`tab-${value}`}
      aria-selected={selected}
      aria-controls={`panel-${value}`}
      tabIndex={selected ? 0 : -1}
      className={`tab ${selected ? 'tab-active' : ''}`}
      onClick={() => onSelect(value)}
    >
      {children}
    </button>
  );
}
