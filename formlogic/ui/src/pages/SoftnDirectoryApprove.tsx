import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, Globe, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import type { SoftnDraft } from '../types/app';

const STATUS_WORDS: Record<SoftnDraft['status'], string> = {
  draft: 'Not asked for yet: an agent made this draft and has not asked for it to be published.',
  awaiting_approval: 'Waiting for you. Nothing is public until you approve.',
  publishing: 'Publishing…',
  published: 'Published.',
  failed: 'Not published.',
  uncertain: 'Not sure: the directory did not answer clearly.',
  expired: 'This draft has expired. Ask for a new one.',
};

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** What the app asks to use, in words, from its permission.json. */
function permissionWords(permissions: Record<string, unknown>): string[] {
  return Object.entries(permissions).flatMap(([name, value]) => {
    const on = value === true || (typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled !== false);
    if (!on) return [];
    const hosts = typeof value === 'object' && value !== null && Array.isArray((value as { allowed_hosts?: unknown }).allowed_hosts)
      ? ` (${((value as { allowed_hosts: unknown[] }).allowed_hosts).filter((h) => typeof h === 'string').join(', ')})` : '';
    return [`${name}${hosts}`];
  });
}

/**
 * The page an agent hands its person: a draft of a hosted SoftN app for the public SoftN directory, with where it
 * goes, what it is called, what it may use and its hash, and the one control that publishes it. Signed in as the
 * account that owns the draft; an agent's token cannot reach it.
 */
export function SoftnDirectoryApprove() {
  const { draftId = '' } = useParams<{ draftId: string }>();
  const [draft, setDraft] = useState<SoftnDraft | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getSoftnDraft(draftId).then((answer) => {
      if (cancelled) return;
      if (answer.error || !answer.data) setError(answer.error ?? 'This draft could not be found.');
      else setDraft(answer.data);
    });
    return () => { cancelled = true; };
  }, [draftId]);

  const approve = async (anyway = false) => {
    setWorking(true);
    setError('');
    const answer = await api.approveSoftnDraft(draftId, anyway);
    setWorking(false);
    if (answer.error || !answer.data) setError(answer.error ?? 'It could not be published.');
    else setDraft(answer.data);
  };

  if (!draft) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        {error ? <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>
          : <p role="status" className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading the draft…</p>}
      </main>
    );
  }
  const asks = permissionWords(draft.permissions);
  const canApprove = draft.status === 'awaiting_approval' || draft.status === 'failed';
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-300">{draft.target ? 'A new version for the SoftN directory' : 'Publish to the SoftN directory'}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{draft.listing.name ?? draft.target?.slug ?? 'Untitled app'}</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-slate-300">{STATUS_WORDS[draft.status]}</p>
      </header>

      <section className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="font-medium text-gray-500 dark:text-slate-400">Where it goes</dt>
          <dd className="flex items-center gap-1.5 break-all text-gray-900 dark:text-white"><Globe className="h-4 w-4 shrink-0" aria-hidden="true" />{draft.destination}</dd>
          <dt className="font-medium text-gray-500 dark:text-slate-400">Who can see it</dt>
          <dd className="text-gray-900 dark:text-white">Anyone. It is listed in the directory, anyone can play it, and its source can be read and remixed.</dd>
          {draft.target && <><dt className="font-medium text-gray-500 dark:text-slate-400">Updates</dt><dd className="text-gray-900 dark:text-white">{draft.target.slug}, an app this account published</dd></>}
          {draft.listing.description && <><dt className="font-medium text-gray-500 dark:text-slate-400">Description</dt><dd className="text-gray-900 dark:text-white">{draft.listing.description}</dd></>}
          {draft.listing.category && <><dt className="font-medium text-gray-500 dark:text-slate-400">Category</dt><dd className="text-gray-900 dark:text-white">{draft.listing.category}</dd></>}
          <dt className="font-medium text-gray-500 dark:text-slate-400">What it may use</dt>
          <dd className="text-gray-900 dark:text-white">{asks.length ? asks.join(', ') : 'Nothing beyond the page: no network, camera or server storage.'}</dd>
          <dt className="font-medium text-gray-500 dark:text-slate-400">The bundle</dt>
          <dd className="break-all font-mono text-xs text-gray-700 dark:text-slate-300">{size(draft.bytes)} · sha256 {draft.sha256}</dd>
        </dl>
        {draft.warnings.length > 0 && (
          <ul className="mt-4 space-y-2">
            {draft.warnings.map((warning) => (
              <li key={warning} className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{warning}</li>
            ))}
          </ul>
        )}
      </section>

      {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
      {draft.error && <p role="status" className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{draft.error}</p>}

      {draft.publication ? (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300"><CheckCircle2 className="h-5 w-5" aria-hidden="true" />Published{draft.publication.version > 1 ? ` · version ${draft.publication.version}` : ''}</p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <a className="inline-flex items-center gap-1.5 font-medium text-emerald-800 underline dark:text-emerald-300" href={draft.publication.page} target="_blank" rel="noreferrer">Its page <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
            <a className="inline-flex items-center gap-1.5 font-medium text-emerald-800 underline dark:text-emerald-300" href={draft.publication.play} target="_blank" rel="noreferrer">Play it <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
          </div>
          <p className="mt-3 text-xs text-emerald-800/80 dark:text-emerald-300/80">Its edit key is kept for this account, encrypted, so later versions can be published from here. It is never shown to an agent.</p>
        </section>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {canApprove && <Button onClick={() => void approve()} isLoading={working} leftIcon={<ShieldCheck className="h-4 w-4" />}>{draft.target ? 'Publish this version' : 'Publish to the SoftN directory'}</Button>}
          {draft.status === 'uncertain' && <Button variant="outline" onClick={() => void approve(true)} isLoading={working}>I checked: try again</Button>}
          <Link className="text-sm text-gray-600 underline dark:text-slate-300" to={draft.previewUrl}>Try the app first</Link>
        </div>
      )}
    </main>
  );
}
