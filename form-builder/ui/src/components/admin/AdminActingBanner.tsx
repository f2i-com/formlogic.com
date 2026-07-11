import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import type { AdminActing } from './AdminActingContext';

/**
 * The always-visible "you are acting as a platform admin" bar above a reused
 * owner UI. Sets the same --fl-demo-banner-h CSS variable the demo banner uses
 * so full-height pages (FlowsWorkspace's 100dvh calc) fit without layout edits
 * — the two can never collide because the demo account is never an admin.
 */
export function AdminActingBanner({ acting }: { acting: AdminActing }) {
  const navigate = useNavigate();

  useEffect(() => {
    const root = document.documentElement;
    const prev = root.style.getPropertyValue('--fl-demo-banner-h');
    root.style.setProperty('--fl-demo-banner-h', '36px');
    return () => {
      if (prev) root.style.setProperty('--fl-demo-banner-h', prev);
      else root.style.removeProperty('--fl-demo-banner-h');
    };
  }, []);

  return (
    <div className="sticky top-0 z-[60] flex h-9 items-center justify-between gap-3 bg-amber-500 px-3 text-sm text-amber-950 dark:bg-amber-400">
      <p className="min-w-0 truncate flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        <span className="truncate">
          Acting as platform admin on <strong>{acting.ownerEmail}</strong>&apos;s account — record data is hidden; changes are live for the owner.
        </span>
      </p>
      <button
        type="button"
        onClick={() => navigate(`/admin/users/${acting.ownerId}`)}
        className="shrink-0 rounded-md bg-amber-950/10 px-2.5 py-1 text-xs font-semibold hover:bg-amber-950/20"
      >
        Exit
      </button>
    </div>
  );
}
