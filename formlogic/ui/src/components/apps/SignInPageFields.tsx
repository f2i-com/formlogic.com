import type { App, SignInPageSettings } from '../../types/app';
import { previewWelcome, welcomeStyle } from '../../lib/appWelcome';
import { AppWelcomeBanner, AppWelcomePanel } from '../auth/AppWelcome';

const field = 'w-full px-3.5 py-2.5 border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all duration-200';
const label = 'block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5';
const hint = 'mt-1 text-xs text-gray-500 dark:text-slate-400';

/**
 * The app's sign-in page (settings.signInPage): its words, layout, panel colour and font, with a preview drawn as the
 * page will draw it. The accent and font are the app's own (Colors & typography); the logo or icon its identity's.
 */
export function SignInPageFields({ app, onChange }: { app: App; onChange: (page: SignInPageSettings) => void }) {
  const page: SignInPageSettings = app.settings?.signInPage ?? {};
  const set = (next: Partial<SignInPageSettings>) => onChange({ ...page, ...next });
  const accent = app.theme?.primaryColor || '#6366f1';
  const preview = previewWelcome({ ...app, settings: { ...app.settings, signInPage: page } });
  const centered = page.layout === 'centered';

  return (
    <>
      <div className="grid grid-cols-1 gap-4 @xl/appsettings:grid-cols-2">
        <div>
          <label htmlFor="sign-in-title" className={label}>Welcome line</label>
          <input id="sign-in-title" type="text" maxLength={80} value={page.title ?? ''} placeholder={`Welcome to ${app.name}`} onChange={(e) => set({ title: e.target.value })} className={field} />
        </div>
        <div>
          <label htmlFor="sign-in-layout" className={label}>Layout</label>
          <select id="sign-in-layout" value={centered ? 'centered' : 'split'} onChange={(e) => set({ layout: e.target.value === 'centered' ? 'centered' : 'split' })} className={field}>
            <option value="split">A panel beside the form</option>
            <option value="centered">One card in the middle</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="sign-in-message" className={label}>Message</label>
        <textarea id="sign-in-message" rows={3} maxLength={280} value={page.message ?? ''} placeholder="A line or two for people arriving, such as what they'll find inside." onChange={(e) => set({ message: e.target.value })} className={field} />
        <p className={hint}>Plain text, up to 280 characters ({(page.message ?? '').length} used).</p>
      </div>
      <div className="grid grid-cols-1 gap-4 @xl/appsettings:grid-cols-2">
        <div>
          <label htmlFor="sign-in-panel" className={label}>Panel color</label>
          <div className="flex gap-2 items-center">
            <input type="color" aria-label="Panel color picker" value={/^#[0-9a-fA-F]{6}$/.test(page.panelColor ?? '') ? page.panelColor : accent} onChange={(e) => set({ panelColor: e.target.value })} className="h-11 w-11 shrink-0 rounded-lg border border-gray-200 dark:border-slate-600 cursor-pointer" />
            <input id="sign-in-panel" type="text" value={page.panelColor ?? ''} placeholder={`The accent (${accent})`} onChange={(e) => set({ panelColor: e.target.value || undefined })}
              onBlur={(e) => { if (e.target.value && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(e.target.value)) set({ panelColor: undefined }); }}
              className={`${field} min-w-0 flex-1 font-mono`} />
          </div>
          <p className={hint}>Empty: the app's accent color.</p>
        </div>
        <label className="flex items-center gap-2.5 self-center text-sm text-gray-700 dark:text-slate-300 cursor-pointer select-none">
          <input type="checkbox" checked={page.appFont !== false} onChange={(e) => set({ appFont: e.target.checked })} className="h-4 w-4 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500" />
          Use the app's font ({app.theme?.fontFamily || 'DM Sans'})
        </label>
      </div>
      {preview && (
        <div>
          <p className={label}>Preview</p>
          <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-slate-700" style={welcomeStyle(preview.look)} data-testid="sign-in-preview">
            <div className="flex min-h-[18rem]">
              {!centered && <AppWelcomePanel welcome={preview} mode="login" compact className="hidden w-1/2 @xl/appsettings:flex" />}
              <div className="flex flex-1 items-center justify-center bg-gray-50 p-5 dark:bg-slate-950">
                <div className="w-full max-w-[16rem]">
                  <AppWelcomeBanner welcome={preview} mode="login" className={centered ? 'mb-4' : 'mb-4 @xl/appsettings:hidden'} />
                  <p className="text-base font-bold text-gray-900 dark:text-white">Sign in to {preview.app.name}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-400">With your FormLogic account.</p>
                  <div className="mt-3 h-8 rounded-lg border border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-800" aria-hidden="true" />
                  <div className="mt-2 h-8 rounded-lg border border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-800" aria-hidden="true" />
                  <div className="mt-3 flex h-8 items-center justify-center rounded-lg bg-primary-600 text-xs font-medium text-primary-foreground" aria-hidden="true">Sign In</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      <p className={hint}>
        This page takes colors, a font and words, not style sheets: it is where people type their password, and the site keeps its own heading and mark on it.
      </p>
    </>
  );
}
