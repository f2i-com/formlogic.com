import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { useAuthStore } from '../stores/authStore';

export function NotFound() {
  const user = useAuthStore((state) => state.user);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950 p-4">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 bg-primary-100 dark:bg-primary-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <FileQuestion className="h-8 w-8 text-primary-600 dark:text-primary-400" />
        </div>
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">404</h1>
        <p className="text-lg text-gray-500 dark:text-slate-400 mb-8">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="flex items-center justify-center gap-3">
          {user ? (
            <Link to="/">
              <Button>Go to Dashboard</Button>
            </Link>
          ) : (
            <>
              <Link to="/">
                <Button>Go Home</Button>
              </Link>
              <Link to="/login">
                <Button variant="outline">Sign In</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
