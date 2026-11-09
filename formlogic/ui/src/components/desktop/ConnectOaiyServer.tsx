import { useEffect, useRef, useState } from 'react';
import { Server, Copy, Check } from 'lucide-react';
import { api, type DesktopLinkCode, type DesktopLinkStatus } from '../../lib/api';
import { Button } from '../ui/Button';

/**
 * Connect an OAIY server (App AI contract §2): an always-on OAIY with no browser of its own links with
 * a one-time code. The person chooses what it may do (AI only, the default, or everything a linked
 * desktop can do), gets a code shown this once, runs one command on the server, and sees it linked.
 * From then on it is an ordinary linked computer.
 */
export function ConnectOaiyServer({ onLinked, compact = false }: { onLinked?: (connectionId: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'ai' | 'all'>('ai');
  const [name, setName] = useState('');
  const [code, setCode] = useState<DesktopLinkCode | null>(null);
  const [status, setStatus] = useState<DesktopLinkStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const linkedRef = useRef(onLinked);
  useEffect(() => { linkedRef.current = onLinked; }, [onLinked]);

  // How the code is getting on: asked every three seconds until it is linked, fails or runs out.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const result = await api.getDesktopLinkCode(code.id);
      if (cancelled) return;
      setNow(Date.now());
      if (result.data) {
        setStatus(result.data);
        if (result.data.status === 'linked') { if (result.data.connectionId) linkedRef.current?.(result.data.connectionId); return; }
        if (result.data.status === 'expired' || result.data.status === 'failed' || result.data.status === 'unlinked') return;
      }
      timer = setTimeout(() => void ask(), 3000);
    };
    timer = setTimeout(() => void ask(), 3000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [code]);

  const make = async () => {
    setBusy(true); setError(null); setStatus(null); setCopied(false);
    const result = await api.createDesktopLinkCode({ scope, deviceName: name.trim() || undefined });
    setBusy(false);
    if (result.error || !result.data) { setError(result.error ?? 'A code could not be made.'); return; }
    setCode(result.data);
    setNow(Date.now());
  };
  const copy = async () => {
    if (!code) return;
    try { await navigator.clipboard.writeText(code.command); setCopied(true); } catch { setCopied(false); }
  };

  if (!open) {
    return (
      <Button size={compact ? 'sm' : 'md'} variant="outline" onClick={() => setOpen(true)}>
        <Server className="mr-2 h-4 w-4" aria-hidden="true" />Connect an OAIY server
      </Button>
    );
  }
  const left = code ? Math.max(0, Math.round((Date.parse(code.expiresAt) - now) / 1000)) : 0;
  const state = status?.status ?? (code ? 'waiting' : null);
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-slate-700" data-testid="connect-oaiy-server">
      <div>
        <strong className="flex items-center gap-2 text-sm"><Server className="h-4 w-4" aria-hidden="true" />Connect an OAIY server</strong>
        <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
          For an always-on computer running <code>oaiy-server</code>, which can&apos;t open a browser to approve a link.
          You get a code to type on it, good for ten minutes and one use.
        </p>
      </div>
      {!code || state === 'expired' || state === 'failed' || state === 'unlinked' ? (
        <div className="space-y-3">
          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium">What may it do?</legend>
            <label className="flex cursor-pointer gap-2"><input type="radio" name="oaiy-server-scope" checked={scope === 'ai'} onChange={() => setScope('ai')} />
              <span><strong>AI only</strong> (recommended): it answers AI requests, the site&apos;s or your apps&apos;, and nothing else.</span></label>
            <label className="flex cursor-pointer gap-2"><input type="radio" name="oaiy-server-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              <span><strong>Everything a linked desktop can do</strong>: also your flows, records and connector commands.</span></label>
          </fieldset>
          <label className="block text-sm">
            <span className="font-medium">Name (optional)</span>
            <input className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" value={name} maxLength={100}
              onChange={(event) => setName(event.target.value)} placeholder="The server names itself if you leave this empty" />
          </label>
          {state === 'expired' && <p className="text-sm text-amber-700 dark:text-amber-300">That code ran out. Make a new one.</p>}
          {state === 'failed' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{status?.message ?? 'That code could not link the server.'}</p>}
          {state === 'unlinked' && <p className="text-sm text-amber-700 dark:text-amber-300">{status?.message ?? 'That server has been unlinked since. Make a new code to link it again.'}</p>}
          <div className="flex gap-2">
            <Button size="sm" isLoading={busy} onClick={() => void make()}>Make a code</Button>
            <Button size="sm" variant="outline" onClick={() => { setOpen(false); setCode(null); setStatus(null); }}>Cancel</Button>
          </div>
        </div>
      ) : state === 'linked' ? (
        <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-500/10 dark:text-green-200" role="status">
          Linked: <strong>{status?.deviceName ?? 'your server'}</strong>. Start <code>oaiy-server</code> on it (restart it, if it is running) and it appears with your linked computers.
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <p>The code, shown this once:</p>
          <p className="select-all font-mono text-2xl tracking-widest" data-testid="oaiy-link-code">{code.code}</p>
          <p>On the server, run:</p>
          <div className="flex items-start gap-2">
            <code className="block flex-1 select-all break-all rounded-lg bg-gray-100 px-3 py-2 dark:bg-slate-800">{code.command}</code>
            <Button size="sm" variant="outline" onClick={() => void copy()} aria-label="Copy the command">
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>
          <p className="text-gray-500 dark:text-slate-400" role="status">
            Waiting for the server… {left > 0 ? `The code is good for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` : ''}
            {' '}{code.scope === 'ai' ? 'It may answer AI requests only.' : 'It may do everything a linked desktop can.'}
          </p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
