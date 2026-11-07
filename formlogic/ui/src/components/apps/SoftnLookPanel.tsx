import { useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { AppSplash } from '../studio/AppSplash';
import type { NativeProject } from '../../lib/nativeHosting';
import type { SoftnLook } from '../../types/app';

/** The images an app may use for its look: a raster one anywhere, and SVG for its icon. */
const RASTER = /^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp)$/i;
const SVG = /^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.svg$/i;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const preview = (project: NativeProject | null, path: string | undefined) => {
  if (!project || !path || !project.assets[path]) return '';
  return `data:${MIME[path.split('.').pop()!.toLowerCase()] ?? 'image/png'};base64,${project.assets[path]}`;
};
const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';
const label = 'block text-sm font-medium text-slate-800 dark:text-slate-200';
const hint = 'mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400';

/**
 * How a hosted SoftN app looks before it opens and where it is shared (AppLookService): its icon
 * in a tab, on a home screen and once installed; the image and words a link to it shows; and the
 * loading screen's background and wheel. The icon and description start as the app's own manifest
 * says. Saved together, with the browser bar colour (settings.pwaThemeColor).
 */
export function SoftnLookPanel({ project, look, themeColor, disabled, onSave }: {
  project: NativeProject | null;
  look: SoftnLook | undefined;
  themeColor: string | undefined;
  disabled: boolean;
  onSave: (look: SoftnLook, themeColor: string | undefined) => Promise<void>;
}) {
  const manifest = useMemo(() => {
    try { return JSON.parse(project?.files['manifest.json'] ?? '{}') as { icon?: unknown; description?: unknown }; } catch { return {}; }
  }, [project]);
  const images = useMemo(() => Object.keys(project?.assets ?? {}).filter(path => RASTER.test(path) || SVG.test(path)).sort(), [project]);
  const rasters = images.filter(path => RASTER.test(path));
  const ownIcon = typeof manifest.icon === 'string' && images.includes(manifest.icon) ? manifest.icon : undefined;
  const ownDescription = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  // The owner's edits, started again from what is saved whenever that changes (a save, another tab).
  const [edit, setEdit] = useState(() => ({ look, themeColor, draft: look ?? {}, theme: themeColor }));
  if (edit.look !== look || edit.themeColor !== themeColor) setEdit({ look, themeColor, draft: look ?? {}, theme: themeColor });
  const { draft, theme } = edit;
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<SoftnLook>) => setEdit(current => {
    const next: SoftnLook = { ...current.draft, ...patch };
    for (const key of Object.keys(next) as (keyof SoftnLook)[]) if (next[key] === undefined || next[key] === '') delete next[key];
    return { ...current, draft: next };
  });
  const setTheme = (next: string | undefined) => setEdit(current => ({ ...current, theme: next }));
  const icon = draft.icon ?? ownIcon;
  const shareImage = draft.shareImage ?? (icon && RASTER.test(icon) ? icon : undefined);
  const changed = JSON.stringify(draft) !== JSON.stringify(look ?? {}) || (theme ?? '') !== (themeColor ?? '');
  const save = async () => {
    setSaving(true);
    try { await onSave(draft, theme && HEX.test(theme) ? theme : undefined); } finally { setSaving(false); }
  };
  const colour = (id: string, name: string, value: string | undefined, fallback: string, change: (next: string | undefined) => void) => (
    <div>
      <label htmlFor={id} className={label}>{name}</label>
      <div className="mt-1.5 flex items-center gap-2">
        <input id={id} type="color" value={value ?? fallback} onChange={event => change(event.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-slate-300 dark:border-slate-600" />
        <span className="font-mono text-xs text-slate-600 dark:text-slate-300">{value ?? 'Default'}</span>
        {value && <button type="button" className="text-xs font-medium text-indigo-600 dark:text-indigo-300" onClick={() => change(undefined)}>Use default</button>}
      </div>
    </div>
  );
  return (
    <fieldset disabled={disabled || saving} className="space-y-5">
      <legend className="sr-only">Look and sharing</legend>
      <div>
        <label htmlFor="softn-look-icon" className={label}>Icon</label>
        <div className="mt-1.5 flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
            {icon ? <img src={preview(project, icon)} alt="" className="h-full w-full object-contain" /> : <span className="text-xs text-slate-400">None</span>}
          </span>
          <select id="softn-look-icon" className={field} value={draft.icon ?? ''} onChange={event => set({ icon: event.target.value || undefined })}>
            <option value="">{ownIcon ? `The app's own (${ownIcon})` : 'None (FormLogic’s)'}</option>
            {images.map(path => <option key={path} value={path}>{path}</option>)}
          </select>
        </div>
        <p className={hint}>In the browser tab, on a home screen and when the app is installed. A square PNG at least 512 pixels across works everywhere; an SVG shows in tabs and installed apps, not on an Apple home screen or in link previews.</p>
      </div>
      <div>
        <label htmlFor="softn-look-share" className={label}>Share image</label>
        <div className="mt-1.5 flex items-center gap-3">
          <span className="flex h-12 w-[5.75rem] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
            {shareImage ? <img src={preview(project, shareImage)} alt="" className="h-full w-full object-contain" /> : <span className="text-xs text-slate-400">None</span>}
          </span>
          <select id="softn-look-share" className={field} value={draft.shareImage ?? ''} onChange={event => set({ shareImage: event.target.value || undefined })}>
            <option value="">{icon && RASTER.test(icon) ? 'The icon' : 'None'}</option>
            {rasters.map(path => <option key={path} value={path}>{path}</option>)}
          </select>
        </div>
        <p className={hint}>What a link to the app shows in messages and posts, fitted into a 1200 × 630 picture on the loading background. A PNG, JPEG, GIF or WebP.</p>
      </div>
      <div>
        <label htmlFor="softn-look-description" className={label}>Description</label>
        <textarea id="softn-look-description" className={`${field} mt-1.5 min-h-20`} maxLength={300} value={draft.description ?? ''} placeholder={ownDescription || 'One or two sentences about the app'} onChange={event => set({ description: event.target.value || undefined })} />
        <p className={hint}>Under the name wherever a link to the app is shared, and in its install details. Empty: the app's own ({ownDescription ? 'its manifest says it' : 'the app description'}).</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-4">
          {colour('softn-look-background', 'Loading background', draft.background, '#ffffff', next => set({ background: next }))}
          {colour('softn-look-spinner', 'Loading wheel', draft.spinner, '#6366f1', next => set({ spinner: next }))}
          {colour('softn-look-theme', 'Browser bar colour', theme, '#6366f1', next => setTheme(next))}
        </div>
        <div>
          <span className={label}>Preview</span>
          <div className="mt-1.5 h-36 w-28 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
            <AppSplash look={{ background: draft.background ?? null, spinner: draft.spinner ?? null, themeColor: null, description: '', icon: null, version: '0' }} label="Loading screen preview" />
          </div>
        </div>
      </div>
      <p className={hint}>The loading screen shows a wheel and no words while the app downloads and starts; an installed app opens on its background too.</p>
      <Button size="sm" onClick={() => void save()} disabled={!changed} isLoading={saving}>Save look</Button>
    </fieldset>
  );
}
