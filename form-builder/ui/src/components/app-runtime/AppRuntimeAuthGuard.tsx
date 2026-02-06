import { useAppRuntimeStore } from '../../stores/appRuntimeStore';

interface AppRuntimeAuthGuardProps {
  children: React.ReactNode;
}

export function AppRuntimeAuthGuard({ children }: AppRuntimeAuthGuardProps) {
  const { config, isLoading, error } = useAppRuntimeStore();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-current app-text-primary" />
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
          <p className="text-gray-500 mb-4">{error || 'Unable to load app. You may not have access.'}</p>
          <a href="/" className="text-sm app-text-primary hover:underline">Go to Home</a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
