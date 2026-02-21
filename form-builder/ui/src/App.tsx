import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Dashboard, FormsList, Settings, Landing } from './pages';
import { NotFound } from './pages/NotFound';
import { useAuthStore } from './stores/authStore';
import { useFormStore } from './stores/formStore';
import { useUIStore } from './stores/uiStore';
import { useAppStore } from './stores/appStore';
import { ToastContainer } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeManager } from './components/ui/ThemeManager';

// Retry wrapper for lazy imports — handles stale chunk references after deploys
function lazyWithRetry(factory: () => Promise<{ default: React.ComponentType<any> }>) {
  return React.lazy(() =>
    factory().catch((error: Error) => {
      const isChunkError =
        error.message.includes('Failed to fetch dynamically imported module') ||
        error.message.includes('Loading chunk') ||
        error.message.includes('Loading CSS chunk');
      if (isChunkError && !sessionStorage.getItem('lazy_refresh')) {
        sessionStorage.setItem('lazy_refresh', '1');
        window.location.reload();
        return new Promise(() => {}) as never; // Suspend during reload
      }
      throw error;
    })
  );
}

// Lazy load pages for better performance
const FormBuilder = lazyWithRetry(() => import('./pages/FormBuilder'));
const FormPreview = lazyWithRetry(() => import('./pages/FormPreview'));
const FormAnalytics = lazyWithRetry(() => import('./pages/FormAnalytics'));
const FormResponse = lazyWithRetry(() => import('./pages/FormResponse'));
const FormResponses = lazyWithRetry(() => import('./pages/FormResponses'));
const Login = lazyWithRetry(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Signup = lazyWithRetry(() => import('./pages/Signup').then(m => ({ default: m.Signup })));

// Lazy load app admin pages
const AppsDashboard = lazyWithRetry(() => import('./pages/apps/AppsDashboard').then(m => ({ default: m.AppsDashboard })));
const AppCreateWizard = lazyWithRetry(() => import('./pages/apps/AppCreateWizard').then(m => ({ default: m.AppCreateWizard })));
const AppSettingsPage = lazyWithRetry(() => import('./pages/apps/AppSettings').then(m => ({ default: m.AppSettings })));
const AppFormManager = lazyWithRetry(() => import('./pages/apps/AppFormManager').then(m => ({ default: m.AppFormManager })));
const AppUserManager = lazyWithRetry(() => import('./pages/apps/AppUserManager').then(m => ({ default: m.AppUserManager })));
const AppRoleEditor = lazyWithRetry(() => import('./pages/apps/AppRoleEditor').then(m => ({ default: m.AppRoleEditor })));
const AppDeploySettings = lazyWithRetry(() => import('./pages/apps/AppDeploySettings').then(m => ({ default: m.AppDeploySettings })));
const AppRelationsManager = lazyWithRetry(() => import('./pages/apps/AppRelationsManager').then(m => ({ default: m.AppRelationsManager })));

// Lazy load app runtime
const AppRuntimeRoot = lazyWithRetry(() => import('./components/app-runtime/AppRuntimeRoot').then(m => ({ default: m.AppRuntimeRoot })));

function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 transition-colors">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
    </div>
  );
}

function AppInitializer({ children }: { children: React.ReactNode }) {
  const initializeAuth = useAuthStore((state) => state.initialize);
  const initializeForms = useFormStore((state) => state.initialize);
  const isAuthInitialized = useAuthStore((state) => state.isInitialized);
  const user = useAuthStore((state) => state.user);
  const theme = useUIStore((state) => state.theme);

  useEffect(() => {
    // Sync theme with HTML document
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  useEffect(() => {
    // Clear chunk retry flag on successful load
    sessionStorage.removeItem('lazy_refresh');
  }, []);

  // Step 1: Check for an existing session (runs once on mount)
  useEffect(() => {
    initializeAuth();
  }, [initializeAuth]);

  // Step 2: After auth resolves (or user logs in/out), sync all data stores.
  // Reads storageMode directly from the store to avoid stale closure values.
  useEffect(() => {
    if (!isAuthInitialized) return;

    if (user) {
      // User is authenticated — load their data
      const mode = useFormStore.getState().storageMode;
      if (mode === 'api') {
        // Cloud mode: always re-fetch from the server
        useFormStore.setState({ isInitialized: false });
        initializeForms();
      } else if (!useFormStore.getState().isInitialized) {
        // Local mode: initialize from localStorage (loaded by persist middleware)
        initializeForms();
      }
      // Apps are always server-backed — refresh after login
      useAppStore.getState().fetchApps();
    } else {
      // Not authenticated — clear user-specific data to prevent leakage
      const mode = useFormStore.getState().storageMode;
      if (mode === 'api') {
        // Can't reach API without auth — show empty state
        useFormStore.setState({ forms: [], isInitialized: true, isLoading: false });
      } else if (!useFormStore.getState().isInitialized) {
        // Local mode: load whatever is in localStorage
        initializeForms();
      }
      // Clear server-backed stores
      useAppStore.setState({ apps: [], activeAppId: null });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthInitialized, user?.id, initializeForms]);

  // Show loading while initializing
  if (!isAuthInitialized) {
    return <LoadingFallback />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  const user = useAuthStore((state) => state.user);

  // Show landing page when not authenticated
  if (!user) {
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        {/* Public form response route - accessible without auth */}
        <Route path="/form/:formId" element={<FormResponse />} />
        {/* App runtime - accessible with platform auth */}
        <Route path="/app/:appSlug/*" element={<AppRuntimeRoot />} />
        {/* 404 catch-all */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    );
  }

  // Show app when authenticated
  return (
    <Routes>
      {/* Main app routes with sidebar */}
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/forms" element={<FormsList />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/analytics/:formId" element={<FormAnalytics />} />
        <Route path="/responses/:formId" element={<FormResponses />} />
        {/* App admin routes */}
        <Route path="/apps" element={<AppsDashboard />} />
        <Route path="/apps/new" element={<AppCreateWizard />} />
        <Route path="/apps/:appId/settings" element={<AppSettingsPage />} />
        <Route path="/apps/:appId/forms" element={<AppFormManager />} />
        <Route path="/apps/:appId/users" element={<AppUserManager />} />
        <Route path="/apps/:appId/roles" element={<AppRoleEditor />} />
        <Route path="/apps/:appId/relations" element={<AppRelationsManager />} />
        <Route path="/apps/:appId/deploy" element={<AppDeploySettings />} />
      </Route>

      {/* Redirect authenticated users from auth pages */}
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/signup" element={<Navigate to="/" replace />} />

      {/* Builder route (full screen, no sidebar) */}
      <Route path="/builder/:formId" element={<FormBuilder />} />

      {/* Preview route (full screen) */}
      <Route path="/preview/:formId" element={<FormPreview />} />

      {/* Public form response route */}
      <Route path="/form/:formId" element={<FormResponse />} />

      {/* App runtime (full screen, separate layout) */}
      <Route path="/app/:appSlug/*" element={<AppRuntimeRoot />} />

      {/* 404 catch-all */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppInitializer>
          <ThemeManager />
          <React.Suspense fallback={<LoadingFallback />}>
            <AppRoutes />
          </React.Suspense>
          <ToastContainer />
        </AppInitializer>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
