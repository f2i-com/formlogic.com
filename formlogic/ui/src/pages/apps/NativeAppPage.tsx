import { useParams } from 'react-router-dom';
import { NativeAppView } from '../../components/studio/NativeAppView';

/** An installed native app at its own address, full screen. */
export default function NativeAppPage() {
  const { appSlug = '' } = useParams();
  return <main className="h-dvh bg-slate-50 p-2 dark:bg-slate-950"><NativeAppView slug={appSlug} /></main>;
}
