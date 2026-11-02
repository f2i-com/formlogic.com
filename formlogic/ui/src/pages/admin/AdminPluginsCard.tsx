import { useEffect, useRef, useState } from 'react';
import { Puzzle, Upload } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Card, CardContent } from '../../components/ui/Card';
import { Switch } from '../../components/ui/Switch';
import { api } from '../../lib/api';
import { importNativeProject } from '../../lib/nativeHosting';
import { STRENGTH_WORDS } from '../../lib/passes';
import { toast } from '../../stores/toastStore';
import type { AvailablePlugin, InstalledPlugin, PluginPass, PluginReview, PluginSetting, UploadedPlugin } from '../../types/app';
import { AdminCameraCheckCard } from './AdminCameraCheckCard';

/** What else of the site a plugin may use, in words. */
const USES: Record<string, string> = {
  camera: 'Use the camera, in this site\'s own page: it asks members for pictures and sends its own instructions with them to the AI on your computer running OAIY (Camera checks, below), which uses that computer; it decides from what the AI says. It never sees a picture.',
};

/** What a plugin may do, in words: the passes it issues, what it uses, and its sandbox's own permissions. */
function grantsOf(passes: PluginPass[], uses: string[], sandbox: string[]): string[] {
  return [
    ...passes.map((pass) => `Issue a ${pass.label.toLowerCase()} pass (${pass.min}–${pass.max}${pass.unit ? ` ${pass.unit}` : ''}): ${pass.strengths.map((s) => pass.strengthLabels?.[s] || STRENGTH_WORDS[s].label).join(', or ')}`),
    ...uses.map((use) => USES[use] ?? use),
    ...sandbox,
  ];
}

function Grants({ review }: { review: Pick<PluginReview, 'passes' | 'uses' | 'sandbox'> }) {
  return (
    <ul className="list-disc pl-5 text-xs leading-5 text-gray-500 dark:text-slate-400">
      {grantsOf(review.passes, review.uses, review.sandbox).map((grant) => <li key={grant}>{grant}</li>)}
    </ul>
  );
}

/** A plugin's settings, as its manifest declares them; saved together. */
function PluginSettings({ plugin, onSaved }: { plugin: InstalledPlugin; onSaved: () => void }) {
  const [values, setValues] = useState(plugin.settings);
  const [busy, setBusy] = useState(false);
  if (plugin.settingsSchema.length === 0) return null;
  const field = (setting: PluginSetting) => {
    const id = `plugin-${plugin.manifestId}-${setting.key}`;
    const value = values[setting.key];
    const label = <label htmlFor={id} className="text-sm font-medium text-gray-700 dark:text-slate-300">{setting.label}</label>;
    const help = setting.help ? <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">{setting.help}</p> : null;
    if (setting.type === 'boolean') {
      return <Switch key={setting.key} label={setting.label} description={setting.help} checked={value === true} onChange={(on) => setValues({ ...values, [setting.key]: on })} />;
    }
    return (
      <div key={setting.key} className="space-y-1">
        {label}
        {setting.type === 'integer' ? (
          <input id={id} type="number" min={setting.min} max={setting.max} value={Number(value)}
            onChange={(e) => setValues({ ...values, [setting.key]: Math.round(Number(e.target.value)) })}
            className="block w-24 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white" />
        ) : (
          <select id={id} value={String(value)} onChange={(e) => setValues({ ...values, [setting.key]: e.target.value })}
            className="block min-h-10 rounded-lg border border-gray-300 bg-white px-2.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white">
            {(setting.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
        {help}
      </div>
    );
  };
  const save = async () => {
    setBusy(true);
    const result = await api.adminSetPluginSettings(plugin.manifestId, values);
    setBusy(false);
    if (result.error) { toast.error('Not saved', result.error); return; }
    toast.success(`${plugin.name}'s settings are saved`);
    onSaved();
  };
  return (
    <details className="rounded-lg border border-gray-200 p-3 dark:border-slate-700">
      <summary className="cursor-pointer text-sm font-medium text-gray-900 dark:text-white">Settings</summary>
      <div className="mt-3 space-y-3">
        {plugin.settingsSchema.map(field)}
        <Button size="sm" isLoading={busy} onClick={() => void save()}>Save settings</Button>
      </div>
    </details>
  );
}

/**
 * Admin → Plugins. A plugin is a SoftN app with a plugin manifest: its code is ZIPP code in a
 * sandbox (its backend in the SoftN runner, its pages in the sandboxed frame), and it may do only
 * what is listed here, which is what it was granted when installed. Apps choose to require the
 * passes it issues. Plugins ship with FormLogic or come from an upload, which is read first.
 */
export function AdminPluginsCard() {
  const [state, setState] = useState<{ installed: InstalledPlugin[]; available: AvailablePlugin[]; sandbox: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ project: unknown; plugin: UploadedPlugin } | null>(null);
  const [revision, setRevision] = useState(0);
  const file = useRef<HTMLInputElement>(null);

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
    if (result.error) { toast.error('That did not work', result.error); return false; }
    toast.success(done);
    setRevision((n) => n + 1);
    return true;
  };

  const read = async (chosen: File | undefined) => {
    if (!chosen) return;
    try {
      const project = await importNativeProject(chosen);
      const result = await api.adminInspectPlugin(project);
      if (result.error || !result.data) { toast.error('This is not a plugin this site can install', result.error ?? ''); return; }
      setUpload({ project, plugin: result.data.plugin });
    } catch (reason) {
      toast.error('The file could not be read', reason instanceof Error ? reason.message : '');
    } finally {
      if (file.current) file.current.value = '';
    }
  };

  const cameraPlugins = (state?.installed ?? []).filter((plugin) => plugin.uses.includes('camera'));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2"><Puzzle className="h-4 w-4" aria-hidden="true" />Plugins</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                Plugins are SoftN apps that add to the site. Their code runs sandboxed, with no network, and can do only what it was granted when installed, listed under it.
                App owners choose whether their apps ask for what a plugin issues. Turning one off closes the apps that ask for it; removing it also withdraws everything it issued.
              </p>
            </div>
            <input ref={file} type="file" accept=".softn,.zip" className="hidden" aria-label="Plugin file" onChange={(e) => void read(e.target.files?.[0])} />
            <Button size="sm" variant="outline" leftIcon={<Upload className="h-4 w-4" />} onClick={() => file.current?.click()}>Upload a plugin</Button>
          </div>

          {upload && (
            <div role="region" aria-label="Plugin to install" className="space-y-2 rounded-xl border border-primary-300 bg-primary-50 p-4 dark:border-primary-500/40 dark:bg-primary-500/10">
              <p className="font-medium text-gray-900 dark:text-white">{upload.plugin.name} <span className="text-xs font-normal text-gray-500">v{upload.plugin.version} · {upload.plugin.id}</span></p>
              {upload.plugin.description && <p className="text-sm text-gray-600 dark:text-slate-300">{upload.plugin.description}</p>}
              <p className="text-xs font-medium text-gray-700 dark:text-slate-300">{upload.plugin.updates ? `This updates v${upload.plugin.updates.version}. Updating grants it:` : 'Installing it grants it:'}</p>
              <Grants review={upload.plugin} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" isLoading={busy === 'upload'} onClick={() => void act('upload', () => api.adminUploadPlugin(upload.project), `${upload.plugin.name} is installed`).then((ok) => { if (ok) setUpload(null); })}>
                  {upload.plugin.updates ? 'Update' : 'Install'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setUpload(null)}>Cancel</Button>
              </div>
            </div>
          )}

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
                        <p className="font-medium text-gray-900 dark:text-white">{plugin.name} <span className="text-xs font-normal text-gray-500">v{plugin.version}{plugin.source === 'upload' ? ' · uploaded' : ''}</span></p>
                        <Grants review={{ passes: plugin.grants, uses: plugin.uses, sandbox: [] }} />
                      </div>
                      <Switch
                        label={plugin.enabled ? 'On' : 'Off'}
                        checked={plugin.enabled}
                        disabled={busy === plugin.manifestId}
                        onChange={(on) => void act(plugin.manifestId, () => api.adminSetPluginEnabled(plugin.manifestId, on), on ? `${plugin.name} is on` : `${plugin.name} is off`)}
                      />
                    </div>
                    {plugin.update && (
                      <div className="space-y-2 rounded-lg bg-primary-50 p-3 dark:bg-primary-500/10">
                        <p className="text-sm text-gray-900 dark:text-white">Version {plugin.update.version} ships with this FormLogic. Updating grants it:</p>
                        <Grants review={plugin.update} />
                        <Button size="sm" isLoading={busy === plugin.manifestId}
                          onClick={() => void act(plugin.manifestId, () => api.adminUpdatePlugin(plugin.manifestId), `${plugin.name} is updated`)}>Update</Button>
                      </div>
                    )}
                    <PluginSettings key={`${plugin.manifestId}-${revision}`} plugin={plugin} onSaved={() => setRevision((n) => n + 1)} />
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
                        <Grants review={plugin} />
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
      {cameraPlugins.length > 0 && <AdminCameraCheckCard plugins={cameraPlugins} />}
    </div>
  );
}
