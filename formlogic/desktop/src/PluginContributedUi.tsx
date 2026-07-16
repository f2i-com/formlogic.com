import { useEffect, useState, type ReactElement } from 'react';
import { plugins, type PluginSnapshot, type PluginUiContributions } from './api';
import {
  clampPollMs,
  displayValue,
  normalizeIcon,
  resolvePath,
  snapshotBindingSource,
  type PluginIconName,
} from './pluginContributions';
import {
  DatabaseIcon,
  GearIcon,
  LayoutGridIcon,
  LinkIcon,
  PhoneCallIcon,
  PuzzleIcon,
  ServerIcon,
  TerminalSquareIcon,
} from './Icons';
import { useConfirm } from './ConfirmDialog';
import { useToast } from './Toasts';

/**
 * PLG-203 — generic renderers for a plugin's declarative UI contributions.
 * A v2 plugin's manifest `ui` section (nav / overview cards / status cards /
 * actions) is rendered here entirely from DATA — no plugin code runs in the
 * host. Status cards poll a declared connector command; action buttons run a
 * declared command (with optional host confirm). This is what makes a plugin's
 * side-menu link + Overview banner appear dynamically.
 */

/** Allow-listed plugin icon name → an Icon component. */
export function PluginIcon({ name, size = 17 }: { name: PluginIconName; size?: number }) {
  const map: Record<PluginIconName, (p: { size?: number }) => ReactElement> = {
    phone: PhoneCallIcon,
    plug: PuzzleIcon,
    server: ServerIcon,
    database: DatabaseIcon,
    gear: GearIcon,
    link: LinkIcon,
    grid: LayoutGridIcon,
    terminal: TerminalSquareIcon,
    puzzle: PuzzleIcon,
  };
  const Cmp = map[name] ?? PuzzleIcon;
  return <Cmp size={size} />;
}

/**
 * The plugin's contributed SCREEN — opened from a plugin nav entry. Renders the
 * plugin's declared status cards + action buttons. (Tier-2 sandboxed HTML
 * screens are deferred; the declarative surface covers the common case.)
 */
export function PluginContributedScreen({
  plugin,
  navId,
  devMode,
}: {
  plugin: PluginSnapshot;
  navId: string;
  devMode: boolean;
}) {
  const ui = plugin.ui;
  const running = plugin.state === 'running' || plugin.state === 'starting' || plugin.state === 'unhealthy';
  return (
    <div className="panel">
      <div className="datadir-note">
        Contributed by the <strong>{plugin.name}</strong> plugin ({navId}).
        {!running && ' Start the plugin to see live data.'}
      </div>
      {(ui?.statusCards ?? []).map((card) => (
        <StatusCard key={card.id} pluginId={plugin.id} card={card} enabled={running} />
      ))}
      {(ui?.actions ?? []).filter((a) => !a.devOnly || devMode).length > 0 && (
        <section className="service-section">
          <h3 className="section-title">Actions</h3>
          <div className="plugin-action-row">
            {(ui?.actions ?? [])
              .filter((a) => !a.devOnly || devMode)
              .map((a) => (
                <ActionButton key={a.id} pluginId={plugin.id} action={a} enabled={running} />
              ))}
          </div>
        </section>
      )}
      {(!ui?.statusCards?.length && !ui?.actions?.length) && (
        <div className="empty-state">This plugin contributes a nav entry but no cards or actions yet.</div>
      )}
    </div>
  );
}

/** A status card: polls a declared command and shows mapped fields. */
function StatusCard({
  pluginId,
  card,
  enabled,
}: {
  pluginId: string;
  card: NonNullable<PluginUiContributions['statusCards']>[number];
  enabled: boolean;
}) {
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const res = await plugins.command(pluginId, card.poll.command);
        if (alive) {
          setData((res as { data?: unknown }).data ?? null);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    const id = window.setInterval(poll, clampPollMs(card.poll.intervalMs));
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pluginId, card.poll.command, card.poll.intervalMs, enabled]);

  return (
    <section className="service-section">
      <div className="service-card">
        <div className="service-name">{card.title}</div>
        {error ? (
          <div className="service-error">{error}</div>
        ) : (
          <dl className="plugin-status-fields">
            {card.fields.map((f) => (
              <div key={f.label} className="plugin-status-field">
                <dt>{f.label}</dt>
                <dd>{enabled ? displayValue(resolvePath(data, f.path)) : '—'}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

/** A declared action button — runs a command, with an optional host confirm. */
function ActionButton({
  pluginId,
  action,
  enabled,
}: {
  pluginId: string;
  action: NonNullable<PluginUiContributions['actions']>[number];
  enabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { confirm } = useConfirm();
  return (
    <button
      className="btn btn-secondary"
      disabled={busy || !enabled}
      onClick={async () => {
        if (action.confirm) {
          const ok = await confirm({ title: action.label, body: action.confirm, confirmLabel: action.label });
          if (!ok) return;
        }
        setBusy(true);
        try {
          await plugins.command(pluginId, action.command);
          toast.push({ kind: 'success', title: `${action.label} sent` });
        } catch (e) {
          toast.push({ kind: 'error', title: `${action.label} failed`, body: e instanceof Error ? e.message : String(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '…' : action.label}
    </button>
  );
}

/**
 * Plugin-contributed OVERVIEW cards. Rendered on the Overview between the core
 * cards. `onOpenNav` opens the plugin section a card's CTA deep-links to.
 */
export function PluginOverviewCards({
  plugins: list,
  onOpenNav,
}: {
  plugins: PluginSnapshot[];
  onOpenNav: (pluginId: string, navId: string) => void;
}) {
  const cards: { plugin: PluginSnapshot; card: NonNullable<PluginUiContributions['overview']>[number] }[] = [];
  for (const p of list) {
    if (p.state === 'disabled') continue;
    for (const c of p.ui?.overview ?? []) cards.push({ plugin: p, card: c });
  }
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map(({ plugin, card }) => {
        const src = snapshotBindingSource(plugin);
        const headline = card.bind?.headline ? displayValue(resolvePath(src, card.bind.headline)) : undefined;
        const body = card.bind?.body ? displayValue(resolvePath(src, card.bind.body)) : undefined;
        const hero = card.kind === 'hero';
        return (
          <section
            key={`${plugin.id}:${card.id}`}
            className={`desktop-panel-card plugin-overview-card${hero ? ' plugin-overview-card--hero' : ''}`}
          >
            <div className="plugin-overview-card__head">
              <PluginIcon name={normalizeIcon(card.icon)} size={hero ? 20 : 16} />
              <h3>{card.title}</h3>
            </div>
            {headline && <p className="plugin-overview-card__headline">{headline}</p>}
            {body && <p className="plugin-overview-card__body">{body}</p>}
            {card.bind?.cta && (
              <button
                className="btn btn-primary"
                onClick={() => onOpenNav(plugin.id, card.bind!.cta!.nav)}
              >
                {card.bind.cta.label}
              </button>
            )}
          </section>
        );
      })}
    </>
  );
}
