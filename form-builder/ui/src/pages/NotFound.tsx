import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useAuthStore } from '../stores/authStore';

export function NotFound() {
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    document.title = '404 - Page Not Found | FormLogic';
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 p-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-indigo-600/5 dark:bg-indigo-600/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="text-center max-w-md relative z-10">
        <div className="w-20 h-20 bg-primary-100 dark:bg-primary-500/10 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg shadow-primary-500/10">
          <FileQuestion className="h-10 w-10 text-primary-600 dark:text-primary-400" />
        </div>
        <h1 className="text-6xl font-bold text-gray-900 dark:text-white mb-3 tracking-tight">404</h1>
        <p className="text-lg text-gray-500 dark:text-slate-400 mb-10 leading-relaxed">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="flex items-center justify-center gap-3">
          {user ? (
            <Link to="/">
              <Button size="lg">Go to Dashboard</Button>
            </Link>
          ) : (
            <>
              <Link to="/">
                <Button size="lg">Go Home</Button>
              </Link>
              <Link to="/login">
                <Button variant="outline" size="lg">Sign In</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
