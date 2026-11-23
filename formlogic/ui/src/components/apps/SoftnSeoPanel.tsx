import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Copy, ExternalLink, FileCode2, Globe, RefreshCw, Search, ShieldOff } from 'lucide-react';
import { api, type NativeAppSeoOverview } from '../../lib/api';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { Switch } from '../ui/Switch';
import { Textarea } from '../ui/Textarea';
import { toast } from '../../stores/toastStore';
import { cn, copyToClipboard } from '../../lib/utils';

export function SoftnSeoPanel({
  appId,
  readOnly = false,
}: {
  appId: string;
  readOnly?: boolean;
}) {
  const [overview, setOverview] = useState<NativeAppSeoOverview | null>(null);
  const [allowIndexing, setAllowIndexing] = useState(true);
  const [defaultDescription, setDefaultDescription] = useState('');
  const [extraRoutesText, setExtraRoutesText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.getNativeAppSeo(appId);
    if (res.data) {
      setOverview(res.data);
      setAllowIndexing(res.data.settings.allowIndexing);
      setDefaultDescription(res.data.settings.defaultDescription);
      setExtraRoutesText(res.data.settings.extraRoutes.join('\n'));
    }
    setLoading(false);
  }, [appId]);

  useEffect(() => {
    let active = true;
    void api.getNativeAppSeo(appId).then((res) => {
      if (!active) return;
      if (res.data) {
        setOverview(res.data);
        setAllowIndexing(res.data.settings.allowIndexing);
        setDefaultDescription(res.data.settings.defaultDescription);
        setExtraRoutesText(res.data.settings.extraRoutes.join('\n'));
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [appId]);

  const save = async () => {
    if (readOnly) return;
    setSaving(true);
    const extraRoutes = extraRoutesText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const res = await api.updateNativeAppSeo(appId, {
      allowIndexing,
      defaultDescription: defaultDescription.trim(),
      extraRoutes,
    });
    setSaving(false);
    if (res.error || !res.data) {
      toast.error('Could not save SEO settings', res.error || 'Please try again.');
      return;
    }
    setOverview(res.data);
    setExtraRoutesText(res.data.settings.extraRoutes.join('\n'));
    toast.success('SEO & crawlability settings saved');
  };

  const copy = async (url: string) => {
    await copyToClipboard(url);
    setCopiedUrl(url);
    toast.success('Copied to clipboard');
    window.setTimeout(() => setCopiedUrl(curr => curr === url ? null : curr), 1600);
  };

  return (
    <Panel title="Search Engines &amp; Crawlable Pages (SEO)" icon={<Search className="h-4 w-4 text-primary-600 dark:text-primary-400" />}>
      {loading && !overview ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">Checking discoverable pages…</p>
      ) : !overview ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">SEO overview is unavailable for this app right now.</p>
      ) : (
        <div className="space-y-4" data-testid="softn-seo-panel">
          {/* Indexability status banner */}
          <div className={cn(
            'flex items-start gap-2.5 rounded-xl border p-3 text-xs leading-5',
            overview.indexable
              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
              : 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
          )}>
            {overview.indexable
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              : <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />}
            <div>
              <p className="font-semibold">
                {overview.indexable ? 'Indexable by search engines' : 'Hidden from search engines (noindex)'}
              </p>
              <p className="mt-0.5 opacity-90">{overview.indexabilityReason}</p>
            </div>
          </div>

          {/* Sitemap & robots quick links */}
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { label: 'XML Sitemap', url: overview.sitemapUrl },
              { label: 'robots.txt', url: overview.robotsUrl },
            ].map(item => (
              <div key={item.label} className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{item.label}</p>
                  <p className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">{item.url}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void copy(item.url)}
                    title={`Copy ${item.label} URL`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {copiedUrl === item.url ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${item.label}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </div>
              </div>
            ))}
          </div>

          {/* Controls */}
          <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            <Switch
              label="Allow search engines to index public pages"
              description="Emits per-page <title>, canonical URL, OpenGraph, JSON-LD, crawlable HTML snapshot, and sitemap.xml. Private/members apps stay noindex."
              checked={allowIndexing}
              disabled={readOnly || saving}
              onChange={setAllowIndexing}
            />
            <div>
              <label htmlFor="softn-seo-desc" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Default meta description
              </label>
              <Textarea
                id="softn-seo-desc"
                rows={2}
                value={defaultDescription}
                disabled={readOnly || saving}
                onChange={e => setDefaultDescription(e.target.value)}
                placeholder="Used when a page does not define its own <meta name='description'>."
                className="mt-1 text-xs"
              />
            </div>
            <div>
              <label htmlFor="softn-seo-routes" className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Extra SPA routes to include in sitemap (one per line)
              </label>
              <Textarea
                id="softn-seo-routes"
                rows={2}
                value={extraRoutesText}
                disabled={readOnly || saving}
                onChange={e => setExtraRoutesText(e.target.value)}
                placeholder={'/pricing\n/contact'}
                className="mt-1 font-mono text-xs"
              />
            </div>
            {!readOnly && (
              <div className="flex items-center gap-2">
                <Button size="sm" isLoading={saving} onClick={() => void save()}>Save SEO settings</Button>
                <Button size="sm" variant="secondary" leftIcon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />} onClick={() => void load()}>
                  Re-scan pages
                </Button>
              </div>
            )}
          </div>

          {/* Discovered pages table */}
          <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                Discovered crawlable pages ({overview.pages.length})
              </p>
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                <Globe className="h-3 w-3" aria-hidden="true" />
                {overview.customDomain ?? 'Platform URL'}
              </span>
            </div>
            {overview.pages.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No pages discovered yet.</p>
            ) : (
              <div className="mt-2 max-h-60 space-y-1.5 overflow-y-auto">
                {overview.pages.map(page => (
                  <div
                    key={page.path}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono font-semibold text-primary-700 dark:text-primary-300">{page.path}</span>
                        <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          <FileCode2 className="h-2.5 w-2.5" aria-hidden="true" />
                          {page.source}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate font-medium text-slate-800 dark:text-slate-200">{page.title}</p>
                      {page.description && (
                        <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">{page.description}</p>
                      )}
                    </div>
                    <a
                      href={page.canonicalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border border-slate-200 px-2 text-[11px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      Open
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
