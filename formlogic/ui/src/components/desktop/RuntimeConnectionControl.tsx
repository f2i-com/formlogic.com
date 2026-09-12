import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Monitor } from 'lucide-react';
import { getOaiyStatus, subscribeOaiyStatus } from '../../client-runtime/oaiy/oaiyDetection';
import { isOaiyPaired, subscribeOaiyPaired } from '../../client-runtime/oaiy/oaiyRuntime';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { pathClaimsBottomEdge } from '../../lib/bottomEdgeClaim';
import { cn } from '../../lib/utils';
import { DesktopConnectionPopover } from './DesktopConnectionPopover';

/** OAIY has its own transport and pairing; never route it through legacy desktop controls. */
export function RuntimeConnectionControl() {
  const isDemo = useAuthStore(s => !!s.user?.isDemo);
  const isMobile = useUIStore(s => s.isMobile);
  const collapsed = useUIStore(s => s.sidebarCollapsed);
  const [oaiy, setOaiy] = useState(getOaiyStatus);
  const [paired, setPaired] = useState(isOaiyPaired);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (isDemo) return;
    const stopDetection = subscribeOaiyStatus(setOaiy);
    const stopPairing = subscribeOaiyPaired(setPaired);
    return () => { stopDetection(); stopPairing(); };
  }, [isDemo]);
  if (isDemo || !oaiy.available) return <DesktopConnectionPopover />;
  if (isMobile && pathClaimsBottomEdge(pathname)) return null;
  const label = paired ? 'OAIY connected' : 'Connect OAIY';
  return <button type="button" aria-label={`Desktop connection: ${label}`}
    onClick={() => navigate('/settings#local-runtime')}
    className={cn('fixed z-40 flex min-h-9 items-center gap-2 rounded-full border border-gray-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-gray-700 shadow-lg backdrop-blur transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-200 dark:hover:bg-slate-800',
      isMobile ? 'left-4 bottom-[var(--fl-mobile-float)]' : cn('bottom-4', collapsed ? 'left-[4.75rem]' : 'left-[16.75rem]'))}>
    <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', paired ? 'bg-emerald-500' : 'bg-amber-500')} />
    <Monitor className="h-3.5 w-3.5" aria-hidden="true" />{label}
  </button>;
}
