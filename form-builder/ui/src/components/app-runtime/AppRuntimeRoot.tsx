import { useEffect } from 'react';
import { Routes, Route, useParams } from 'react-router-dom';
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
          </Routes>
        </AppRuntimeShell>
      </AppRuntimeAuthGuard>
    </AppRuntimeThemeProvider>
  );
}
