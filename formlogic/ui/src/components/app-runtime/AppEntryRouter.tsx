import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/authStore';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import NativeAppPage from '../../pages/apps/NativeAppPage';
import { AppRuntimeRoot } from './AppRuntimeRoot';
import { AppRuntimeAuthGuard } from './AppRuntimeAuthGuard';
import { startFlowDispatcher } from '../../client-runtime/flows/flowDispatcher';

function MemberNativeApp({ slug }: { slug: string }) {
  const { initialize, reset, config } = useAppRuntimeStore();
  useEffect(() => { void initialize(slug); return () => reset(); }, [slug, initialize, reset]);
  const appId = config?.app?.id;
  useEffect(() => {
    if (appId && config?.app?.slug === slug) return startFlowDispatcher(slug, { id: appId });
  }, [slug, appId, config?.app?.slug]);
  return <AppRuntimeAuthGuard><NativeAppPage /></AppRuntimeAuthGuard>;
}

function Home({ slug }: { slug: string }) {
  const userId = useAuthStore(state => state.user?.id);
  const [entry, setEntry] = useState<{ home: boolean; access?: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api.getNativeEntry(slug).then(result => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else setEntry(result.data ?? { home: false });
    });
    return () => { cancelled = true; };
  }, [slug, userId]);
  if (error) return <p role="alert" className="p-6 text-slate-800 dark:text-slate-200">{error}</p>;
  if (!entry) return <p role="status" className="p-6">Opening app…</p>;
  if (!entry.home) return <AppRuntimeRoot />;
  return entry.access === 'members' ? <MemberNativeApp slug={slug} /> : <NativeAppPage />;
}

/** The normal app URL also serves an imported website, including custom-domain launches. */
export function AppEntryRouter() {
  const { appSlug = '' } = useParams();
  const location = useLocation();
  const isHome = location.pathname.replace(/\/$/, '') === `/app/${appSlug}`;
  return isHome ? <Home key={appSlug} slug={appSlug} /> : <AppRuntimeRoot />;
}
