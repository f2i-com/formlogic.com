import { useParams } from 'react-router-dom';
import { NativeAppView } from '../../components/studio/NativeAppView';

/**
 * An installed native app at its own address, full screen. The frame is sandboxed and has no
 * safe areas of its own, so this page keeps it clear of a phone's notch and home bar.
 */
export default function NativeAppPage({ slug, signInTo }: { slug?: string; signInTo?: string }) {
  const { appSlug = '' } = useParams();
  return (
    <main className="h-dvh bg-white pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] dark:bg-slate-950">
      <NativeAppView slug={slug ?? appSlug} fullScreen signInTo={signInTo} />
    </main>
  );
}
