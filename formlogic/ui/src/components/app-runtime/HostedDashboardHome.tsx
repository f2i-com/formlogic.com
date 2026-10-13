import { useHostedRuntime } from '../../lib/useHostedRuntime';
import { HostedAppFrame } from '../studio/HostedAppFrame';

export function HostedDashboardHome({ slug }: { slug: string }) {
  const { deployment, engine, error, admission } = useHostedRuntime(slug) || {};
  if (error) return <p role="alert" className="p-6 text-sm text-red-600">{error} Open App Studio to review the hosted project, or use the app menu to reach your forms.</p>;
  if (!deployment || !admission) return <p role="status" className="p-6 text-sm">Opening your dashboard.</p>;
  return <div className="h-[calc(100dvh-140px)] min-h-[520px]"><HostedAppFrame slug={slug} client={deployment.client} version={deployment.version} engine={engine} hostedAdmission={admission} /></div>;
}
