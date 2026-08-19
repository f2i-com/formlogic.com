import { useState } from 'react';
import { Palette } from 'lucide-react';
import { Switch } from '../../ui/Switch';
import { useAppStore } from '../../../stores/appStore';
import { toast } from '../../../stores/toastStore';
import { cn } from '../../../lib/utils';
import { contrastLevel, hexContrast, readableForegroundColor } from '../../../lib/color';
import { trackStudioSave } from '../studioSaveState';
import { DEFAULT_APP_THEME } from '../../../types/app';
import type { App } from '../../../types/app';

/** The accent lands in an inline CSS custom property, so keep the format strict. */
const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

/**
 * Only the fonts the app actually loads. 'Inter' used to be offered and was never
 * loaded, so apps chose a font and silently got system-ui.
 */
const FONTS = [
  { value: 'DM Sans', label: 'DM Sans' },
  { value: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans' },
  { value: 'system-ui', label: 'System' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'monospace', label: 'Monospace' },
];

/**
 * The app's look — accent, font, logo and whether the runtime shows navigation.
 *
 * This lives in the Screens section, beside the preview that draws it. It used to be
 * a separate "Theme" tab on App settings whose only preview was a white card with a
 * sample button, so an owner picked a colour without seeing it on their own app.
 *
 * Only controls the runtime HONOURS are offered: AppRuntimeThemeProvider applies
 * `primaryColor` and `fontFamily`. `backgroundColor` and `textColor` were editable,
 * previewed and contrast-checked but never applied to anything, so they are gone.
 */
export function AppLookPanel({
  app,
  onReloadApp,
}: {
  app: App;
  onReloadApp: () => Promise<void>;
}) {
  const updateApp = useAppStore((s) => s.updateApp);
  // `null` = not editing; the input then always shows the persisted value, so a save
  // from another surface can never be overwritten by a stale draft sitting in here.
  const [accentDraft, setAccentDraft] = useState<string | null>(null);
  const [logoDraft, setLogoDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const theme = { ...DEFAULT_APP_THEME, ...app.theme };
  const accent = accentDraft ?? theme.primaryColor;
  const validAccent = isHexColor(accent) ? accent : theme.primaryColor;
  const ratio = hexContrast(validAccent, readableForegroundColor(validAccent));
  const level = ratio === null ? null : contrastLevel(ratio);

  /** Merge over the CURRENT stored theme — the server writes `theme` wholesale, so a
   *  stale snapshot here would revert a colour or font saved since this render. */
  const saveTheme = async (patch: Partial<App['theme']>, label: string) => {
    setBusy(true);
    const current = { ...DEFAULT_APP_THEME, ...(useAppStore.getState().getApp(app.id)?.theme ?? app.theme) };
    const ok = await trackStudioSave(
      label,
      () => updateApp(app.id, { theme: { ...current, ...patch } }),
      (saved) => !!saved
    );
    setBusy(false);
    if (ok) await onReloadApp();
    else toast.error(`Could not save the ${label.toLowerCase()}`);
  };

  const saveLogo = async (url: string) => {
    setBusy(true);
    const ok = await trackStudioSave('App logo', () => updateApp(app.id, { logoUrl: url }), (saved) => !!saved);
    setBusy(false);
    if (ok) await onReloadApp();
  };

  const setHideNav = async (hidden: boolean) => {
    setBusy(true);
    const current = useAppStore.getState().getApp(app.id)?.settings ?? app.settings;
    const ok = await trackStudioSave(
      'App navigation',
      () => updateApp(app.id, { settings: { ...current, hideNav: hidden } }),
      (saved) => !!saved
    );
    setBusy(false);
    if (ok) await onReloadApp();
  };

  const commitAccent = () => {
    const next = accentDraft;
    setAccentDraft(null);
    if (!next || !isHexColor(next) || next.toLowerCase() === theme.primaryColor.toLowerCase()) return;
    void saveTheme({ primaryColor: next }, 'Accent colour');
  };

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-white/[0.06] dark:bg-slate-900/50">
      <div className="flex items-center justify-between border-b border-gray-200/80 p-4 dark:border-white/[0.06]">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Look &amp; feel</h3>
        <Palette className="h-4 w-4 text-gray-500 dark:text-slate-400" aria-hidden="true" />
      </div>
      <div className="space-y-4 p-4">
        <div>
          <label htmlFor="studio-accent" className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
            Accent colour
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="color"
              aria-label="Accent colour picker"
              value={validAccent.slice(0, 7)}
              disabled={busy}
              onChange={(e) => setAccentDraft(e.target.value)}
              onBlur={commitAccent}
              className="h-10 w-11 shrink-0 cursor-pointer rounded-lg border border-gray-200 bg-white p-1 dark:border-white/10 dark:bg-slate-900"
            />
            <input
              id="studio-accent"
              value={accent}
              disabled={busy}
              onChange={(e) => setAccentDraft(e.target.value)}
              onBlur={commitAccent}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 font-mono text-xs text-gray-700 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-500/15 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
            />
          </div>
          <p className={cn(
            'mt-1.5 text-[11px] leading-4',
            level === 'fail' ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-slate-400'
          )}>
            {ratio === null
              ? 'Buttons, links and highlights inside the app.'
              : level === 'fail'
                ? `Low contrast (${ratio.toFixed(1)}:1) — text on this colour will be hard to read.`
                : `Buttons and links use this. Contrast ${ratio.toFixed(1)}:1.`}
          </p>
        </div>

        <div>
          <label htmlFor="studio-font" className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
            Font
          </label>
          <select
            id="studio-font"
            value={theme.fontFamily}
            disabled={busy}
            onChange={(e) => void saveTheme({ fontFamily: e.target.value }, 'App font')}
            className="mt-1.5 h-10 w-full min-w-0 cursor-pointer rounded-lg border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 outline-none dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
          >
            {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        <div>
          <label htmlFor="studio-logo" className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
            Logo image
          </label>
          <input
            id="studio-logo"
            value={logoDraft ?? app.logoUrl ?? ''}
            disabled={busy}
            onChange={(e) => setLogoDraft(e.target.value)}
            onBlur={() => {
              const next = (logoDraft ?? '').trim();
              setLogoDraft(null);
              if (logoDraft !== null && next !== (app.logoUrl ?? '')) void saveLogo(next);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder="https://example.com/logo.png"
            className="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-gray-200 bg-white px-3 text-xs text-gray-700 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-500/15 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
          />
          <p className="mt-1.5 text-[11px] leading-4 text-gray-500 dark:text-slate-400">
            Shown in the app header. Without one the app uses its icon on the accent colour.
          </p>
        </div>

        <div className="border-t border-gray-200/80 pt-4 dark:border-white/[0.06]">
          <Switch
            label="Full-screen app"
            description="Hide the menu entirely — members reach records from a floating button. Suits a single custom home screen."
            checked={app.settings?.hideNav === true}
            disabled={busy}
            onChange={(v) => void setHideNav(v)}
          />
        </div>
      </div>
    </section>
  );
}
