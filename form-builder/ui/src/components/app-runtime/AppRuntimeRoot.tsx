import { useEffect } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { AppRuntimeThemeProvider } from './AppRuntimeThemeProvider';
import { AppRuntimeAuthGuard } from './AppRuntimeAuthGuard';
import { AppRuntimeShell } from './AppRuntimeShell';
import { AppDashboard } from './AppDashboard';
import { AppFormView } from './AppFormView';
import { AppDataTable } from './AppDataTable';
import { AppResponseDetail } from './AppResponseDetail';
import { AppUserProfile } from './AppUserProfile';

export function AppRuntimeRoot() {
  const { appSlug } = useParams();
  const { initialize, config, reset } = useAppRuntimeStore();

  useEffect(() => {
    if (appSlug) {
      initialize(appSlug);
    }
    return () => {
      reset();
    };
  }, [appSlug, initialize, reset]);

  // Point the browser at THIS app's dynamic manifest + theme-color so an
  // installed PWA uses the owner-configured install name/theme instead of the
  // generic platform identity. Same-origin '/api' keeps start_url/scope valid.
  // Restores the platform manifest/theme-color when leaving the runtime.
  useEffect(() => {
    if (!appSlug) return;
    const apiBase = import.meta.env.VITE_API_URL || '/api';
    const manifestHref = `${apiBase}/app/${appSlug}/manifest.json`;

    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const prevManifest = link?.getAttribute('href') ?? null;
    if (link) link.setAttribute('href', manifestHref);

    const themeColor = config?.app?.settings?.pwaThemeColor || config?.app?.theme?.primaryColor;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const prevTheme = meta?.getAttribute('content') ?? null;
    if (themeColor) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', themeColor);
    }

    return () => {
      if (link && prevManifest) link.setAttribute('href', prevManifest);
      if (meta && prevTheme !== null) meta.setAttribute('content', prevTheme);
    };
  }, [appSlug, config]);

  return (
    <AppRuntimeThemeProvider theme={config?.app?.theme}>
      <AppRuntimeAuthGuard>
        <AppRuntimeShell>
          <Routes>
            <Route path="/" element={<AppDashboard />} />
            <Route path="/form/:formId" element={<AppFormView />} />
            <Route path="/form/:formId/responses" element={<AppDataTable />} />
            <Route path="/form/:formId/responses/:responseId" element={<AppResponseDetail />} />
            <Route path="/profile" element={<AppUserProfile />} />
            <Route path="*" element={<Navigate to="." replace />} />
          </Routes>
        </AppRuntimeShell>
      </AppRuntimeAuthGuard>
    </AppRuntimeThemeProvider>
  );
}
