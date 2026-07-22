import type { ReactElement } from 'react';
import {
  DatabaseIcon,
  GearIcon,
  LayoutGridIcon,
  LinkIcon,
  PuzzleIcon,
  ServerIcon,
  ShieldIcon,
  TerminalSquareIcon,
} from './Icons';
import { PluginIcon } from './PluginContributedUi';
import { normalizeIcon, pluginSectionId, type PluginNavEntry } from './pluginContributions';

/** The workspace sections of the redesigned shell (navigation, not tabs). */
export type SectionId =
  | 'overview'
  | 'services'
  | 'models'
  | 'plugins'
  | 'python'
  | 'connections'
  | 'data'
  | 'settings';

export const SECTION_META: Record<SectionId, { title: string; subtitle: string }> = {
  overview: { title: 'Control centre', subtitle: 'Everything local, connected and ready at a glance.' },
  services: { title: 'Service Center', subtitle: 'Find and manage local runtimes, AI APIs and connected agents.' },
  models: { title: 'Models', subtitle: 'Download and organise models available to FormLogic services.' },
  plugins: { title: 'Plugins', subtitle: 'Manage supervised connectors that bridge apps to local capability.' },
  python: { title: 'Python', subtitle: 'A portable runtime and reusable environments for local services.' },
  connections: { title: 'Connections', subtitle: 'Link FormLogic Cloud and manage trusted browser access.' },
  data: { title: 'Data', subtitle: 'Encrypted datasets hosted on this computer — storage, health and backups.' },
  settings: { title: 'Settings', subtitle: 'Storage, folders, tokens and desktop preferences.' },
};

interface NavItem {
  /** A core section id or a plugin section (`plugin:<id>:<navId>`). */
  id: string;
  label: string;
  icon: (props: { size?: number }) => ReactElement;
  badge?: string;
  badgeTone?: 'accent' | 'warn';
}

/**
 * Grouped left navigation for the workspace shell. This is navigation, not an
 * ARIA tab widget: a <nav> with aria-current="page" on the active entry.
 */
export function DesktopSidebar({
  section,
  onChange,
  pendingPairing,
  cloudLabel,
  pluginNav = [],
}: {
  section: string;
  onChange: (s: string) => void;
  /** Pending browser pairing requests — badges the Connections entry. */
  pendingPairing: number;
  /** e.g. the linked device/base host, or "Not linked". */
  cloudLabel: string;
  /** PLG-203: nav entries contributed by installed v2 plugins. */
  pluginNav?: PluginNavEntry[];
}) {
  const groups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: 'Operate',
      items: [
        { id: 'overview', label: 'Overview', icon: LayoutGridIcon },
        { id: 'services', label: 'Service Center', icon: ServerIcon },
        // PLG-203: plugin-contributed nav entries (a v2 plugin's ui.nav).
        ...pluginNav.map(
          (n): NavItem => ({
            id: pluginSectionId(n.pluginId, n.navId),
            label: n.label,
            icon: (props) => <PluginIcon name={normalizeIcon(n.icon)} size={props.size} />,
            badge: n.badge,
            badgeTone: 'accent',
          }),
        ),
      ],
    },
    {
      label: 'Local runtime',
      items: [
        { id: 'models', label: 'Models', icon: DatabaseIcon },
        { id: 'plugins', label: 'Plugins', icon: PuzzleIcon },
        { id: 'python', label: 'Python', icon: TerminalSquareIcon },
      ],
    },
    {
      label: 'Manage',
      items: [
        {
          id: 'connections',
          label: 'Connections',
          icon: LinkIcon,
          badge: pendingPairing > 0 ? String(pendingPairing) : undefined,
          badgeTone: 'warn',
        },
        { id: 'data', label: 'Data', icon: ShieldIcon },
        { id: 'settings', label: 'Settings', icon: GearIcon },
      ],
    },
  ];

  return (
    <aside className="desktop-sidebar">
      <div className="desktop-sidebar__brand">
        <span className="desktop-mark">
          <span className="desktop-mark__tile" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <strong>FormLogic</strong>
        </span>
        <span className="desktop-sidebar__edition">DESKTOP</span>
      </div>

      <nav className="desktop-sidebar__nav" aria-label="Desktop workspaces">
        {groups.map((group) => (
          <div className="desktop-nav-group" key={group.label}>
            <span className="desktop-nav-group__label">{group.label}</span>
            {group.items.map(({ id, label, icon: Icon, badge, badgeTone }) => (
              <button
                type="button"
                key={id}
                aria-current={section === id ? 'page' : undefined}
                className={section === id ? 'is-active' : ''}
                onClick={() => onChange(id)}
                title={label}
              >
                <Icon size={17} />
                <span>{label}</span>
                {badge && <small className={`is-${badgeTone ?? 'accent'}`}>{badge}</small>}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="desktop-sidebar__account" title={cloudLabel}>
        <span className="desktop-sidebar__avatar" aria-hidden="true">
          <CloudGlyph />
        </span>
        <span>
          <strong>FormLogic Cloud</strong>
          <small>{cloudLabel}</small>
        </span>
      </div>
    </aside>
  );
}

function CloudGlyph() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}
