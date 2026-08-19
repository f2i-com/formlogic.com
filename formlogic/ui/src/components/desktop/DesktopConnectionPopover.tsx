// Global "Desktop connection" popover (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.3 +
// Phase 3): one header-level control for every signed-in user that shows the desktop
// presence tri-state, drives Services/Plugins lifecycle, and quick-switches the AI
// source.
//
// Presence → transport:
//   'local'  — a paired FormLogic Desktop on THIS machine → loopback desktopClient calls.
//   'remote' — a fresh linked-desktop heartbeat, no local bridge → the account-scoped
//              ops relay (POST/GET /api/desktop/ops) via desktopOps.ts.
//   'none'   — no linked desktop → connect CTA deep-linking Settings → Linked Desktops.
//   demo     — the shared demo account: an honest "demo bridge" state; the demo NEVER
//              touches a real desktop (audit rule: demo stays read-only/simulated).
//
// Outcome honesty: relay outcomes render per commandRelay semantics — a claimed-but-
// unreported action says "outcome uncertain", never a fake failure (see desktopOps.ts).
// The pure view-model helpers live in ./desktopConnection.ts (components-only export here).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Link2, Loader2, Monitor, Play, RotateCcw, Sparkles, Square, Wrench } from 'lucide-react';
import { Popover } from '../ui/Popover';
import { desktopClient, type DesktopServiceSnapshot } from '../../client-runtime/desktop/desktopClient';
import type { DesktopPluginSummary } from '../../client-runtime/desktop/desktopTypes';
import { runDesktopOp } from '../../client-runtime/desktop/desktopOps';
import { useFlowsDesktopPresence } from '../flows/useFlowsDesktopPresence';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import { useUIStore } from '../../stores/uiStore';
import { pathClaimsBottomEdge } from '../../lib/bottomEdgeClaim';
import { cn } from '../../lib/utils';
import {
  AI_SOURCE_OPTIONS,
  aiPreferencesApi,
  connectionDotClass,
  deriveConnectionView,
  describeClientResult,
  describeOpOutcome,
  extractListResult,
  pluginOpName,
  serviceOpName,
  type AiPreferences,
  type AiSource,
  type DesktopConnectionKind,
  type OpFeedback,
  type PluginAction,
  type ServiceAction,
} from './desktopConnection';

interface LoadedLists {
  services: DesktopServiceSnapshot[] | null;
  plugins: DesktopPluginSummary[] | null;
  error: string | null;
}

const ACTION_BUTTON_CLASS = cn(
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium',
  'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white',
  'disabled:cursor-not-allowed disabled:opacity-40'
);

function ActionButton({
  label,
  title,
  busy,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled || busy}
      onClick={onClick}
      className={ACTION_BUTTON_CLASS}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
      <span>{label}</span>
    </button>
  );
}

export function DesktopConnectionPopover() {
  const user = useAuthStore((s) => s.user);
  const isDemo = !!user?.isDemo;
  const presence = useFlowsDesktopPresence();
  const view = deriveConnectionView(presence, isDemo);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const isMobile = useUIStore((s) => s.isMobile);
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [lists, setLists] = useState<LoadedLists>({ services: null, plugins: null, error: null });
  const [listsLoading, setListsLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<OpFeedback | null>(null);
  const [aiPrefs, setAiPrefs] = useState<AiPreferences | null>(null);
  const [aiPrefsReady, setAiPrefsReady] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);

  const transport = view.kind === 'local' ? 'local' : 'relay';

  const loadLists = useCallback(async (kind: DesktopConnectionKind) => {
    if (kind !== 'local' && kind !== 'remote') return;
    setListsLoading(true);
    try {
      if (kind === 'local') {
        const [svc, plg] = await Promise.all([desktopClient.services.list(), desktopClient.plugins.list()]);
        setLists({
          services: svc.ok ? svc.data : null,
          plugins: plg.ok ? plg.data : null,
          error: !svc.ok || !plg.ok ? (!svc.ok ? svc.error : (plg as { error: { message: string } }).error).message : null,
        });
      } else {
        const [svc, plg] = await Promise.all([
          runDesktopOp({ op: 'desktop.services.list' }),
          runDesktopOp({ op: 'desktop.plugins.list' }),
        ]);
        const services = svc.ok && svc.outcome.status === 'done' ? extractListResult<DesktopServiceSnapshot>(svc.outcome.result, 'services') : null;
        const plugins = plg.ok && plg.outcome.status === 'done' ? extractListResult<DesktopPluginSummary>(plg.outcome.result, 'plugins') : null;
        const failed = !svc.ok ? svc.error.message
          : svc.outcome.status !== 'done' ? describeOpOutcome('Listing services', svc.outcome).text
          : !plg.ok ? plg.error.message
          : plg.outcome.status !== 'done' ? describeOpOutcome('Listing plugins', plg.outcome).text
          : null;
        setLists({ services, plugins, error: services === null && plugins === null ? failed : null });
      }
    } finally {
      setListsLoading(false);
    }
  }, []);

  // Load (and reload per transport switch) the service/plugin lists while open.
  useEffect(() => {
    if (!open) return;
    void loadLists(view.kind);
  }, [open, view.kind, loadLists]);

  // AI-source preferences — only when the Wave-2 api methods exist (else hidden).
  useEffect(() => {
    if (!open || isDemo) return;
    const prefsApi = aiPreferencesApi();
    if (!prefsApi) {
      setAiPrefsReady(false);
      return;
    }
    void (async () => {
      const res = await prefsApi.getAiPreferences();
      // The preferences route itself may not have landed yet — degrade to hidden.
      setAiPrefsReady(false);
      if (res.data) {
        setAiPrefs(res.data);
        setAiPrefsReady(true);
      }
    })();
  }, [open, isDemo]);

  if (!user) return null;

  const publish = (feedback: OpFeedback) => {
    setNotice(feedback);
    addToast({
      type: feedback.tone === 'success' ? 'success' : feedback.tone === 'warning' ? 'warning' : 'error',
      title: feedback.text,
    });
  };

  const runAction = async (key: string, _label: string, action: () => Promise<OpFeedback>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setNotice(null);
    try {
      publish(await action());
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
      void loadLists(view.kind);
    }
  };

  const serviceAction = (id: string, action: ServiceAction) => {
    const label = `${action} ${id}`;
    void runAction(`svc:${id}`, label, async () => {
      if (transport === 'local') {
        return describeClientResult(label, await desktopClient.services[action](id));
      }
      const res = await runDesktopOp({ op: serviceOpName(action), serviceId: id });
      return res.ok ? describeOpOutcome(label, res.outcome) : { tone: 'error' as const, text: `${label} failed: ${res.error.message}` };
    });
  };

  const pluginAction = (id: string, action: PluginAction) => {
    const label = `${action} ${id}`;
    void runAction(`plg:${id}`, label, async () => {
      if (transport === 'local') {
        return describeClientResult(label, await desktopClient.plugins[action](id));
      }
      const res = await runDesktopOp({ op: pluginOpName(action), pluginId: id });
      return res.ok ? describeOpOutcome(label, res.outcome) : { tone: 'error' as const, text: `${label} failed: ${res.error.message}` };
    });
  };

  const selectAiSource = async (source: AiSource) => {
    const prefsApi = aiPreferencesApi();
    if (!prefsApi || !aiPrefs || aiSaving || source === aiPrefs.aiSource) return;
    setAiSaving(true);
    try {
      const res = await prefsApi.putAiPreferences({ ...aiPrefs, aiSource: source });
      if (res.data) {
        setAiPrefs(res.data);
        addToast({ type: 'success', title: `AI source set to ${source === 'site' ? 'Site AI' : source === 'desktop' ? 'Desktop AI' : 'Custom'}.` });
      } else {
        addToast({ type: 'error', title: 'AI source could not be saved.', message: res.error });
      }
    } finally {
      setAiSaving(false);
    }
  };

  const showControls = view.kind === 'local' || view.kind === 'remote';

  // Inside the App Studio a phone's bottom edge belongs to the section's own
  // content and the global nav. This chip is not essential there — Desktop status
  // stays available on Flows and in Settings.
  if (isMobile && pathClaimsBottomEdge(location.pathname)) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Desktop connection: ${view.label}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'fixed z-40 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur',
          'border-gray-200 bg-white/95 text-gray-700 transition-colors hover:bg-gray-50',
          'dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-200 dark:hover:bg-slate-800',
          isMobile
            ? 'left-4 bottom-[var(--fl-mobile-float)]'
            : cn('bottom-4', sidebarCollapsed ? 'left-[4.75rem]' : 'left-[16.75rem]')
        )}
      >
        <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', connectionDotClass(view.kind))} aria-hidden="true" />
        <Monitor className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <span className="max-w-[10rem] truncate">{view.label}</span>
      </button>

      <Popover
        isOpen={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="top-start"
        ariaLabel="Desktop connection"
        className="w-80 sm:w-96"
      >
        <div className="space-y-4 p-4">
          <div className="flex items-start gap-2.5">
            <span className={cn('mt-1.5 h-2 w-2 flex-shrink-0 rounded-full', connectionDotClass(view.kind))} aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-white">{view.label}</h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">{view.detail}</p>
            </div>
          </div>

          {notice && (
            <div
              role="status"
              className={cn(
                'rounded-lg border px-3 py-2 text-xs',
                notice.tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
                notice.tone === 'warning' && 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
                notice.tone === 'error' && 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
              )}
            >
              {notice.text}
            </div>
          )}

          {view.kind === 'none' && (
            <div className="rounded-xl border border-dashed border-gray-300 p-3 text-center dark:border-slate-700">
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Services, plugins and Desktop AI run in the free FormLogic Desktop app.
              </p>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate('/settings#linked-desktops');
                }}
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-700"
              >
                <Link2 className="h-3.5 w-3.5" />
                Link a desktop
              </button>
            </div>
          )}

          {view.kind === 'demo' && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              Demo bridge — hardware is simulated. Create an account to connect a real desktop.
            </p>
          )}

          {showControls && (
            <>
              <section aria-label="Services">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Services</h3>
                <div className="mt-1.5 space-y-1">
                  {listsLoading && lists.services === null && (
                    <p className="flex items-center gap-2 px-1 py-1.5 text-xs text-gray-400 dark:text-slate-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading services…
                    </p>
                  )}
                  {!listsLoading && lists.services === null && (
                    <p className="px-1 py-1.5 text-xs text-gray-400 dark:text-slate-500">
                      {lists.error ?? 'Services are unavailable right now.'}
                    </p>
                  )}
                  {lists.services !== null && lists.services.length === 0 && (
                    <p className="px-1 py-1.5 text-xs text-gray-400 dark:text-slate-500">No services installed.</p>
                  )}
                  {lists.services?.map((service) => {
                    const running = service.status === 'running';
                    const rowBusy = !!busy[`svc:${service.id}`];
                    return (
                      <div key={service.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-gray-800 dark:text-slate-200">
                            {service.name ?? service.id}
                          </span>
                          <span className="block text-[11px] text-gray-400 dark:text-slate-500">{service.status}</span>
                        </div>
                        {!running && (
                          <ActionButton label="Start" title={`Start ${service.id}`} busy={rowBusy} onClick={() => serviceAction(service.id, 'start')}>
                            <Play className="h-3.5 w-3.5" />
                          </ActionButton>
                        )}
                        {running && (
                          <>
                            <ActionButton label="Stop" title={`Stop ${service.id}`} busy={rowBusy} onClick={() => serviceAction(service.id, 'stop')}>
                              <Square className="h-3.5 w-3.5" />
                            </ActionButton>
                            <ActionButton label="Restart" title={`Restart ${service.id}`} busy={rowBusy} onClick={() => serviceAction(service.id, 'restart')}>
                              <RotateCcw className="h-3.5 w-3.5" />
                            </ActionButton>
                          </>
                        )}
                        <ActionButton label="Repair" title={`Repair ${service.id}`} busy={rowBusy} onClick={() => serviceAction(service.id, 'repair')}>
                          <Wrench className="h-3.5 w-3.5" />
                        </ActionButton>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section aria-label="Plugins">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Plugins</h3>
                <div className="mt-1.5 space-y-1">
                  {listsLoading && lists.plugins === null && (
                    <p className="flex items-center gap-2 px-1 py-1.5 text-xs text-gray-400 dark:text-slate-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading plugins…
                    </p>
                  )}
                  {!listsLoading && lists.plugins === null && (
                    <p className="px-1 py-1.5 text-xs text-gray-400 dark:text-slate-500">
                      {lists.error ?? 'Plugins are unavailable right now.'}
                    </p>
                  )}
                  {lists.plugins !== null && lists.plugins.length === 0 && (
                    <p className="px-1 py-1.5 text-xs text-gray-400 dark:text-slate-500">No plugins installed.</p>
                  )}
                  {lists.plugins?.map((plugin) => {
                    const running = plugin.state === 'running';
                    const rowBusy = !!busy[`plg:${plugin.id}`];
                    return (
                      <div key={plugin.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-gray-800 dark:text-slate-200">
                            {plugin.name ?? plugin.id}
                          </span>
                          <span className="block text-[11px] text-gray-400 dark:text-slate-500">{plugin.state}</span>
                        </div>
                        {!running && (
                          <ActionButton label="Start" title={`Start ${plugin.id}`} busy={rowBusy} onClick={() => pluginAction(plugin.id, 'start')}>
                            <Play className="h-3.5 w-3.5" />
                          </ActionButton>
                        )}
                        {running && (
                          <>
                            <ActionButton label="Stop" title={`Stop ${plugin.id}`} busy={rowBusy} onClick={() => pluginAction(plugin.id, 'stop')}>
                              <Square className="h-3.5 w-3.5" />
                            </ActionButton>
                            <ActionButton label="Restart" title={`Restart ${plugin.id}`} busy={rowBusy} onClick={() => pluginAction(plugin.id, 'restart')}>
                              <RotateCcw className="h-3.5 w-3.5" />
                            </ActionButton>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}

          {aiPrefsReady && aiPrefs && !isDemo && (
            <section aria-label="AI source">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">
                <Sparkles className="h-3.5 w-3.5" /> AI source
              </h3>
              <div className="mt-1.5 space-y-1" role="radiogroup" aria-label="AI source">
                {AI_SOURCE_OPTIONS.map((option) => {
                  const selected = (aiPrefs.aiSource ?? 'site') === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={aiSaving}
                      onClick={() => void selectAiSource(option.value)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                        selected
                          ? 'border-primary-300 bg-primary-50 dark:border-primary-500/40 dark:bg-primary-500/10'
                          : 'border-gray-200 hover:bg-gray-50 dark:border-slate-700 dark:hover:bg-slate-800'
                      )}
                    >
                      <span
                        className={cn(
                          'h-2.5 w-2.5 flex-shrink-0 rounded-full border-2',
                          selected ? 'border-primary-500 bg-primary-500' : 'border-gray-300 dark:border-slate-600'
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium text-gray-800 dark:text-slate-200">{option.label}</span>
                        <span className="block text-[11px] text-gray-400 dark:text-slate-500">{option.hint}</span>
                      </span>
                      {aiSaving && selected && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </Popover>
    </>
  );
}
