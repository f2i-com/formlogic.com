import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Dashboard, FormsList, Settings } from './pages';

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

export default function App() {
  return (
    <BrowserRouter>
      <React.Suspense fallback={<LoadingFallback />}>
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
      </React.Suspense>
    </BrowserRouter>
  );
}
