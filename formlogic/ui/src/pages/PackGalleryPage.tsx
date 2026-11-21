import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Box,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Download,
  KeyRound,
  LibraryBig,
  Package,
  Play,
  Plus,
  Puzzle,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import '../styles/landing-v2.css';
import '../styles/landing-refresh.css';
import { MarketplaceLayout } from '../components/layout/MarketplaceLayout';
import { PageBody } from '../components/layout/PageBody';
import { Button } from '../components/ui/Button';
import { PackIcon } from '../components/ui/PackIcon';
import { Skeleton } from '../components/ui/Skeleton';
import { Switch } from '../components/ui/Switch';
import { PublishSoftnModal } from '../components/marketplace/PublishSoftnModal';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { toast } from '../stores/toastStore';
import { usePackBrowse } from '../hooks/usePackBrowse';
import {
  api,
  resolveFileUrl,
  type CatalogPack,
  type MarketplaceLicense,
  type MarketplaceSellerStats,
  type MemberPlugin,
  type PackFacet,
} from '../lib/api';
import { browseStarters, starterCatalog } from '../lib/starterCatalog';
import { deferEffect } from '../lib/deferredEffect';
import { cn } from '../lib/utils';

const PAGE_SIZE = 12;
const sortOptions = { popular: 'Popular', top_rated: 'Top rated', newest: 'Newest', name: 'Name' };
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const grid = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-4';
const control = 'h-11 min-w-0 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const labelClass = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300';
const pickerClass = 'min-h-11 min-w-0 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2.5 text-sm font-normal leading-5 text-slate-900 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white @sm/packs:px-3';
const bundledFeatured = starterCatalog.filter(pack => pack.featured).slice(0, 3);

function formatPrice(cents?: number, billing?: string, currency = 'USD'): string {
  if (!cents || cents <= 0 || billing === 'free') return 'Free';
  const amount = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return billing === 'subscription' ? `${symbol}${amount}/mo` : `${symbol}${amount}`;
}

function getStarterFacets(values: string[]): PackFacet[] {
  const counts = new Map<string, number>();
  values.forEach(value => counts.set(value, (counts.get(value) ?? 0) + 1));
  return Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function queryWith(params: URLSearchParams, changes: Record<string, string>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value); else next.delete(key);
  }
  return next;
}

function PackCard({ pack, search }: { pack: CatalogPack; search: string }) {
  const shot = pack.screenshots?.[0]?.url || pack.screenshot;
  const isSoftn = pack.itemType === 'softn_app';
  const isPlugin = pack.itemType === 'plugin';
  const isPrivateSource = pack.sourceVisibility === 'private';
  const priceLabel = formatPrice(pack.priceCents, pack.billingModel, pack.currency);
  const isPaid = (pack.priceCents ?? 0) > 0 && pack.billingModel !== 'free';

  const parts = [
    pack.formCount > 0 && plural(pack.formCount, 'form'),
    !isSoftn && !isPlugin && pack.appCount > 0 && plural(pack.appCount, 'app'),
    (pack.nodeCount ?? 0) > 0 && plural(pack.nodeCount!, 'flow node'),
    (isSoftn || isPlugin) && pack.pluginMeta?.hasBackend && `${pack.pluginMeta.backendRuntime || 'SoftN'} backend`,
  ].filter(Boolean);

  return (
    <Link to={{ pathname: `/packs/${pack.slug}`, search }} aria-label={pack.name}
      className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left transition-all hover:border-primary-400 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-primary-400">
      {shot && <div className="relative aspect-[16/8] overflow-hidden border-b border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
        <img src={resolveFileUrl(shot)} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover object-top" />
      </div>}
      <div className="flex min-w-0 flex-1 flex-col p-4">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {isSoftn ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2 py-0.5 text-[11px] font-semibold text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
                <Box className="size-3" aria-hidden="true" />
                {pack.bundledSoftnPack ? 'SoftN + Forms' : 'SoftN App'}
              </span>
            ) : isPlugin ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                <Puzzle className="size-3" aria-hidden="true" />Plugin
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <Package className="size-3" aria-hidden="true" />Pack
              </span>
            )}
            {pack.demoEnabled && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                <Play className="size-2.5" aria-hidden="true" />Live Sandbox
              </span>
            )}
            {isPrivateSource && (
              <span title="Private hosted · Source hidden" className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                <ShieldCheck className="size-3" aria-hidden="true" />Protected
              </span>
            )}
          </div>
          <span className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums',
            isPaid
              ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
              : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
          )}>
            {priceLabel}
          </span>
        </div>

        <div className="flex items-start gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-300" aria-hidden="true">
            <PackIcon icon={pack.icon} className="size-[18px]" emojiClassName="text-xl leading-none" />
          </span>
          <div className="min-w-0">
            {pack.category && <p className="mb-0.5 wrap-anywhere text-xs text-slate-600 dark:text-slate-400">{pack.category}</p>}
            <h3 className="wrap-anywhere text-base font-semibold leading-snug tracking-tight text-slate-950 group-hover:text-primary-700 dark:text-white dark:group-hover:text-primary-300">{pack.name}</h3>
          </div>
        </div>
        {pack.description && <p className="mt-2.5 line-clamp-2 wrap-anywhere text-sm leading-5 text-slate-600 dark:text-slate-300">{pack.description}</p>}
        <div className="mt-auto pt-3">
          <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-200 pt-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
            {parts.length > 0 && <span>{parts.join(' · ')}</span>}
            {pack.ratingCount > 0 && <span className="inline-flex items-center gap-1" aria-label={`Rated ${pack.avgRating.toFixed(1)} out of 5 by ${pack.ratingCount}`}>
              <Star className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />{pack.avgRating.toFixed(1)} ({pack.ratingCount})
            </span>}
            {pack.downloadCount > 0 && <span className="inline-flex items-center gap-1" aria-label={`${pack.downloadCount} installs`}>
              <Download className="size-3.5" aria-hidden="true" />{pack.downloadCount}
            </span>}
            {pack.featured && <span className="inline-flex items-center gap-1 text-primary-700 dark:text-primary-300"><Sparkles className="size-3.5" aria-hidden="true" />Featured</span>}
            <ArrowRight className="ml-auto size-4 shrink-0 text-slate-500 group-hover:text-primary-600 dark:text-slate-400 dark:group-hover:text-primary-300" aria-hidden="true" />
          </div>
        </div>
      </div>
    </Link>
  );
}

function FacetPicker({ label, value, facets, onChange }: { label: string; value: string; facets: PackFacet[]; onChange: (value: string) => void }) {
  if (!facets.length && !value) return null;
  return <label className={labelClass}>
    {label}
    <select value={value} onChange={event => onChange(event.target.value)} className={pickerClass}>
      <option value="">All</option>
      {value && !facets.some(facet => facet.name === value) && <option value={value}>{value}</option>}
      {facets.map(facet => <option key={facet.name} value={facet.name}>{facet.name} ({facet.count})</option>)}
    </select>
  </label>;
}

export default function PackGalleryPage() {
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const signedIn = !!user;
  const isDemo = !!user?.isDemo;
  const fetchApps = useAppStore(state => state.fetchApps);
  const [params, setParams] = useSearchParams();
  const activeParams = useRef(params);
  const searchField = useRef<HTMLInputElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);

  const activeTabParam = params.get('tab') ?? 'browse';
  const activeTab: 'browse' | 'plugins' | 'seller' =
    signedIn && !isDemo && (activeTabParam === 'plugins' || activeTabParam === 'seller')
      ? activeTabParam
      : 'browse';

  const searchQuery = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const tag = params.get('tag') ?? '';
  const itemType = params.get('type') ?? '';
  const pricing = params.get('pricing') ?? '';
  const requestedSort = params.get('sort') ?? '';
  const sort = Object.hasOwn(sortOptions, requestedSort) ? requestedSort : 'popular';
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const filtering = Boolean(searchQuery || category || tag || itemType || pricing);

  const [featured, setFeatured] = useState<CatalogPack[]>(bundledFeatured);
  const [facets, setFacets] = useState<{ categories: PackFacet[]; tags: PackFacet[] }>({ categories: [], tags: [] });
  const [publishOpen, setPublishOpen] = useState(false);

  // Member Plugins & Licenses tab state
  const [memberPlugins, setMemberPlugins] = useState<MemberPlugin[]>([]);
  const [licenses, setLicenses] = useState<MarketplaceLicense[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(false);

  // Seller Listings & Sales tab state
  const [sellerStats, setSellerStats] = useState<MarketplaceSellerStats | null>(null);
  const [loadingSeller, setLoadingSeller] = useState(false);

  const browse = usePackBrowse({
    search: searchQuery,
    category,
    tag,
    itemType,
    pricing,
    sort,
    page,
    limit: PAGE_SIZE,
    enabled: activeTab === 'browse',
  });
  const bundled = useMemo(() => browse.error ? browseStarters(searchQuery, category, tag, sort, page, PAGE_SIZE) : null,
    [browse.error, searchQuery, category, tag, sort, page]);
  const bundledFacets = useMemo(() => !browse.error ? null : {
    categories: getStarterFacets(starterCatalog.flatMap(pack => pack.category ? [pack.category] : [])),
    tags: getStarterFacets(starterCatalog.flatMap(pack => pack.tags)),
  }, [browse.error]);
  const { categories, tags } = bundledFacets ?? facets;
  const { packs, totalPages, total } = bundled ?? browse;

  useLayoutEffect(() => {
    activeParams.current = params;
    if (searchField.current && searchField.current.value !== searchQuery) searchField.current.value = searchQuery;
  }, [params, searchQuery]);

  useEffect(() => {
    document.title = signedIn ? 'Marketplace — FormLogic' : 'Marketplace — FormLogic';
  }, [signedIn]);

  useEffect(() => {
    let current = true;
    if (!signedIn) void api.browsePacks({ sort: 'popular', limit: 6 }).then(result => {
      if (current && result.data) setFeatured(result.data.packs.filter(pack => pack.featured).slice(0, 3));
    }).catch(() => {});
    void api.getPackFacets().then(result => {
      if (current && result.data) setFacets({ categories: result.data.categories ?? [], tags: result.data.tags ?? [] });
    }).catch(() => {});
    return () => { current = false; };
  }, [signedIn]);

  const loadMemberPluginsAndLicenses = useCallback(async () => {
    if (!signedIn || isDemo) return;
    setLoadingPlugins(true);
    try {
      const [pRes, lRes] = await Promise.all([api.listMemberPlugins(), api.getMarketplaceLicenses()]);
      if (pRes.data?.plugins) setMemberPlugins(pRes.data.plugins);
      if (lRes.data?.licenses) setLicenses(lRes.data.licenses);
    } finally {
      setLoadingPlugins(false);
    }
  }, [signedIn, isDemo]);

  const loadSellerDashboard = useCallback(async () => {
    if (!signedIn || isDemo) return;
    setLoadingSeller(true);
    try {
      const res = await api.getMarketplaceSellerSales();
      if (res.data) setSellerStats(res.data);
    } finally {
      setLoadingSeller(false);
    }
  }, [signedIn, isDemo]);

  useEffect(() => deferEffect(() => {
    if (activeTab === 'plugins') void loadMemberPluginsAndLicenses();
    if (activeTab === 'seller') void loadSellerDashboard();
  }), [activeTab, loadMemberPluginsAndLicenses, loadSellerDashboard]);

  function filter(changes: Record<string, string>, replace = false) {
    const next = queryWith(activeParams.current, { ...changes, page: '' });
    activeParams.current = next;
    setParams(next, { replace, preventScrollReset: true });
  }

  function changePage(next: number) {
    const query = queryWith(activeParams.current, { page: next > 1 ? String(next) : '' });
    activeParams.current = query;
    setParams(query, { preventScrollReset: true });
    resultsHeading.current?.focus({ preventScroll: true });
    resultsHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  if (activeTab === 'browse' && !browse.loading && page > Math.max(1, totalPages)) {
    const lastPage = Math.max(1, totalPages);
    return <Navigate replace to={{ pathname: '/packs', search: queryWith(params, { page: lastPage === 1 ? '' : String(lastPage) }).toString() }} />;
  }

  const context = params.toString();
  const selection = browse.error ? bundledFeatured : featured;

  const togglePluginEnabled = async (plugin: MemberPlugin, enabled: boolean) => {
    const res = await api.updateMemberPlugin(plugin.id, { enabled });
    if (res.error) { toast.error('Update failed', res.error); return; }
    toast.success(enabled ? 'Plugin enabled' : 'Plugin paused');
    await loadMemberPluginsAndLicenses();
  };

  const uninstallPlugin = async (plugin: MemberPlugin) => {
    const res = await api.uninstallMemberPlugin(plugin.id);
    if (res.error) { toast.error('Uninstall failed', res.error); return; }
    toast.success('Plugin uninstalled');
    await loadMemberPluginsAndLicenses();
  };

  const openPublishModal = () => {
    void fetchApps();
    setPublishOpen(true);
  };

  const library = <>
    {!signedIn && <header className="border-b border-slate-200 pb-5 dark:border-slate-800 sm:pb-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-50 px-3 py-1 text-xs font-semibold text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
            <Store className="h-3.5 w-3.5" aria-hidden="true" />
            FormLogic Marketplace
          </span>
          <h1 className="mt-2 text-[clamp(2.1rem,5.5vw,3.6rem)] font-semibold leading-[1.06] tracking-[-0.045em] text-slate-950 dark:text-white">
            SoftN Apps, Plugins &amp; Templates
          </h1>
          <p className="mt-2 max-w-2xl text-base leading-6 text-slate-600 dark:text-slate-300">
            Test SoftN apps and modular plugins in a private, source-hidden live sandbox — including their isolated backend — before installing or buying.
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={() => navigate('/login?redirect=/packs')} leftIcon={<Plus className="h-5 w-5" />}>
          Sell or Publish Yours
        </Button>
      </div>
    </header>}

    {signedIn && !isDemo && (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Marketplace sections">
          {([
            ['browse', 'Browse Marketplace', Store],
            ['plugins', 'My Plugins & Licenses', Puzzle],
            ['seller', 'My Listings & Sales', TrendingUp],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeTab === key}
              onClick={() => filter({ tab: key === 'browse' ? '' : key })}
              className={cn(
                'inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl px-4 text-sm font-semibold transition',
                activeTab === key
                  ? 'bg-primary-600 text-primary-foreground shadow-sm'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <Button
          variant="primary"
          size="md"
          onClick={openPublishModal}
          leftIcon={<Plus className="h-4 w-4" />}
        >
          Publish App or Plugin
        </Button>
      </div>
    )}

    {activeTab === 'browse' && <>
      {browse.error && <p role="status" className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300">
        Browsing the bundled starter catalogue. Live marketplace details and installation need a connection.{' '}
        <button type="button" onClick={browse.retry} className="min-h-9 text-primary-700 underline dark:text-primary-300">Retry live catalogue</button>
      </p>}

      {/* Big clear type + pricing filter pills */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by product type">
          {([
            ['', 'All Products', Store],
            ['softn_app', 'SoftN Apps', Box],
            ['plugin', 'Modular Plugins', Puzzle],
            ['application_package', 'Forms Packs', Package],
          ] as const).map(([val, label, Icon]) => (
            <button
              key={val || 'all'}
              type="button"
              aria-pressed={itemType === val}
              onClick={() => filter({ type: val })}
              className={cn(
                'inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border px-3.5 text-sm font-semibold transition',
                itemType === val
                  ? 'border-primary-500 bg-primary-50 text-primary-800 dark:bg-primary-500/15 dark:text-primary-200'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5" role="group" aria-label="Filter by pricing">
          {([
            ['', 'All prices'],
            ['free', 'Free'],
            ['paid', 'Paid'],
          ] as const).map(([val, label]) => (
            <button
              key={val || 'any'}
              type="button"
              aria-pressed={pricing === val}
              onClick={() => filter({ pricing: val })}
              className={cn(
                'inline-flex h-9 cursor-pointer items-center rounded-lg border px-3 text-xs font-semibold transition',
                pricing === val
                  ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <search aria-label="Marketplace catalogue" className="flex flex-col gap-2.5 @2xl/packs:flex-row @2xl/packs:items-end">
        <label className={cn(labelClass, 'min-w-0 @2xl/packs:flex-1')}>
          Search marketplace
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
            <input ref={searchField} type="search" placeholder="Search SoftN apps, plugins, forms or industries" defaultValue={searchQuery}
              onChange={event => filter({ q: event.target.value }, true)} className={cn(control, 'pl-9 font-normal')} />
          </span>
        </label>
        <div className="grid min-w-0 grid-flow-col auto-cols-fr gap-2 @2xl/packs:max-w-[58%] @2xl/packs:flex-1">
          <FacetPicker label="Category" value={category} facets={categories} onChange={value => filter({ category: value, tag: '' })} />
          <FacetPicker label="Tag" value={tag} facets={tags} onChange={value => filter({ tag: value, category: '' })} />
          <label className={labelClass}>Sort by
            <select value={sort} onChange={event => filter({ sort: event.target.value === 'popular' ? '' : event.target.value })} className={pickerClass}>
              {Object.entries(sortOptions).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
        </div>
      </search>

      {!signedIn && !filtering && page === 1 && selection.length > 0 && <section className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y border-slate-200 py-2 dark:border-slate-800">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Sparkles className="size-4 text-primary-600 dark:text-primary-300" aria-hidden="true" />Featured</h2>
        {selection.map(pack => <Link key={pack.id} to={{ pathname: `/packs/${pack.slug}`, search: context }} className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded text-sm font-medium text-primary-700 hover:underline dark:text-primary-300"><span className="min-w-0 wrap-anywhere">{pack.name}</span><ArrowRight className="size-3.5 shrink-0" aria-hidden="true" /></Link>)}
      </section>}

      <section aria-labelledby="templates-results" className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="templates-results" tabIndex={-1} ref={resultsHeading} className="scroll-mt-24 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            {filtering ? 'Matching listings' : 'All marketplace listings'}
            {typeof total === 'number' && <span className="ml-2 text-sm font-normal tabular-nums text-slate-600 dark:text-slate-400"> ({total.toLocaleString()})</span>}
          </h2>
          {filtering && <button type="button" onClick={() => filter({ q: '', category: '', tag: '', type: '', pricing: '' })} className="min-h-10 rounded-md px-2 text-sm font-medium text-primary-700 hover:underline dark:text-primary-300">Clear filters</button>}
        </div>
        {browse.loading ? <div className={grid} role="status" aria-busy="true" aria-label="Loading marketplace">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-52 rounded-xl" />)}
        </div> : packs.length === 0 ? <div role="status" className="rounded-xl border border-dashed border-slate-300 px-4 py-12 text-center dark:border-slate-700">
          <Package className="mx-auto mb-3 size-8 text-slate-400" aria-hidden="true" />
          <p className="font-semibold text-slate-900 dark:text-white">{filtering ? 'No matching listings' : 'No listings available yet'}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {filtering ? 'Try clearing filters or publish the first SoftN app or plugin in this category.' : 'Be the first to publish a SoftN app or modular plugin.'}
          </p>
          {signedIn && !isDemo && (
            <Button variant="primary" size="sm" className="mt-4" onClick={openPublishModal} leftIcon={<Plus className="h-4 w-4" />}>
              Publish App or Plugin
            </Button>
          )}
        </div> : <div className={grid}>{packs.map(pack => <PackCard key={pack.id} pack={pack} search={context} />)}</div>}
        {!browse.loading && totalPages > 1 && <nav aria-label="Marketplace result pages" className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <p className="text-sm tabular-nums text-slate-600 dark:text-slate-300">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => changePage(page - 1)} leftIcon={<ChevronLeft className="size-4" />}>Previous</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => changePage(page + 1)} rightIcon={<ChevronRight className="size-4" />}>Next</Button>
          </div>
        </nav>}
      </section>
    </>}

    {/* My Plugins & Licenses Tab */}
    {activeTab === 'plugins' && (
      <div className="space-y-6">
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Installed Modular Plugins</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">Attach these SoftN plugins to any of your apps from the app&rsquo;s Settings → Modular Plugins panel.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => filter({ tab: '', type: 'plugin' })} leftIcon={<Puzzle className="h-4 w-4" />}>
              Find more plugins
            </Button>
          </div>
          {loadingPlugins ? (
            <Skeleton className="h-32 rounded-xl" />
          ) : memberPlugins.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900">
              <Puzzle className="mx-auto mb-3 h-8 w-8 text-slate-400" />
              <p className="font-semibold text-slate-900 dark:text-white">No plugins installed yet</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Browse Modular Plugins to install SoftN extensions for your workspace and apps.</p>
              <Button variant="primary" size="sm" className="mt-4" onClick={() => filter({ tab: '', type: 'plugin' })}>
                Browse Plugins
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {memberPlugins.map(plugin => (
                <div key={plugin.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/packs/${plugin.catalogSlug}`} className="font-semibold text-slate-900 hover:text-primary-600 dark:text-white dark:hover:text-primary-300">
                          {plugin.name}
                        </Link>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">v{plugin.version}</span>
                        {plugin.sourceProtected && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                            <ShieldCheck className="h-3 w-3" />Protected
                          </span>
                        )}
                      </div>
                      {plugin.description && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{plugin.description}</p>}
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                        Attached to {plural(plugin.attachedAppCount, 'app')}
                        {plugin.manifest?.hasBackend ? ` · ${plugin.manifest.backendRuntime || 'SoftN'} backend` : ''}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Switch
                        label="Active"
                        checked={plugin.enabled}
                        onChange={(checked) => void togglePluginEnabled(plugin, checked)}
                      />
                      <Button variant="ghost" size="sm" onClick={() => void uninstallPlugin(plugin)} leftIcon={<Trash2 className="h-3.5 w-3.5 text-red-500" />}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">My Marketplace Licenses</h2>
          {licenses.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Purchased and claimed Marketplace licenses appear here.</p>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {licenses.map(lic => (
                  <div key={lic.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <Link to={`/packs/${lic.catalogSlug ?? ''}`} className="font-semibold text-slate-900 hover:text-primary-600 dark:text-white dark:hover:text-primary-300">
                        {lic.catalogName || lic.catalogSlug}
                      </Link>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="inline-flex items-center gap-1 font-mono"><KeyRound className="h-3 w-3" />{lic.licenseKey}</span>
                        <span>·</span>
                        <span>{formatPrice(lic.priceCents, lic.billingModel, lic.currency)}</span>
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => navigate(`/packs/${lic.catalogSlug ?? ''}`)}>
                      Open listing
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    )}

    {/* My Listings & Sales Tab */}
    {activeTab === 'seller' && (
      <div className="space-y-5">
        {loadingSeller ? (
          <Skeleton className="h-40 rounded-2xl" />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Gross Revenue</p>
                <p className="mt-1 flex items-center gap-1 text-2xl font-bold text-slate-900 dark:text-white">
                  <DollarSign className="h-5 w-5 text-emerald-600" />
                  {((sellerStats?.grossRevenueCents ?? 0) / 100).toFixed(2)}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Active Licenses</p>
                <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{sellerStats?.totalLicenses ?? 0}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Published Listings</p>
                <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{sellerStats?.listings.length ?? 0}</p>
              </div>
            </div>

            {(sellerStats?.listings.length ?? 0) === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
                <Store className="mx-auto mb-3 h-9 w-9 text-primary-500" />
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">Start selling on the FormLogic Marketplace</h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">
                  Upload any .softn app or plugin — FormLogic hosts it privately, provides a live sandbox demo (with backend) to buyers, and keeps your source code hidden.
                </p>
                <Button variant="primary" className="mt-4" onClick={openPublishModal} leftIcon={<Plus className="h-4 w-4" />}>
                  Publish Your First App or Plugin
                </Button>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                <div className="divide-y divide-slate-200 dark:divide-slate-800">
                  {sellerStats?.listings.map(item => (
                    <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={`/packs/${item.slug}`} className="font-semibold text-slate-900 hover:text-primary-600 dark:text-white dark:hover:text-primary-300">
                            {item.name}
                          </Link>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                            {item.itemType === 'plugin' ? 'Plugin' : item.itemType === 'softn_app' ? 'SoftN App' : 'Pack'}
                          </span>
                          {item.sourceVisibility === 'private' && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                              <ShieldCheck className="h-3 w-3" />Source Hidden
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {formatPrice(item.priceCents, item.billingModel, item.currency)} · {plural(item.downloadCount, 'install')} · {plural(item.licenseCount, 'license')} · ${(item.revenueCents / 100).toFixed(2)} revenue
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => navigate(`/packs/${item.slug}`)}>
                        View listing
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )}

    <PublishSoftnModal
      isOpen={publishOpen}
      onClose={() => setPublishOpen(false)}
      onPublished={(newSlug) => {
        browse.retry();
        navigate(`/packs/${newSlug}`);
      }}
    />
  </>;

  return <MarketplaceLayout title="Marketplace" actions={signedIn && <Button variant="outline" size="sm" onClick={() => navigate('/apps')} leftIcon={<LibraryBig className="size-4" />}>My apps</Button>}>
    {signedIn ? <PageBody className="space-y-4">{library}</PageBody>
      : <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:space-y-7 sm:px-6 sm:py-10 lg:px-8">{library}</div>}
  </MarketplaceLayout>;
}
