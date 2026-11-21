import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, Play, Plus, Puzzle, ShieldCheck, Store, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { api, type AppPluginAttachment, type MemberPlugin } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { deferEffect } from '../../lib/deferredEffect';

interface AppPluginsPanelProps {
  appId: string;
  hasNativeDatabase?: boolean;
  readOnly?: boolean;
}

export function AppPluginsPanel({ appId, hasNativeDatabase = false, readOnly = false }: AppPluginsPanelProps) {
  const [attached, setAttached] = useState<AppPluginAttachment[]>([]);
  const [installed, setInstalled] = useState<MemberPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPluginId, setSelectedPluginId] = useState('');
  const [shareDbOnAttach, setShareDbOnAttach] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ pluginId: string; output: string } | null>(null);

  const load = useCallback(async () => {
    if (typeof api.listAppPlugins !== 'function') {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.listAppPlugins(appId);
      if (res.data) {
        setAttached(Array.isArray(res.data.plugins) ? res.data.plugins : []);
        setInstalled(Array.isArray(res.data.installedPlugins) ? res.data.installedPlugins : []);
      }
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => deferEffect(() => { void load(); }), [load]);

  const unattached = installed.filter(
    (p) => !attached.some((a) => a.memberPluginId === p.id)
  );

  const handleAttach = async () => {
    const target = selectedPluginId || unattached[0]?.id;
    if (!target || readOnly) return;
    setBusyId('attach');
    try {
      const res = await api.attachAppPlugin(appId, {
        memberPluginId: target,
        enabled: true,
        shareDatabase: hasNativeDatabase && shareDbOnAttach,
      });
      if (res.error) {
        toast.error('Could not attach plugin', res.error);
        return;
      }
      toast.success('Plugin attached to app');
      setSelectedPluginId('');
      setShareDbOnAttach(false);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (att: AppPluginAttachment, patch: { enabled?: boolean; shareDatabase?: boolean }) => {
    if (readOnly) return;
    setBusyId(att.memberPluginId);
    try {
      const res = await api.updateAppPlugin(appId, att.memberPluginId, patch);
      if (res.error) {
        toast.error('Could not update plugin', res.error);
        return;
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleDetach = async (att: AppPluginAttachment) => {
    if (readOnly) return;
    setBusyId(att.memberPluginId);
    try {
      const res = await api.detachAppPlugin(appId, att.memberPluginId);
      if (res.error) {
        toast.error('Could not detach plugin', res.error);
        return;
      }
      toast.success('Plugin detached');
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleInvokeRoute = async (att: AppPluginAttachment, route: { method: string; path: string }) => {
    setBusyId(`run:${att.memberPluginId}`);
    try {
      const method = route.method === 'ANY' ? 'GET' : route.method;
      const res = await api.invokeMemberPlugin(att.memberPluginId, {
        method,
        path: route.path,
        appId,
      });
      setTestResult({
        pluginId: att.memberPluginId,
        output: JSON.stringify(res.error ? { error: res.error } : res.data, null, 2),
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Puzzle className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Modular Plugins</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Attach installed SoftN plugins to extend this app{hasNativeDatabase ? ' — optionally sharing this app’s SQLite database.' : '.'}
            </p>
          </div>
        </div>
        <Link
          to="/packs?type=plugin"
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-primary-300 bg-primary-50 px-4 text-sm font-semibold text-primary-700 transition hover:bg-primary-100 dark:border-primary-500/40 dark:bg-primary-500/15 dark:text-primary-200 dark:hover:bg-primary-500/25"
        >
          <Store className="h-4 w-4" />
          Browse Marketplace Plugins
        </Link>
      </div>

      {/* Attach installed plugin box */}
      {!readOnly && unattached.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-900/60">
          <p className="mb-2.5 text-sm font-semibold text-slate-900 dark:text-white">Attach an installed plugin</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <select
              value={selectedPluginId || unattached[0]?.id || ''}
              onChange={(e) => setSelectedPluginId(e.target.value)}
              className="h-11 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              {unattached.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (v{p.version}){p.sourceProtected ? ' · Source Protected' : ''}
                </option>
              ))}
            </select>
            {hasNativeDatabase && (
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={shareDbOnAttach}
                  onChange={(e) => setShareDbOnAttach(e.target.checked)}
                  className="h-4 w-4 accent-primary-600"
                />
                Share app SQLite DB
              </label>
            )}
            <Button
              variant="primary"
              onClick={() => void handleAttach()}
              isLoading={busyId === 'attach'}
              leftIcon={<Plus className="h-4 w-4" />}
            >
              Attach Plugin
            </Button>
          </div>
        </div>
      )}

      {/* Attached plugins list */}
      {loading ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading plugins…</p>
      ) : attached.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900">
          <Puzzle className="mx-auto mb-3 h-8 w-8 text-slate-400" />
          <p className="font-semibold text-slate-900 dark:text-white">No plugins attached to this app yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
            {installed.length > 0
              ? 'Select one of your installed plugins above to attach it to this app.'
              : 'Install modular SoftN plugins from the Marketplace, then attach them here with one click.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {attached.map((att) => {
            const routes = att.manifest?.routes ?? [];
            return (
              <div
                key={att.id}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900 dark:text-white">{att.name}</h3>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        v{att.version}
                      </span>
                      {att.sourceProtected && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                          <ShieldCheck className="h-3 w-3" />
                          Source Protected
                        </span>
                      )}
                      {att.shareDatabase && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                          <Database className="h-3 w-3" />
                          Shared App DB
                        </span>
                      )}
                    </div>
                    {att.description && (
                      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{att.description}</p>
                    )}
                  </div>

                  {!readOnly && (
                    <div className="flex items-center gap-3">
                      <Switch
                        label="Enabled"
                        checked={att.attachmentEnabled}
                        disabled={busyId === att.memberPluginId}
                        onChange={(checked) => void handleToggle(att, { enabled: checked })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === att.memberPluginId}
                        onClick={() => void handleDetach(att)}
                        leftIcon={<Trash2 className="h-4 w-4 text-red-500" />}
                      >
                        Detach
                      </Button>
                    </div>
                  )}
                </div>

                {!readOnly && hasNativeDatabase && att.hasRuntime && (
                  <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <Switch
                      label="Share this app's SQLite database with this plugin"
                      description="Lets the plugin's SoftN backend read and write this app's live database tables."
                      checked={att.shareDatabase}
                      disabled={busyId === att.memberPluginId}
                      onChange={(checked) => void handleToggle(att, { shareDatabase: checked })}
                    />
                  </div>
                )}

                {routes.length > 0 && att.enabled && (
                  <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Plugin API Endpoints
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {routes.slice(0, 6).map((route) => (
                        <Button
                          key={`${route.method}:${route.path}`}
                          size="sm"
                          variant="outline"
                          isLoading={busyId === `run:${att.memberPluginId}`}
                          leftIcon={<Play className="h-3.5 w-3.5" />}
                          onClick={() => void handleInvokeRoute(att, route)}
                        >
                          {route.method} {route.path}
                        </Button>
                      ))}
                    </div>
                    {testResult?.pluginId === att.memberPluginId && (
                      <pre className="mt-2.5 max-h-48 overflow-auto rounded-xl bg-slate-950 p-3 text-xs text-emerald-300">
                        {testResult.output}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
