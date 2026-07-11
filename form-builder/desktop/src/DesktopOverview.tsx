import { formatBytes } from './api';
import type { DesktopOverviewData } from './useDesktopOverview';
import type { SectionId } from './DesktopSidebar';
import { SectionCard } from './SectionCard';
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CloudIcon,
  DatabaseIcon,
  LinkIcon,
  PhoneCallIcon,
  PuzzleIcon,
  ServerIcon,
  TerminalSquareIcon,
  WorkflowIcon,
} from './Icons';

/** "6m ago"-style relative time for status footers (empty when unknown). */
function rel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/**
 * The boxed control-centre Overview (redesign 2026-07). Every card maps to a
 * real Desktop API via useDesktopOverview; a failed source degrades its own
 * card to an em-dash instead of blanking the page.
 */
export function DesktopOverview({
  data,
  onOpen,
}: {
  data: DesktopOverviewData;
  onOpen: (s: SectionId) => void;
}) {
  const svc = data.services?.services ?? [];
  const running = svc.filter((s) => s.status === 'running').length;
  const errored = svc.filter((s) => s.status === 'errored').length;
  const stopped = svc.filter((s) => s.status === 'stopped' && s.installed).length;

  const modelCount = data.models?.models.length;
  const modelBytes = data.models?.models.reduce((n, m) => n + m.sizeBytes, 0) ?? 0;
  const activeDownloads = (data.downloads ?? []).filter(
    (d) => d.status === 'active' || d.status === 'queued' || d.status === 'paused'
  );

  const plg = data.plugins?.plugins ?? [];
  const plgRunning = plg.filter((p) => p.state === 'running').length;
  const plgTrouble = plg.filter((p) => p.state === 'unhealthy' || p.state === 'crashed').length;

  const aokie = plg.find((p) => p.id === 'aokie');
  const aokieInstalled = Boolean(aokie);
  const aokieRunning = aokie?.state === 'running';
  const aokieHealthy = aokieRunning && (aokie?.lastHealth?.ok ?? true);

  const runtime = data.runtime;
  const linked = runtime?.linked ?? data.cloud?.linked ?? false;
  const cloudHost = (() => {
    const url = runtime?.baseUrl ?? data.cloud?.baseUrl ?? '';
    try {
      return url ? new URL(url).host : '';
    } catch {
      return url;
    }
  })();

  const pending = data.pendingPairing?.length ?? 0;
  const origins = data.origins?.length ?? 0;

  return (
    <div className="desktop-overview">
      <section className="desktop-welcome-row">
        <div>
          <span>FormLogic Desktop</span>
          <h2>Your local workspace{data.loaded ? (linked ? ' is linked and ready.' : ' is ready.') : '…'}</h2>
        </div>
        <button type="button" onClick={() => onOpen('connections')}>
          <CloudIcon size={15} />
          {linked ? `FormLogic Cloud linked${cloudHost ? ` · ${cloudHost}` : ''}` : 'Link FormLogic Cloud'}
          <ChevronRightIcon size={14} />
        </button>
      </section>

      {/* The receptionist hero is the Aokie PLUGIN's surface — it renders only
          while the plugin is installed (or the first fetch is still loading),
          so removing the plugin removes its chrome too. */}
      {(!data.loaded || aokieInstalled) && (
      <section className="desktop-aokie-card">
        <div className="desktop-aokie-card__accent" aria-hidden="true" />
        <div className="desktop-aokie-card__main">
          <span className="desktop-aokie-card__icon">
            <PhoneCallIcon size={24} />
          </span>
          <div className="desktop-aokie-card__copy">
            <span className="desktop-card-eyebrow">AI RECEPTIONIST</span>
            <h3>
              {!data.loaded
                ? 'Checking Aokie…'
                : !aokieInstalled
                  ? 'Aokie is not installed yet.'
                  : aokieHealthy
                    ? 'Aokie is ready for your next call.'
                    : aokieRunning
                      ? 'Aokie is running with warnings.'
                      : 'Aokie is installed but not running.'}
            </h3>
            <p>
              {!aokieInstalled
                ? 'Install the Aokie phone bridge from Plugins to turn calls into FormLogic records.'
                : aokie?.lastHealth?.detail ||
                  'Answer, transcribe and capture business calls through your paired phone.'}
            </p>
            <div className="desktop-aokie-card__actions">
              <button
                type="button"
                className="desktop-button is-primary"
                onClick={() => onOpen(aokieInstalled ? 'receptionist' : 'plugins')}
              >
                {aokieInstalled ? 'Open Aokie' : 'Open Plugins'} <ChevronRightIcon size={14} />
              </button>
            </div>
          </div>
        </div>
        <div className="desktop-aokie-card__readiness">
          <span className={`desktop-status-pill ${aokieHealthy ? 'is-ok' : aokieRunning ? 'is-warn' : 'is-neutral'}`}>
            <i />
            {aokieHealthy ? 'Ready' : aokieRunning ? 'Degraded' : aokieInstalled ? aokie?.state ?? 'stopped' : 'Not installed'}
          </span>
          <span>
            <PuzzleIcon size={15} />
            <small>Plugin</small>
            <strong>{aokie ? aokie.state : '—'}</strong>
          </span>
          <span>
            <CloudIcon size={15} />
            <small>Cloud</small>
            <strong>{linked ? 'Linked' : 'Not linked'}</strong>
          </span>
        </div>
      </section>
      )}

      <div className="desktop-overview-grid">
        <SectionCard
          icon={<ServerIcon size={17} />}
          tone="blue"
          title="Local services"
          value={data.services ? `${running} running` : '—'}
          detail={
            data.services
              ? errored > 0
                ? `${errored} errored`
                : stopped > 0
                  ? `${stopped} installed, stopped`
                  : 'all installed services up'
              : 'loading…'
          }
          progress={svc.length > 0 ? Math.round((running / svc.length) * 100) : undefined}
          onOpen={() => onOpen('services')}
        />
        <SectionCard
          icon={<DatabaseIcon size={17} />}
          tone="violet"
          title="Model library"
          value={modelCount !== undefined ? `${modelCount} model${modelCount === 1 ? '' : 's'}` : '—'}
          detail={
            activeDownloads.length > 0
              ? `${activeDownloads.length} download${activeDownloads.length === 1 ? '' : 's'} in progress`
              : data.models
                ? `${formatBytes(modelBytes)} on disk · ${formatBytes(data.models.freeBytes)} free`
                : 'loading…'
          }
          onOpen={() => onOpen('models')}
        />
        <SectionCard
          icon={<PuzzleIcon size={17} />}
          tone="green"
          title="Plugins"
          value={data.plugins ? `${plgRunning} running` : '—'}
          detail={
            data.plugins
              ? plgTrouble > 0
                ? `${plgTrouble} unhealthy`
                : plg.length === 0
                  ? 'none installed yet'
                  : 'all checks passed'
              : 'loading…'
          }
          onOpen={() => onOpen('plugins')}
        />
        <SectionCard
          icon={<TerminalSquareIcon size={17} />}
          tone="amber"
          title="Python runtime"
          value={data.python ? (data.python.installed ? 'Installed' : 'Not installed') : '—'}
          detail={
            data.python
              ? data.python.installed
                ? `${data.python.venvs.length} environment${data.python.venvs.length === 1 ? '' : 's'}`
                : 'install from the Python tab'
              : 'loading…'
          }
          onOpen={() => onOpen('python')}
        />
      </div>

      <div className="desktop-overview-bottom">
        <section className="desktop-panel-card">
          <div className="desktop-panel-card__heading">
            <div>
              <small>FORMLOGIC RUNTIME</small>
              <h3>{linked ? 'Linked and working headlessly' : 'Not linked to FormLogic Cloud'}</h3>
            </div>
            <span
              className={`desktop-status-pill ${
                !linked
                  ? 'is-neutral'
                  : runtime && runtime.errors > 0
                    ? 'is-warn'
                    : 'is-ok'
              }`}
            >
              <i />
              {!linked ? 'Offline' : runtime && runtime.errors > 0 ? `${runtime.errors} errors` : 'Healthy'}
            </span>
          </div>
          <div className="desktop-runtime-metrics">
            <span>
              <strong>{runtime ? runtime.runsExecuted : '—'}</strong>
              <small>Flow runs</small>
            </span>
            <span>
              <strong>{runtime ? runtime.recordsWritten : '—'}</strong>
              <small>Records written</small>
            </span>
            <span>
              <strong>{runtime ? rel(runtime.lastEventAt) : '—'}</strong>
              <small>Last event</small>
            </span>
          </div>
          <div className="desktop-runtime-footer">
            <WorkflowIcon size={15} />
            <span>
              {!linked
                ? 'Link an account to run flows headlessly.'
                : runtime?.lastError
                  ? runtime.lastError
                  : runtime?.relayPollOk === false
                    ? 'Remote relay poll failing'
                    : 'Remote relay listening · no errors'}
            </span>
            <button type="button" onClick={() => onOpen('connections')}>
              View
            </button>
          </div>
        </section>

        <section className="desktop-panel-card">
          <div className="desktop-panel-card__heading">
            <div>
              <small>CONNECTIONS</small>
              <h3>Cloud &amp; trusted browsers</h3>
            </div>
            {pending > 0 && (
              <span className="desktop-status-pill is-warn">
                <i />
                {pending} pending
              </span>
            )}
          </div>
          <div className="desktop-connection-list">
            <span>
              <i className={linked ? 'is-ok' : 'is-neutral'}>
                <CloudIcon size={13} />
              </i>
              <div>
                <strong>FormLogic Cloud</strong>
                <small>{linked ? cloudHost || 'linked' : 'not linked'}</small>
              </div>
              {linked && <CircleCheckIcon size={14} className="desktop-ok-glyph" />}
            </span>
            <span>
              <i className={pending > 0 ? 'is-warn' : 'is-neutral'}>
                <LinkIcon size={13} />
              </i>
              <div>
                <strong>Pairing requests</strong>
                <small>{pending > 0 ? `${pending} awaiting review` : 'none pending'}</small>
              </div>
              {pending > 0 && (
                <button type="button" className="desktop-mini-link" onClick={() => onOpen('connections')}>
                  Review
                </button>
              )}
            </span>
            <span>
              <i className="is-neutral">
                <CircleCheckIcon size={13} />
              </i>
              <div>
                <strong>Trusted browsers</strong>
                <small>
                  {data.origins ? `${origins} origin${origins === 1 ? '' : 's'} trusted` : '—'}
                </small>
              </div>
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
