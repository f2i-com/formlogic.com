import { startTransition, useCallback, useEffect, useState } from 'react';
import { API_BASE, openExternal } from './api';
import { applyTheme, initialTheme, watchSystemTheme, type ThemeMode } from './theme';
import ServicesPanel from './ServicesPanel';
import PluginsPanel from './PluginsPanel';
import ModelsPanel from './ModelsPanel';
import PythonPanel from './PythonPanel';
import SettingsPanel from './SettingsPanel';
import ConnectionsPanel from './ConnectionsPanel';
import ReceptionistPanel from './aokie/ReceptionistPanel';
import { DesktopOverview } from './DesktopOverview';
import { DesktopSidebar, SECTION_META, type SectionId } from './DesktopSidebar';
import { useDesktopOverview } from './useDesktopOverview';
import { ExternalLinkIcon, MoonIcon, SunIcon } from './Icons';
import { PluginContributedScreen } from './PluginContributedUi';
import { parsePluginSection, pluginNavEntries } from './pluginContributions';
import { getAokieUiSource } from './aokieUiSource';
import { prefetchPanelData } from './panelCache';

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
  // used to FREEZE the click for up to a second. startTransition keeps the
  // current UI interactive while React prepares the new panel.
  const changeSection = useCallback(
    (s: string) => startTransition(() => setSection(s)),
    [],
  );
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme);
  const overview = useDesktopOverview();
  const pluginList = overview.plugins?.plugins ?? [];
  const devMode = overview.plugins?.devMode ?? false;

  // The AI Receptionist workspace is the Aokie PLUGIN's UI, not core chrome:
  // it exists only while the plugin is installed (uninstalled → nav entry and
  // panel disappear; the Plugins page still offers the bundled template).
  const aokieInstalled = pluginList.some((p) => p.id === 'aokie');
  // AOK-305: which Aokie UI to render. `compiled` (default) keeps the proven
  // interactive panel + hardcoded nav/hero and suppresses the manifest's; only
  // `manifest` lights up Aokie's declarative ui contributions. This is a
  // desktop-side flip — no plugin redeploy — so it's the instant rollback.
  const aokieUiSource = getAokieUiSource();
  const allPluginNav = pluginNavEntries(pluginList);
  // Manifest mode additionally requires the installed plugin to actually
  // CONTRIBUTE a nav entry — with a v1/ui-less manifest the flag would
  // otherwise hide the compiled nav with nothing standing in (receptionist
  // unreachable). Self-heals to compiled until the v2 manifest is deployed.
  const aokieManifestMode =
    aokieUiSource === 'manifest' &&
    aokieInstalled &&
    allPluginNav.some((n) => n.pluginId === 'aokie');
  // The compiled receptionist nav/panel exists while Aokie is installed UNLESS
  // we're in manifest mode (then the manifest's nav owns it).
  const receptionistAvailable = (!overview.loaded || aokieInstalled) && !aokieManifestMode;
  // PLG-203: nav entries contributed by installed v2 plugins. In compiled mode
  // Aokie's own manifest nav is filtered out (the compiled 'receptionist' entry
  // stands in for it) so a v2 Aokie manifest never double-renders.
  const pluginNav = allPluginNav.filter(
    (n) => n.pluginId !== 'aokie' || aokieManifestMode,
  );
  // The plugin section (if any) currently selected, resolved to its snapshot.
  const activePluginSection = parsePluginSection(section);
  const activePlugin = activePluginSection
    ? pluginList.find((p) => p.id === activePluginSection.pluginId)
    : undefined;
  useEffect(() => {
    if (section === 'receptionist' && overview.loaded && !aokieInstalled) {
      setSection('overview');
    }
    // A plugin section whose plugin vanished (uninstalled/disabled) → Overview.
    if (
      activePluginSection &&
      overview.loaded &&
      !pluginList.some((p) => p.id === activePluginSection.pluginId && p.ui)
    ) {
      setSection('overview');
    }
    // An aokie plugin section stranded by a mode flip (or the plugin being
    // disabled): the plugin:aokie:* body only renders in manifest mode, so
    // route to the compiled receptionist panel — the exact panel that section
    // deep-linked to anyway — or Overview when Aokie is gone entirely.
    if (
      activePluginSection?.pluginId === 'aokie' &&
      overview.loaded &&
      !aokieManifestMode
    ) {
      setSection(aokieInstalled ? 'receptionist' : 'overview');
    }
  }, [section, overview.loaded, aokieInstalled, aokieManifestMode, activePluginSection, pluginList]);

  const toggleTheme = () => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    applyTheme(next);
  };

  useEffect(() => watchSystemTheme(setThemeState), []);

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
        receptionistAvailable={receptionistAvailable}
        pluginNav={pluginNav}
      />

      <div className="desktop-workspace">
        <header className="desktop-workspace-header">
          <div className="desktop-workspace-header__titles">
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          <div className="desktop-workspace-header__actions">
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
                openExternal('https://formlogic.com');
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

        <main className="desktop-workspace__body">
          {section === 'overview' && (
            <DesktopOverview
              data={overview}
              onOpen={changeSection}
              onOpenPluginNav={(pid, nav) => changeSection(`plugin:${pid}:${nav}`)}
              suppressAokieHero={aokieManifestMode}
            />
          )}
          {/* The panel renders for the 'receptionist' section whenever Aokie is
              installed — even in manifest mode (where only the NAV entry is
              manifest-owned), so a section selected before the mode resolved
              never strands a blank body. */}
          {section === 'receptionist' && (!overview.loaded || aokieInstalled) && <ReceptionistPanel />}
          {section === 'services' && <ServicesPanel />}
          {section === 'models' && <ModelsPanel />}
          {section === 'plugins' && <PluginsPanel />}
          {section === 'python' && <PythonPanel />}
          {section === 'connections' && <ConnectionsPanel />}
          {section === 'settings' && <SettingsPanel />}
          {/* AOK-305: in manifest mode, an Aokie plugin nav opens the COMPILED
              interactive ReceptionistPanel (the manifest supplies the nav entry
              + Overview banner declaratively; the interactive content — pairing,
              live call, consent, dongle wizard — stays compiled). */}
          {activePluginSection?.pluginId === 'aokie' && aokieManifestMode && <ReceptionistPanel />}
          {/* PLG-203: a plugin-contributed screen (declarative status cards +
              actions) for any OTHER plugin. */}
          {activePlugin && activePluginSection && activePluginSection.pluginId !== 'aokie' && (
            <PluginContributedScreen
              plugin={activePlugin}
              navId={activePluginSection.navId}
              devMode={devMode}
            />
          )}
        </main>
      </div>
    </div>
  );
}
