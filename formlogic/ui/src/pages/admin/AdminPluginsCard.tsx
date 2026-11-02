import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { AvailablePlugin, InstalledPlugin } from '../../types/app';

const STRENGTH: Record<string, string> = { declared: 'by the member\'s own word', estimated: 'by an estimate', verified: 'by a check' };

/** What a plugin may do on this site, in words: the passes it issues. */
function grantsOf(passes: Array<{ kind: string; label: string; unit: string; min: number; max: number; strengths: string[] }>): string[] {
  return passes.map((pass) => `Issue ${pass.kind === 'age' ? 'an age' : pass.label} pass (${pass.min}–${pass.max}${pass.unit ? ` ${pass.unit}` : ''}) ${pass.strengths.map((s) => STRENGTH[s] ?? s).join(' or ')}`);
}

/**
 * Admin → Plugins. A plugin is a SoftN app with a plugin manifest: its backend runs in the SoftN
 * runner and its pages in the sandboxed frame, and it may do only what is listed here, which is
 * what it was granted at install. Apps choose to require the passes it issues.
 */
export function AdminPluginsCard() {
  const [state, setState] = useState<{ installed: InstalledPlugin[]; available: AvailablePlugin[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped after every change, to read the list again.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.adminGetPlugins().then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) { setError(result.error ?? 'Could not read the plugins.'); return; }
      setError(null);
      setState(result.data);
    });
    return () => { cancelled = true; };
  }, [revision]);

  const act = async (id: string, call: () => Promise<{ error?: string }>, done: string) => {
    setBusy(id);
    const result = await call();
    setBusy(null);
    if (result.error) { toast.error('That did not work', result.error); return; }
    toast.success(done);
    setRevision((n) => n + 1);
  };

  return (
    <Card>
      <CardContent className="p-5 sm:p-6 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2"><Puzzle className="h-4 w-4" aria-hidden="true" />Plugins</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
            Plugins are SoftN apps that add to the site. Each runs sandboxed and can do only what it was granted when installed, listed under it.
            App owners choose whether their apps ask for what a plugin issues. Turning one off closes the apps that ask for it; removing it also withdraws everything it issued.
          </p>
        </div>
        {!state ? (
          error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : <p role="status" className="text-sm text-gray-500">Loading…</p>
        ) : (
          <>
            {state.installed.length === 0 && <p className="text-sm text-gray-500 dark:text-slate-400">No plugins are installed.</p>}
            <ul className="space-y-3">
              {state.installed.map((plugin) => (
                <li key={plugin.id} className="space-y-2 rounded-xl border border-gray-200 p-4 dark:border-slate-700">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 dark:text-white">{plugin.name} <span className="text-xs font-normal text-gray-500">v{plugin.version}</span></p>
                      <ul className="mt-1 list-disc pl-5 text-xs leading-5 text-gray-500 dark:text-slate-400">
                        {grantsOf(plugin.grants).map((grant) => <li key={grant}>{grant}</li>)}
                      </ul>
                    </div>
                    <Switch
                      label={plugin.enabled ? 'On' : 'Off'}
                      checked={plugin.enabled}
                      disabled={busy === plugin.manifestId}
                      onChange={(on) => void act(plugin.manifestId, () => api.adminSetPluginEnabled(plugin.manifestId, on), on ? `${plugin.name} is on` : `${plugin.name} is off`)}
                    />
                  </div>
                  <Button size="sm" variant="outline" isLoading={busy === plugin.manifestId}
                    onClick={() => {
                      if (!window.confirm(`Remove ${plugin.name}? Everything it issued is withdrawn, and apps that ask for it stay closed until they stop asking or it is installed again.`)) return;
                      void act(plugin.manifestId, () => api.adminRemovePlugin(plugin.manifestId), `${plugin.name} was removed`);
                    }}>Remove</Button>
                </li>
              ))}
            </ul>
            {state.available.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Included with FormLogic</h4>
                <ul className="space-y-3">
                  {state.available.map((plugin) => (
                    <li key={plugin.id} className="space-y-2 rounded-xl border border-dashed border-gray-300 p-4 dark:border-slate-600">
                      <p className="font-medium text-gray-900 dark:text-white">{plugin.name} <span className="text-xs font-normal text-gray-500">v{plugin.version}</span></p>
                      {plugin.description && <p className="text-sm text-gray-500 dark:text-slate-400">{plugin.description}</p>}
                      <p className="text-xs font-medium text-gray-700 dark:text-slate-300">Installing it grants it:</p>
                      <ul className="list-disc pl-5 text-xs leading-5 text-gray-500 dark:text-slate-400">
                        {grantsOf(plugin.passes).map((grant) => <li key={grant}>{grant}</li>)}
                      </ul>
                      <Button size="sm" isLoading={busy === plugin.id} onClick={() => void act(plugin.id, () => api.adminInstallPlugin(plugin.id), `${plugin.name} is installed`)}>Install</Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
