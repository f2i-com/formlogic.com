import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { HostedDeployment } from '../../lib/hosting';
import { HostedAppFrame } from '../studio/HostedAppFrame';

export function HostedDashboardHome({ slug }: { slug: string }) {
  const [deployment, setDeployment] = useState<HostedDeployment | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api.getHostedRuntime(slug).then(result => {
      if (!active) return;
      if (result.error) setError(result.error);
      else setDeployment(result.data?.deployment || null);
    });
    return () => { active = false; };
  }, [slug]);
  if (error) return <p role="alert" className="p-6 text-sm text-red-600">{error} Open App Studio to review the hosted project, or use the app menu to reach your forms.</p>;
  if (!deployment) return <p role="status" className="p-6 text-sm">Opening your dashboard…</p>;
  return <div className="h-[calc(100dvh-140px)] min-h-[520px]"><HostedAppFrame slug={slug} client={deployment.client} version={deployment.version} /></div>;
}
