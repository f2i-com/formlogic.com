import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  openInExplorer,
  plugins,
  type BuiltinPluginInfo,
  type PluginSnapshot,
  type PluginState,
  type PluginsListResponse,
} from './api';
import { AlertTriangleIcon, CheckIcon, XIcon } from './Icons';
import LogsViewer from './LogsViewer';
import { AokieCard } from './aokie/AokieCard';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './Toasts';

/**
 * Plugins panel — FormLogic Desktop's plugin host UI. Lists every plugin
 * found under `<dataDir>/plugins/`, with lifecycle state, start/stop/restart,
 * a logs tail, and the visible reason when a plugin is disabled (invalid
 * manifest / version incompatibility) or crashed. Polls /api/plugins every
 * 2s — the list endpoint rescans the folder, so dropping a plugin dir in
 * shows up without a restart.
 *
 * Bundled TEMPLATES (e.g. the Aokie phone bridge) are offered below the
 * installed plugins: Install materialises the manifest into the plugins
 * folder; the plugin then shows "binary … not installed" until the built
 * executable is dropped alongside it. The Aokie plugin additionally gets a
 * live dongle/phone status card (via connector requests) and, in dev mode,
 * a "Simulate incoming call" button (dongle.diagnostics {simulate:"call"}).
 */
export default function PluginsPanel() {
  const [snapshot, setSnapshot] = useState<PluginsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Ids with an action in flight so double-clicks can't double-fire.
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const toast = useToast();
  const { confirm } = useConfirm();
  // Toast on state transitions (crashed / unhealthy / running), not on every
  // poll; the first poll seeds silently.
  const seenStateRef = useRef<Map<string, PluginState>>(new Map());
  const firstPollRef = useRef(true);
  const reqSeqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    try {
      const next = await plugins.list();
      if (seq !== reqSeqRef.current) return; // superseded
      const seen = seenStateRef.current;
      const firstPoll = firstPollRef.current;
      for (const p of next.plugins) {
        const prev = seen.get(p.id);
        if (prev !== p.state && !firstPoll && prev !== undefined) {
          if (p.state === 'crashed') {
            toast.push({
              kind: 'error',
              title: `Plugin "${p.name}" crashed`,
              body: p.reason ?? undefined,
              timeoutMs: 8000,
            });
          } else if (p.state === 'unhealthy') {
            toast.push({
              kind: 'error',
              title: `Plugin "${p.name}" is unhealthy`,
              body: 'Health probes are being missed; the process is still running.',
              timeoutMs: 8000,
            });
          } else if (p.state === 'running' && prev !== 'running') {
            toast.push({ kind: 'success', title: `Plugin "${p.name}" is running` });
          }
        }
        seen.set(p.id, p.state);
      }
      firstPollRef.current = false;
      setSnapshot(next);
      setError(null);
    } catch (e) {
      if (seq !== reqSeqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const runAction = useCallback(
    async (fn: () => Promise<void>, key: string) => {
      setActionError(null);
      setPendingIds((p) => new Set(p).add(key));
      try {
        await fn();
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingIds((p) => {
          const n = new Set(p);
          n.delete(key);
          return n;
        });
      }
    },
    [refresh],
  );

  return (
    <div className="panel">
      {error && (
        <div className="banner banner-err">
          Couldn't reach the FormLogic Desktop API: {error}
        </div>
      )}
      {actionError && (
        <div className="banner banner-err banner-dismissable">
          <span>
            <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
            {actionError}
          </span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss error"
            onClick={() => setActionError(null)}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
      {snapshot && (
        <div className="datadir-note">
          Plugins live under <code>{snapshot.pluginsDir}</code>.{' '}
          <button
            className="btn-tiny"
            onClick={() =>
              openInExplorer(snapshot.pluginsDir).catch((e) =>
                setActionError(e instanceof Error ? e.message : String(e)),
              )
            }
            title="Open plugins folder in file explorer"
          >
            open
          </button>{' '}
          Each plugin is a folder with a <code>manifest.json</code> and an
          executable, supervised by FormLogic Desktop and reachable from
          FormLogic apps through connectors. Drop a plugin folder in and it
          appears here — see <code>plugin-template/</code> in the repo for a
          minimal example.
        </div>
      )}
      {snapshot && snapshot.plugins.length === 0 && !error && (
        <div className="empty-state">
          No plugins installed yet. Copy a plugin folder (with its{' '}
          <code>manifest.json</code>) into the plugins directory above to
          register one.
        </div>
      )}
      {!snapshot && !error && <div className="empty-state">Loading plugins…</div>}

      <section className="service-section">
        {snapshot?.plugins.map((p) => (
          <PluginCard
            key={p.id}
            plugin={p}
            devMode={snapshot.devMode}
            expanded={expandedId === p.id}
            pending={pendingIds.has(p.id)}
            onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
            onStart={() => runAction(() => plugins.start(p.id), p.id)}
            onStop={() => runAction(() => plugins.stop(p.id), p.id)}
            onRestart={() => runAction(() => plugins.restart(p.id), p.id)}
            onRemove={async () => {
              const ok = await confirm({
                title: `Remove the ${p.name} plugin?`,
                body:
                  'The plugin is stopped and its folder (manifest + binary) is deleted. ' +
                  'Its data (settings, journals) is kept, so reinstalling picks up where it left off.' +
                  (snapshot.builtins.some((b) => b.id === p.id)
                    ? ' It stays available to reinstall under "Built-in plugins".'
                    : ''),
                confirmLabel: 'Remove plugin',
                danger: true,
              });
              if (!ok) return;
              await runAction(async () => {
                await plugins.uninstall(p.id);
                toast.push({ kind: 'success', title: `Plugin "${p.name}" removed` });
              }, p.id);
            }}
          />
        ))}
      </section>

      {(snapshot?.builtins ?? []).some((b) => !b.installed) && (
        <section className="service-section builtin-section">
          <h2 className="section-title">Built-in plugins</h2>
          {snapshot?.builtins
            .filter((b) => !b.installed)
            .map((b) => (
              <BuiltinCard
                key={b.id}
                builtin={b}
                pending={pendingIds.has(`install:${b.id}`)}
                onInstall={() =>
                  runAction(async () => {
                    await plugins.installBuiltin(b.id);
                    toast.push({
                      kind: 'success',
                      title: `Plugin "${b.name}" installed`,
                      body: 'Build its binary and place it in the plugin folder to start it.',
                      timeoutMs: 8000,
                    });
                  }, `install:${b.id}`)
                }
              />
            ))}
        </section>
      )}
    </div>
  );
}

/** One bundled, not-yet-installed template with its Install action. */
function BuiltinCard({
  builtin,
  pending,
  onInstall,
}: {
  builtin: BuiltinPluginInfo;
  pending: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="service-card">
      <div className="service-row">
        <div className="service-info">
          <div className="service-name">
            {builtin.name}
            <span className="badge badge-neutral">v{builtin.version}</span>
            <span className="badge badge-neutral">bundled</span>
          </div>
          {builtin.description && (
            <div className="service-desc" title={builtin.description}>
              {builtin.description}
            </div>
          )}
          <div className="service-meta">
            Installing writes the plugin's <code>manifest.json</code> into the
            plugins folder; build the plugin binary separately and drop it in
            the same folder.
          </div>
          {builtin.incompatible && (
            <div className="service-error">
              <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
              {builtin.incompatible}
            </div>
          )}
        </div>
        <div className="service-actions">
          <button
            onClick={onInstall}
            disabled={pending || !!builtin.incompatible}
            className="btn btn-primary"
          >
            Install {builtin.id === 'aokie' ? 'Aokie' : builtin.name} plugin
          </button>
        </div>
      </div>
    </div>
  );
}

interface CardProps {
  plugin: PluginSnapshot;
  devMode: boolean;
  expanded: boolean;
  pending: boolean;
  onToggle: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRemove: () => void;
}

function PluginCard({
  plugin,
  devMode,
  expanded,
  pending,
  onToggle,
  onStart,
  onStop,
  onRestart,
  onRemove,
}: CardProps) {
  const loadLogs = useMemo(
    () => () => plugins.logs(plugin.id, 200),
    [plugin.id],
  );
  const active =
    plugin.state === 'running' ||
    plugin.state === 'starting' ||
    plugin.state === 'unhealthy';
  const startable =
    plugin.state === 'installed' ||
    plugin.state === 'stopped' ||
    plugin.state === 'crashed';

  return (
    <div className={`service-card service-card-${plugin.state}`}>
      <div className="service-row">
        <div className="service-info">
          <div className="service-name">
            {plugin.name}
            <StateBadge state={plugin.state} />
            {plugin.version && (
              <span className="badge badge-neutral">v{plugin.version}</span>
            )}
          </div>
          {plugin.description && (
            <div className="service-desc" title={plugin.description}>
              {plugin.description}
            </div>
          )}
          <div className="service-meta">
            {plugin.connectors.length > 0 && (
              <>
                connectors:{' '}
                {plugin.connectors
                  .map((c) => `${c.id} (${c.commands.length} cmd)`)
                  .join(', ')}
              </>
            )}
            {plugin.events.length > 0 && <> · {plugin.events.length} event type(s)</>}
            {plugin.pid != null && <> · pid {plugin.pid}</>}
            {plugin.startedAt && (
              <> · started {new Date(plugin.startedAt).toLocaleTimeString()}</>
            )}
            {plugin.restartAttempts > 0 && (
              <> · auto-restarted x{plugin.restartAttempts}</>
            )}
          </div>
          {plugin.lastHealth && active && (
            <div className="service-meta">
              health:{' '}
              {plugin.lastHealth.ok ? (
                <CheckIcon className="inline-icon icon-leading" size={13} />
              ) : (
                <AlertTriangleIcon className="inline-icon icon-leading" size={13} />
              )}
              {plugin.lastHealth.status}
              {plugin.lastHealth.detail ? ` — ${plugin.lastHealth.detail}` : ''}
              {' · '}
              {new Date(plugin.lastHealth.at).toLocaleTimeString()}
            </div>
          )}
          {plugin.reason && (
            <div className="service-error">
              <AlertTriangleIcon className="inline-icon icon-leading" size={14} />
              {plugin.reason}
              {plugin.state === 'disabled' && plugin.minDesktopVersion && (
                <> (requires Desktop ≥ {plugin.minDesktopVersion})</>
              )}
            </div>
          )}
        </div>
        <div className="service-actions">
          {active ? (
            <>
              <button onClick={onStop} disabled={pending} className="btn btn-warn">
                Stop
              </button>
              <button
                onClick={onRestart}
                disabled={pending}
                className="btn btn-secondary"
              >
                Restart
              </button>
            </>
          ) : startable ? (
            <button onClick={onStart} disabled={pending} className="btn btn-primary">
              {plugin.state === 'crashed' ? 'Start again' : 'Start'}
            </button>
          ) : null}
          <button onClick={onToggle} className="btn btn-ghost">
            {expanded ? 'Hide logs' : 'Logs'}
          </button>
          {!active && (
            <button onClick={onRemove} disabled={pending} className="btn btn-danger">
              Remove
            </button>
          )}
        </div>
      </div>
      {plugin.id === 'aokie' && (
        <AokieCard running={plugin.state === 'running'} devMode={devMode} />
      )}
      {expanded && (
        <LogsViewer
          load={loadLogs}
          title={`${plugin.name} · logs`}
          onClose={onToggle}
        />
      )}
    </div>
  );
}


function StateBadge({ state }: { state: PluginState }) {
  const cls =
    state === 'running'
      ? 'badge-ok'
      : state === 'crashed' || state === 'unhealthy'
        ? 'badge-err'
        : state === 'starting'
          ? 'badge-pending'
          : 'badge-neutral';
  return <span className={`badge ${cls}`}>{state}</span>;
}
