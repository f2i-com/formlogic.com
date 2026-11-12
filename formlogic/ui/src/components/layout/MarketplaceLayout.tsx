import type { ReactNode } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { Header } from './Header';
import { LandingNav } from '../landing-v2/LandingNav';
import { LandingFooter } from '../landing-v2/LandingFooter';

/** Shared catalogue chrome, including loading and unavailable-detail states.
    Signed in, the catalogue is a workspace page: the three optional props are that page's
    Header (its name, its way back, its actions). Nobody signed in sees the public site's
    navigation and footer, and the props are not used. */
export function MarketplaceLayout({ children, title = 'Templates', back, actions }: {
  children: ReactNode;
  title?: string;
  back?: { onClick: () => void; label?: string };
  actions?: ReactNode;
}) {
  const signedIn = useAuthStore(state => !!state.user);
  return signedIn ? (
    <div className="@container/packs min-h-screen bg-gray-50 text-gray-900 dark:bg-slate-950 dark:text-slate-50">
      <Header title={title} back={back} actions={actions} />
      {children}
    </div>
  ) : (
    <div className="lv2 fl-marketplace @container/packs min-h-screen overflow-x-clip bg-white text-gray-900 dark:bg-slate-950 dark:text-slate-50">
      <a href="#marketplace-content" className="fl-skip">Skip to templates</a>
      <LandingNav />
      <main id="marketplace-content">{children}</main>
      <LandingFooter />
    </div>
  );
}
