import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { NativeAppView } from '../../components/studio/NativeAppView';
import type { NativeLook } from '../../lib/appLook';

/**
 * An installed native app at its own address, full screen. The frame is sandboxed and has no
 * safe areas of its own, so this page keeps it clear of a phone's notch and home bar, in the app's
 * loading background where it has one. `onDomain`: the page is the app's own domain.
 */
export default function NativeAppPage({ slug, signInTo, onDomain = false }: { slug?: string; signInTo?: string; onDomain?: boolean }) {
  const { appSlug = '' } = useParams();
  const [background, setBackground] = useState<string | null>(null);
  const onLook = useCallback((look: NativeLook | null) => setBackground(look?.background ?? null), []);
  return (
    <main
      className={`h-dvh ${background ? '' : 'bg-white dark:bg-slate-950'} pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]`}
      style={background ? { background } : undefined}
    >
      <NativeAppView slug={slug ?? appSlug} fullScreen onDomain={onDomain} onLook={onLook} signInTo={signInTo} />
    </main>
  );
}
