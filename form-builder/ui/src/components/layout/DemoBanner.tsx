import { useNavigate } from 'react-router-dom';
import { Sparkles, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';

/**
 * Slim banner shown across the top of the content area while the visitor is exploring as the shared
 * public "Demo" account. Both actions end the demo session (signup + the marketing site are
 * logged-out routes) and take the visitor where they asked. Renders nothing for real accounts.
 */
export function DemoBanner() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  if (!user?.isDemo) return null;

  // Signup and the marketing landing are logged-out routes, so leave the demo first.
  const go = async (path: string) => {
    await logout();
    navigate(path);
  };

  return (
    <div className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-gradient-to-r from-primary-600 to-primary-700 px-4 py-2 text-center text-sm text-primary-foreground">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Sparkles className="h-4 w-4" />
        You're exploring the live demo — changes are shared and reset periodically.
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => go('/signup')}
          className="cursor-pointer rounded-lg bg-white px-3 py-1 text-xs font-semibold text-primary-700 transition hover:bg-white/90"
        >
          Sign up free
        </button>
        <button
          type="button"
          onClick={() => go('/')}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-white/30 px-2.5 py-1 text-xs font-medium text-primary-foreground/90 transition hover:bg-white/10"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to site
        </button>
      </span>
    </div>
  );
}
