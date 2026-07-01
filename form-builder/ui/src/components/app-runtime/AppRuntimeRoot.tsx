import { useEffect } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { AppRuntimeThemeProvider } from './AppRuntimeThemeProvider';
import { AppRuntimeAuthGuard } from './AppRuntimeAuthGuard';
import { AppRuntimeShell } from './AppRuntimeShell';
import { AppHomeScreen } from './AppHomeScreen';
import { AppFormView } from './AppFormView';
import { AppDataTable } from './AppDataTable';
import { AppRecordsBrowser } from './AppRecordsBrowser';
import { AppReports } from './AppReports';
import { AppResponseDetail } from './AppResponseDetail';
import { AppAnalytics } from './AppAnalytics';
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
    const prevCross = link?.getAttribute('crossorigin') ?? null;
    if (link) {
      link.setAttribute('href', manifestHref);
      // The per-app manifest is cross-origin (API host) and the endpoint returns
      // ACAO + Allow-Credentials, so fetch it credentialed — otherwise the browser
      // can't read the cross-origin manifest and won't offer install.
      link.setAttribute('crossorigin', 'use-credentials');
    }

    // White-label the iOS home-screen icon (iOS uses apple-touch-icon over the
    // manifest icons), so an installed deployed app shows the app's own logo.
    const touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    const prevTouch = touch?.getAttribute('href') ?? null;
    if (touch && config?.app?.logoUrl) touch.setAttribute('href', config.app.logoUrl);

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
      if (link && prevManifest) {
        link.setAttribute('href', prevManifest);
        if (prevCross === null) link.removeAttribute('crossorigin');
        else link.setAttribute('crossorigin', prevCross);
      }
      if (touch && prevTouch) touch.setAttribute('href', prevTouch);
      if (meta && prevTheme !== null) meta.setAttribute('content', prevTheme);
    };
  }, [appSlug, config]);

  // Set the tab title to the app's own name (no "· FormLogic" suffix — these
  // runtimes are white-labeled), restoring the platform title on the way out.
  useEffect(() => {
    const name = config?.app?.name;
    if (!name) return;
    const prev = document.title;
    document.title = name;
    return () => { document.title = prev; };
  }, [config?.app?.name]);

  return (
    <AppRuntimeThemeProvider theme={config?.app?.theme}>
      <AppRuntimeAuthGuard>
        <AppRuntimeShell>
          <Routes>
            <Route path="/" element={<AppHomeScreen />} />
            <Route path="/records" element={<AppRecordsBrowser />} />
            <Route path="/reports" element={<AppReports />} />
            <Route path="/form/:formId" element={<AppFormView />} />
            <Route path="/form/:formId/responses" element={<AppDataTable />} />
            <Route path="/form/:formId/responses/:responseId" element={<AppResponseDetail />} />
            <Route path="/form/:formId/analytics" element={<AppAnalytics />} />
            <Route path="/profile" element={<AppUserProfile />} />
            <Route path="*" element={<Navigate to="." replace />} />
          </Routes>
        </AppRuntimeShell>
      </AppRuntimeAuthGuard>
    </AppRuntimeThemeProvider>
  );
}
