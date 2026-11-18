import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight, Download, LibraryBig, Package, Search, Sparkles, Star } from 'lucide-react';
import '../styles/landing-v2.css';
import '../styles/landing-refresh.css';
import { MarketplaceLayout } from '../components/layout/MarketplaceLayout';
import { PageBody } from '../components/layout/PageBody';
import { Button } from '../components/ui/Button';
import { PackIcon } from '../components/ui/PackIcon';
import { Skeleton } from '../components/ui/Skeleton';
import { useAuthStore } from '../stores/authStore';
import { usePackBrowse } from '../hooks/usePackBrowse';
import { api, resolveFileUrl, type CatalogPack, type PackFacet } from '../lib/api';
import { browseStarters, starterCatalog } from '../lib/starterCatalog';
import { cn } from '../lib/utils';

const PAGE_SIZE = 12;
const sortOptions = { popular: 'Popular', top_rated: 'Top rated', newest: 'Newest', name: 'Name' };
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const grid = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4';
const control = 'h-11 min-w-0 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const labelClass = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300';
const pickerClass = cn(control, 'px-1.5 font-normal @sm/packs:px-3');
const bundledFeatured = starterCatalog.filter(pack => pack.featured).slice(0, 3);

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
  const parts = [
    pack.formCount > 0 && plural(pack.formCount, 'form'),
    pack.appCount > 0 && plural(pack.appCount, 'app'),
    (pack.nodeCount ?? 0) > 0 && plural(pack.nodeCount!, 'flow node'),
  ].filter(Boolean);
  return (
    <Link to={{ pathname: `/packs/${pack.slug}`, search }} aria-label={pack.name}
      className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left transition-colors hover:border-primary-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-primary-400">
      {shot && <div className="relative aspect-[16/8] overflow-hidden border-b border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
        <img src={resolveFileUrl(shot)} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover object-top" />
      </div>}
      <div className="flex min-w-0 flex-1 flex-col p-4">
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
  const signedIn = useAuthStore(state => !!state.user);
  const [params, setParams] = useSearchParams();
  const activeParams = useRef(params);
  const searchField = useRef<HTMLInputElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const searchQuery = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const tag = params.get('tag') ?? '';
  const requestedSort = params.get('sort') ?? '';
  const sort = Object.hasOwn(sortOptions, requestedSort) ? requestedSort : 'popular';
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const filtering = Boolean(searchQuery || category || tag);
  const [featured, setFeatured] = useState<CatalogPack[]>(bundledFeatured);
  const [facets, setFacets] = useState<{ categories: PackFacet[]; tags: PackFacet[] }>({ categories: [], tags: [] });
  const browse = usePackBrowse({ search: searchQuery, category, tag, sort, page, limit: PAGE_SIZE });
  const bundled = useMemo(() => browse.error ? browseStarters(searchQuery, category, tag, sort, page, PAGE_SIZE) : null,
    [browse.error, searchQuery, category, tag, sort, page]);
  const bundledFacets = useMemo(() => !browse.error ? null : {
    categories: getStarterFacets(starterCatalog.flatMap(pack => pack.category ? [pack.category] : [])),
    tags: getStarterFacets(starterCatalog.flatMap(pack => pack.tags)),
  }, [browse.error]);
  const { categories, tags } = bundledFacets ?? facets;
  const { packs, totalPages, total } = bundled ?? browse;

  // Keep native typing immediate while the router transitions. Back, Clear and bookmarked
  // searches restore the field too. Consecutive controls merge into the last submitted URL.
  useLayoutEffect(() => {
    activeParams.current = params;
    if (searchField.current && searchField.current.value !== searchQuery) searchField.current.value = searchQuery;
  }, [params, searchQuery]);

  useEffect(() => {
    document.title = signedIn ? 'Templates — FormLogic' : 'Template library — FormLogic';
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
  if (!browse.loading && page > Math.max(1, totalPages)) {
    const lastPage = Math.max(1, totalPages);
    return <Navigate replace to={{ pathname: '/packs', search: queryWith(params, { page: lastPage === 1 ? '' : String(lastPage) }).toString() }} />;
  }

  const context = params.toString();
  const selection = browse.error ? bundledFeatured : featured;
  const library = <>
    {!signedIn && <header className="border-b border-slate-200 pb-5 dark:border-slate-800 sm:pb-7">
      <h1 className="text-[clamp(2.25rem,6vw,4rem)] font-semibold leading-[1.05] tracking-[-0.055em] text-slate-950 dark:text-white">Template library</h1>
      <p className="mt-2 max-w-2xl text-base leading-6 text-slate-600 dark:text-slate-300">Explore ready-to-use forms, apps and automations. Open a template to see what’s inside.</p>
    </header>}

    {browse.error && <p role="status" className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300">
      Browsing the bundled starter catalogue. Live marketplace details and installation need a connection.{' '}
      <button type="button" onClick={browse.retry} className="min-h-9 text-primary-700 underline dark:text-primary-300">Retry live catalogue</button>
    </p>}

    <search aria-label="Template catalogue" className="flex flex-col gap-2.5 @2xl/packs:flex-row @2xl/packs:items-end">
      <label className={cn(labelClass, 'min-w-0 @2xl/packs:flex-1')}>
        Search templates
        <span className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
          <input ref={searchField} type="search" placeholder="Search by name, topic or industry" defaultValue={searchQuery}
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
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Sparkles className="size-4 text-primary-600 dark:text-primary-300" aria-hidden="true" />Featured templates</h2>
      {selection.map(pack => <Link key={pack.id} to={{ pathname: `/packs/${pack.slug}`, search: context }} className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded text-sm font-medium text-primary-700 hover:underline dark:text-primary-300"><span className="min-w-0 wrap-anywhere">{pack.name}</span><ArrowRight className="size-3.5 shrink-0" aria-hidden="true" /></Link>)}
    </section>}

    <section aria-labelledby="templates-results" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="templates-results" tabIndex={-1} ref={resultsHeading} className="scroll-mt-24 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
          {filtering ? 'Matching templates' : 'All templates'}
          {typeof total === 'number' && <span className="ml-2 text-sm font-normal tabular-nums text-slate-600 dark:text-slate-400"> ({total.toLocaleString()})</span>}
        </h2>
        {filtering && <button type="button" onClick={() => filter({ q: '', category: '', tag: '' })} className="min-h-10 rounded-md px-2 text-sm font-medium text-primary-700 hover:underline dark:text-primary-300">Clear filters</button>}
      </div>
      {browse.loading ? <div className={grid} role="status" aria-busy="true" aria-label="Loading templates">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
      </div> : packs.length === 0 ? <div role="status" className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center dark:border-slate-700">
        <Package className="mx-auto mb-3 size-7 text-slate-500" aria-hidden="true" />
        <p className="font-semibold">{filtering ? 'No matching templates' : 'No templates available'}</p>
        {filtering && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Try another search or clear the filters.</p>}
      </div> : <div className={grid}>{packs.map(pack => <PackCard key={pack.id} pack={pack} search={context} />)}</div>}
      {!browse.loading && totalPages > 1 && <nav aria-label="Template result pages" className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="text-sm tabular-nums text-slate-600 dark:text-slate-300">Page {page} of {totalPages}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => changePage(page - 1)} leftIcon={<ChevronLeft className="size-4" />}>Previous</Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => changePage(page + 1)} rightIcon={<ChevronRight className="size-4" />}>Next</Button>
        </div>
      </nav>}
    </section>
  </>;

  return <MarketplaceLayout actions={signedIn && <Button variant="outline" size="sm" onClick={() => navigate('/apps')} leftIcon={<LibraryBig className="size-4" />}>My apps</Button>}>
    {signedIn ? <PageBody className="space-y-4">{library}</PageBody>
      : <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 sm:space-y-7 sm:px-6 sm:py-10 lg:px-8">{library}</div>}
  </MarketplaceLayout>;
}
