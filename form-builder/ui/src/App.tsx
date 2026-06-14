import React, { useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, matchPath } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Dashboard, FormsList, Settings, Landing } from './pages';
import { NotFound } from './pages/NotFound';
import { LegalPage } from './pages/LegalPage';
import { AcceptInvite } from './pages/AcceptInvite';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
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
      // Use a timestamp to prevent infinite reload loops: only retry once
      // within a 30-second window
      const lastRefresh = Number(sessionStorage.getItem('lazy_refresh') || '0');
      if (isChunkError && Date.now() - lastRefresh > 30_000) {
        sessionStorage.setItem('lazy_refresh', String(Date.now()));
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

// Lazy load pack marketplace pages
const PackGalleryPage = lazyWithRetry(() => import('./pages/PackGalleryPage'));
const PackDetailPage = lazyWithRetry(() => import('./pages/PackDetailPage'));

/** Error boundary that auto-resets when the user navigates to a different route */
function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary key={location.pathname}>
      {children}
    </ErrorBoundary>
  );
}

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
    // Clear chunk retry timestamp on successful load so future deploys can retry
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

// Routes that render for logged-out users. When a user logs out (or their session
// expires), AppRoutes swaps to the logged-out route table — so any authed-only URL
// they were sitting on (e.g. /forms) would fall through to the 404 page. This sends
// them home instead, while leaving them in place on genuinely public routes (a
// shared /form/:id link, an /app/:slug runtime, legal/marketing pages, etc.).
const PUBLIC_PATHS = [
  '/',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/accept-invite',
  '/form/:formId',
  '/packs',
  '/packs/:slug',
  '/privacy',
  '/terms',
  '/app/:appSlug/*',
];

function AuthRedirector() {
  const user = useAuthStore((state) => state.user);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const navigate = useNavigate();
  const location = useLocation();
  const wasAuthed = useRef(false);

  useEffect(() => {
    if (!isInitialized) return;
    const justLoggedOut = wasAuthed.current && !user;
    wasAuthed.current = !!user;
    if (justLoggedOut && !PUBLIC_PATHS.some((pattern) => matchPath(pattern, location.pathname))) {
      navigate('/', { replace: true });
    }
  }, [user, isInitialized, location.pathname, navigate]);

  return null;
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
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        {/* App invitation acceptance (prompts sign-in if needed) */}
        <Route path="/accept-invite" element={<AcceptInvite />} />
        {/* Public form response route - accessible without auth */}
        <Route path="/form/:formId" element={<FormResponse />} />
        {/* Pack marketplace (public) */}
        <Route path="/packs" element={<PackGalleryPage />} />
        <Route path="/packs/:slug" element={<PackDetailPage />} />
        {/* Legal (public) */}
        <Route path="/privacy" element={<LegalPage type="privacy" />} />
        <Route path="/terms" element={<LegalPage type="terms" />} />
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
      {/* App invitation acceptance (logged-in users) */}
      <Route path="/accept-invite" element={<AcceptInvite />} />
      {/* Logged-in users shouldn't reach password reset; send them home */}
      <Route path="/forgot-password" element={<Navigate to="/" replace />} />
      <Route path="/reset-password" element={<Navigate to="/" replace />} />

      {/* Builder route (full screen, no sidebar) */}
      <Route path="/builder/:formId" element={<FormBuilder />} />

      {/* Preview route (full screen) */}
      <Route path="/preview/:formId" element={<FormPreview />} />

      {/* Pack marketplace */}
      <Route path="/packs" element={<PackGalleryPage />} />
      <Route path="/packs/:slug" element={<PackDetailPage />} />

      {/* Legal (full screen) */}
      <Route path="/privacy" element={<LegalPage type="privacy" />} />
      <Route path="/terms" element={<LegalPage type="terms" />} />

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
          <AuthRedirector />
          <RouteErrorBoundary>
            <React.Suspense fallback={<LoadingFallback />}>
              <AppRoutes />
            </React.Suspense>
          </RouteErrorBoundary>
          <ToastContainer />
        </AppInitializer>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
