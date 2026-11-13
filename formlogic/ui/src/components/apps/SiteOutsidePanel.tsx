// The other sites a hosted JavaScript app may reach, for its owner to set.
//
// A hosted app reaches nothing but its own files and its own backend. Many built apps expect
// more: an API they call, a font service, a script from a CDN. Their owner lists those sites
// here, and the app's pages are then served under a policy that lets them through
// (SecurityHeadersMiddleware::siteFramePolicy). It widens what the app can reach on the internet,
// never what it can reach on this site: the app still has no origin, no session and no cookies.
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { SITE_OUTSIDE_MOST, outsideSiteIsOwn, readOutsideSite } from '../../lib/siteApps';

export function SiteOutsidePanel({ sites, disabled = false, onChange, ownHost = typeof window === 'undefined' ? '' : window.location.hostname }: {
  sites: string[];
  disabled?: boolean;
  /** The whole list as it should now be. */
  onChange: (next: string[]) => void | Promise<void>;
  /** The name this site is on, which is never an outside site. */
  ownHost?: string;
}) {
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState('');
  const full = sites.length >= SITE_OUTSIDE_MOST;

  const add = () => {
    const site = readOutsideSite(typed);
    if (!typed.trim()) return;
    if (!site) { setProblem('That is not a site’s address. Write it as https://api.example.com (or wss://… for a live connection). Plain http and number addresses (127.0.0.1) are not taken.'); return; }
    if (outsideSiteIsOwn(site, ownHost)) { setProblem('That is this site’s own address, which an app is never given. Your app already reaches its own backend at /api/….'); return; }
    if (sites.includes(site)) { setProblem(`${site} is already on the list.`); return; }
    setProblem('');
    setTyped('');
    void onChange([...sites, site]);
  };

  return <div>
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
      A hosted app reaches only its own files and its own backend. If yours calls an outside API, or loads fonts, pictures or a script from another site, name each site here.
      It still cannot read FormLogic, your account or another app.
    </p>
    {sites.length > 0
      ? <ul className="mt-3 space-y-1.5" aria-label="Outside sites this app may reach">
        {sites.map(site => <li key={site} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 py-1 pl-3 pr-1 dark:border-slate-700">
          <span className="min-w-0">
            <span className="block break-all font-mono text-xs text-slate-800 dark:text-slate-100">{site}</span>
            {/* Written into the manifest somewhere else: it is on the list, and the app is refused it all the same. */}
            {outsideSiteIsOwn(site, ownHost) && <span className="block text-xs text-amber-700 dark:text-amber-300">This site’s own address is never allowed. Remove it.</span>}
          </span>
          <button type="button" disabled={disabled} onClick={() => void onChange(sites.filter(one => one !== site))} aria-label={`Remove ${site}`} title="Remove"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 max-sm:h-11 max-sm:w-11 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </li>)}
      </ul>
      : <p className="mt-3 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">No outside site is allowed. The app reaches only what it holds and its own backend.</p>}
    <div className="mt-3 flex flex-wrap items-start gap-2">
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor="site-outside-add" className="sr-only">A site to allow</label>
        <Input id="site-outside-add" value={typed} disabled={disabled || full} placeholder="https://api.example.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          onChange={event => { setTyped(event.target.value); setProblem(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
          aria-invalid={problem ? true : undefined} aria-describedby={problem ? 'site-outside-problem' : undefined} />
      </div>
      <Button size="sm" variant="secondary" disabled={disabled || full || !typed.trim()} leftIcon={<Plus className="h-4 w-4" />} onClick={add}>Allow this site</Button>
    </div>
    {problem && <p id="site-outside-problem" role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{problem}</p>}
    <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
      {full ? `An app may name up to ${SITE_OUTSIDE_MOST} sites.` : 'Paste an address from your browser and it is cut down to its site. *.example.com allows every name under example.com.'}
    </p>
  </div>;
}
