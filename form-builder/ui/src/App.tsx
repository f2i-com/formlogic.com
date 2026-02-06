import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Dashboard, FormsList, Settings, Landing } from './pages';
import { useAuthStore } from './stores/authStore';
import { useFormStore } from './stores/formStore';
import { useUIStore } from './stores/uiStore';
import { ToastContainer } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeManager } from './components/ui/ThemeManager';

// Lazy load pages for better performance
const FormBuilder = React.lazy(() => import('./pages/FormBuilder'));
const FormPreview = React.lazy(() => import('./pages/FormPreview'));
const FormAnalytics = React.lazy(() => import('./pages/FormAnalytics'));
const FormResponse = React.lazy(() => import('./pages/FormResponse'));
const FormResponses = React.lazy(() => import('./pages/FormResponses'));
const Login = React.lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const Signup = React.lazy(() => import('./pages/Signup').then(m => ({ default: m.Signup })));

// Lazy load app admin pages
const AppsDashboard = React.lazy(() => import('./pages/apps/AppsDashboard').then(m => ({ default: m.AppsDashboard })));
const AppCreateWizard = React.lazy(() => import('./pages/apps/AppCreateWizard').then(m => ({ default: m.AppCreateWizard })));
const AppSettingsPage = React.lazy(() => import('./pages/apps/AppSettings').then(m => ({ default: m.AppSettings })));
const AppFormManager = React.lazy(() => import('./pages/apps/AppFormManager').then(m => ({ default: m.AppFormManager })));
const AppUserManager = React.lazy(() => import('./pages/apps/AppUserManager').then(m => ({ default: m.AppUserManager })));
const AppRoleEditor = React.lazy(() => import('./pages/apps/AppRoleEditor').then(m => ({ default: m.AppRoleEditor })));
const AppDeploySettings = React.lazy(() => import('./pages/apps/AppDeploySettings').then(m => ({ default: m.AppDeploySettings })));
const AppRelationsManager = React.lazy(() => import('./pages/apps/AppRelationsManager').then(m => ({ default: m.AppRelationsManager })));

// Lazy load app runtime
const AppRuntimeRoot = React.lazy(() => import('./components/app-runtime/AppRuntimeRoot').then(m => ({ default: m.AppRuntimeRoot })));

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
    // Initialize auth first, then forms
    initializeAuth()
      .then(() => {
        initializeForms();
      })
      .catch((error) => {
        console.error('Failed to initialize app:', error);
        initializeForms();
      });
  }, [initializeAuth, initializeForms]);

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
        {/* Redirect all other routes to landing */}
        <Route path="*" element={<Navigate to="/" replace />} />
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

      {/* Builder route (full screen, no sidebar) */}
      <Route path="/builder/:formId" element={<FormBuilder />} />

      {/* Preview route (full screen) */}
      <Route path="/preview/:formId" element={<FormPreview />} />

      {/* Public form response route */}
      <Route path="/form/:formId" element={<FormResponse />} />

      {/* App runtime (full screen, separate layout) */}
      <Route path="/app/:appSlug/*" element={<AppRuntimeRoot />} />
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
