import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { API_BASE, openExternal } from './api';
import { applyTheme, initialTheme, watchSystemTheme, type ThemeMode } from './theme';
import ServicesPanel from './ServicesPanel';
import PluginsPanel from './PluginsPanel';
import ModelsPanel from './ModelsPanel';
import PythonPanel from './PythonPanel';
import SettingsPanel from './SettingsPanel';
import ConnectionsPanel from './ConnectionsPanel';
import DataPanel from './DataPanel';
import { DesktopOverview } from './DesktopOverview';
import { DesktopSidebar, SECTION_META, type SectionId } from './DesktopSidebar';
import { useDesktopOverview } from './useDesktopOverview';
import { ExternalLinkIcon, MoonIcon, SunIcon } from './Icons';
import { PluginContributedScreen } from './PluginContributedUi';
import { parsePluginSection, pluginNavEntries, pluginSectionId } from './pluginContributions';
import PluginScreenPage from './PluginScreenPage';
import { pluginNavScreen } from './pluginScreens';
import { prefetchPanelData } from './panelCache';
// Explicit extension: on a case-insensitive filesystem the bare './SetupWizard'
// specifier would resolve to setupWizard.ts (the logic module) first.
import SetupWizard from './SetupWizard.tsx';
import {
  getSetupGuideState,
  isSetupGuideFirstRun,
  subscribeSetupGuideOpen,
  type SetupGuideState,
} from './setupWizard';

/**
 * FormLogic Desktop top-level UI (workspace-shell redesign, 2026-07):
 * a grouped sidebar (Operate / Local runtime / Manage) beside a workspace
 * header + body. Overview is a card-based control centre; the mature
 * operational panels (Services/Plugins/Models/Python/Settings) render
 * unchanged, and only the SELECTED panel is mounted — those panels poll every
 * 1.5–2 s, so keeping all of them alive would waste work in a tray-resident
 * app.
 *
 * The HTTP API is bound to 127.0.0.1:17872; the header pill polls
 * /api/health every 3 s (paused while the window is hidden) to confirm the
 * Rust side is up. If it's not, everything else shows "unreachable" without
 * crashing.
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

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  // Section is a core SectionId OR a plugin section (`plugin:<id>:<navId>`).
  const [section, setSection] = useState<string>('overview');
  // Section switches render a freshly-mounted panel — a heavy first render
  // used to FREEZE the click for up to a second. The split here: `section`
  // updates URGENTLY (sidebar highlight + header title change the instant the
  // click lands — the earlier startTransition wrapped BOTH, so nothing on
  // screen moved until the heavy panel committed and the click FELT frozen),
  // while the panel body renders from the DEFERRED value, so React prepares
  // the heavy tree at transition priority in the background.
  const changeSection = useCallback((s: string) => setSection(s), []);
  const deferredSection = useDeferredValue(section);
  // True while the new panel is still being prepared — dims the stale body.
  const sectionPending = deferredSection !== section;
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme);
  // First-run setup guide: auto-open ONCE (no localStorage record yet); from
  // then on the unobtrusive header pill / Settings re-open it while it stays
  // 'pending'. 'done' / 'dismissed' retire both the auto-open and the pill.
  const [setupGuideState, setSetupGuideState] = useState<SetupGuideState>(() =>
    getSetupGuideState(),
  );
  const [setupOpen, setSetupOpen] = useState<boolean>(() => isSetupGuideFirstRun());
  // Gentle context highlight after a wizard hand-off: the target section's
  // body gets a one-shot fading glow (no arrows, no tour) for ~2.5 s.
  const [setupHighlight, setSetupHighlight] = useState<string | null>(null);
  const setupHighlightTimer = useRef<number | null>(null);
  const overview = useDesktopOverview();
  const pluginList = overview.plugins?.plugins ?? [];
  const devMode = overview.plugins?.devMode ?? false;

  // PLG-203: nav entries contributed by installed v2 plugins. Every plugin —
  // including Aokie — supplies its own workspace through its manifest `ui`
  // contributions; the desktop carries no plugin-specific chrome.
  const pluginNav = pluginNavEntries(pluginList);
  // The plugin section (if any) currently selected, resolved to its snapshot.
  const activePluginSection = parsePluginSection(section);
  const activePlugin = activePluginSection
    ? pluginList.find((p) => p.id === activePluginSection.pluginId)
    : undefined;
  // Body-side twins derived from the DEFERRED section (the header/effects use
  // the urgent `section`; the panel body must agree with what it renders).
  const bodyPluginSection = parsePluginSection(deferredSection);
  const bodyPlugin = bodyPluginSection
    ? pluginList.find((p) => p.id === bodyPluginSection.pluginId)
    : undefined;
  // Manifest v2 `ui.screens`: a nav entry that declares `screen` (and whose
  // id resolves in the snapshot's declared screens) renders the plugin-shipped
  // SANDBOXED bundle instead of the declarative/compiled fallback. Today's
  // manifests declare none, so behavior is unchanged until a plugin ships one.
  const bodyPluginScreen =
    bodyPlugin && bodyPluginSection
      ? pluginNavScreen(bodyPlugin.ui, bodyPluginSection.navId)
      : null;
  useEffect(() => {
    // Legacy redirect: 'receptionist' was a hardcoded SectionId before the
    // Aokie plugin shipped its own manifest UI. A stored/stranded selection
    // resolves to the plugin's contributed nav section, else Overview — a
    // saved UI state must never dead-end on a retired section id.
    if (section === 'receptionist' && overview.loaded) {
      const aokieNav = pluginNav.find((n) => n.pluginId === 'aokie');
      setSection(aokieNav ? pluginSectionId(aokieNav.pluginId, aokieNav.navId) : 'overview');
    }
    // A plugin section whose plugin vanished (uninstalled/disabled) → Overview.
    if (
      activePluginSection &&
      overview.loaded &&
      !pluginList.some((p) => p.id === activePluginSection.pluginId && p.ui)
    ) {
      setSection('overview');
    }
  }, [section, overview.loaded, activePluginSection, pluginList, pluginNav]);

  const toggleTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    applyTheme(next);
  };

  useEffect(() => watchSystemTheme(setThemeState), []);

  // Settings' "Show the setup guide" button (a tiny module event — the wizard
  // state lives here, SettingsPanel takes no props).
  useEffect(
    () =>
      subscribeSetupGuideOpen(() => {
        setSetupGuideState(getSetupGuideState());
        setSetupOpen(true);
      }),
    [],
  );
  useEffect(
    () => () => {
      if (setupHighlightTimer.current !== null) {
        window.clearTimeout(setupHighlightTimer.current);
      }
    },
    [],
  );

  const closeSetupGuide = useCallback(() => {
    setSetupOpen(false);
    // The wizard persists 'pending'/'done'/'dismissed' itself — re-sync.
    setSetupGuideState(getSetupGuideState());
  }, []);

  const navigateFromSetup = useCallback((target: string) => {
    setSetupOpen(false);
    setSetupGuideState(getSetupGuideState());
    setSection(target);
    setSetupHighlight(target);
    if (setupHighlightTimer.current !== null) {
      window.clearTimeout(setupHighlightTimer.current);
    }
    setupHighlightTimer.current = window.setTimeout(() => {
      setSetupHighlight(null);
      setupHighlightTimer.current = null;
    }, 2500);
  }, []);

  // Warm the slow section endpoints (models disk scan, python venvs, plugin
  // list) once at startup so the first visit to those sections paints with
  // data instead of a 1–2 s spinner; the panels revalidate on mount anyway.
  useEffect(() => prefetchPanelData(), []);

  useEffect(() => {
    let id: number | undefined;
    const tick = async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/health`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const next: HealthResponse = await resp.json();
        // Identical payload keeps the previous object so React bails out —
        // this poll used to re-render the ENTIRE tree (including whichever
        // panel was mounted) every 3 s for no visible change, and could
        // restart an in-flight section transition.
        setHealth((prev) =>
          prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
        );
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

  // A plugin section has no SECTION_META entry — synthesize a header from the
  // plugin's contributed nav label.
  const meta =
    SECTION_META[section as SectionId] ??
    (activePlugin && activePluginSection
      ? {
          title:
            activePlugin.ui?.nav?.find((n) => n.id === activePluginSection.navId)?.label ??
            activePlugin.name,
          subtitle: `Contributed by the ${activePlugin.name} plugin`,
        }
      : { title: 'FormLogic Desktop', subtitle: '' });
  const cloudLabel = overview.runtime?.linked
    ? (() => {
        const url = overview.runtime?.baseUrl ?? overview.cloud?.baseUrl ?? '';
        try {
          return url ? new URL(url).host : 'Linked';
        } catch {
          return 'Linked';
        }
      })()
    : 'Not linked';

  return (
    <div className="desktop-shell">
      <DesktopSidebar
        section={section}
        onChange={changeSection}
        pendingPairing={overview.pendingPairing?.length ?? 0}
        cloudLabel={cloudLabel}
        pluginNav={pluginNav}
      />

      <div className="desktop-workspace">
        <header className="desktop-workspace-header">
          <div className="desktop-workspace-header__titles">
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          <div className="desktop-workspace-header__actions">
            {setupGuideState === 'pending' && !setupOpen && (
              <button
                type="button"
                className="desktop-setup-pill"
                onClick={() => setSetupOpen(true)}
                title="Finish setting up FormLogic Desktop"
              >
                Setup guide
              </button>
            )}
            {health ? (
              <span className="desktop-status-pill is-ok">
                <i />
                Desktop online · v{health.version}
              </span>
            ) : healthError ? (
              <span
                className="desktop-status-pill is-live"
                role="status"
                aria-label={`FormLogic Desktop API unreachable: ${healthError}`}
                title={`${API_BASE} — ${healthError}`}
              >
                <i />
                API unreachable
              </span>
            ) : (
              <span className="desktop-status-pill is-neutral">
                <i />
                checking…
              </span>
            )}
            <a
              className="desktop-icon-button"
              href="https://formlogic.com"
              aria-label="Open formlogic.com"
              title="formlogic.com"
              onClick={(e) => {
                e.preventDefault();
                void openExternal('https://formlogic.com').catch(() => undefined);
              }}
            >
              <ExternalLinkIcon size={15} />
            </a>
            <button
              type="button"
              className="desktop-icon-button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <SunIcon size={15} /> : <MoonIcon size={15} />}
            </button>
          </div>
        </header>

        <main
          className={`desktop-workspace__body${sectionPending ? ' is-section-pending' : ''}${
            setupHighlight !== null && setupHighlight === deferredSection
              ? ' setup-highlight'
              : ''
          }`}
        >
          {/* The body renders from the DEFERRED section (see changeSection):
              the sidebar/header answered the click already; the heavy panel
              tree mounts at transition priority. */}
          {deferredSection === 'overview' && (
            <DesktopOverview
              data={overview}
              onOpen={changeSection}
              onOpenPluginNav={(pid, nav) => changeSection(pluginSectionId(pid, nav))}
            />
          )}
          {deferredSection === 'services' && <ServicesPanel />}
          {deferredSection === 'models' && <ModelsPanel />}
          {deferredSection === 'plugins' && (
            <PluginsPanel
              onOpenPluginNav={(pid, nav) => changeSection(pluginSectionId(pid, nav))}
            />
          )}
          {deferredSection === 'python' && <PythonPanel />}
          {deferredSection === 'connections' && <ConnectionsPanel />}
          {deferredSection === 'data' && <DataPanel />}
          {deferredSection === 'settings' && <SettingsPanel />}
          {/* PLG-203: a plugin-contributed section — the plugin-shipped
              sandboxed bundle when the nav entry declares a `screen`, else the
              declarative status cards + actions. */}
          {bodyPlugin && bodyPluginSection && (
            bodyPluginScreen ? (
              <PluginScreenPage
                key={`${bodyPlugin.id}:${bodyPluginScreen.id}`}
                plugin={bodyPlugin}
                screen={bodyPluginScreen}
                theme={theme}
              />
            ) : (
              <PluginContributedScreen
                plugin={bodyPlugin}
                navId={bodyPluginSection.navId}
                devMode={devMode}
              />
            )
          )}
        </main>
      </div>

      {setupOpen && (
        <SetupWizard
          overview={overview}
          onNavigate={navigateFromSetup}
          onClose={closeSetupGuide}
        />
      )}
    </div>
  );
}
