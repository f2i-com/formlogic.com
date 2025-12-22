import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Dashboard, FormsList, Settings, Landing } from './pages';
import { useAuthStore } from './stores/authStore';
import { useFormStore } from './stores/formStore';

// Lazy load builder and preview pages for better performance
const FormBuilder = React.lazy(() => import('./pages/FormBuilder'));
const FormPreview = React.lazy(() => import('./pages/FormPreview'));
const FormAnalytics = React.lazy(() => import('./pages/FormAnalytics'));
const FormResponse = React.lazy(() => import('./pages/FormResponse'));

function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
    </div>
  );
}

function AppInitializer({ children }: { children: React.ReactNode }) {
  const initializeAuth = useAuthStore((state) => state.initialize);
  const initializeForms = useFormStore((state) => state.initialize);
  const isAuthInitialized = useAuthStore((state) => state.isInitialized);

  useEffect(() => {
    // Initialize auth first, then forms
    initializeAuth().then(() => {
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
        {/* Public form response route - accessible without auth */}
        <Route path="/form/:formId" element={<FormResponse />} />
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
      </Route>

      {/* Builder route (full screen, no sidebar) */}
      <Route path="/builder/:formId" element={<FormBuilder />} />

      {/* Preview route (full screen) */}
      <Route path="/preview/:formId" element={<FormPreview />} />

      {/* Public form response route */}
      <Route path="/form/:formId" element={<FormResponse />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppInitializer>
        <React.Suspense fallback={<LoadingFallback />}>
          <AppRoutes />
        </React.Suspense>
      </AppInitializer>
    </BrowserRouter>
  );
}
