// A SoftN app's automations, on the app's own page: the flows that run when a record in one of
// its tables is added, changed or removed, or on a schedule. The same section the App Studio shows
// a forms app (its list of flows, each one's triggers and steps, and the table triggers), reached
// here so a SoftN app's owner never has to open the studio for it.
import { useCallback, useEffect, useState } from 'react';
import { AutomationsStep } from '../studio/steps/AutomationsStep';
import { LoadFailure } from '../ui/LoadFailure';
import { api } from '../../lib/api';
import { softnWorkspacePath } from '../../lib/softnApps';
import type { App } from '../../types/app';
import type { FlowBinding, FlowDefinition } from '../../types/flows';

const NO_FORMS: never[] = [];
const NO_FORMS_BY_ID = {};
type Loaded = { flows: FlowDefinition[]; bindings: FlowBinding[] };

export function SoftnAutomations({ app }: { app: App }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The app's flows and what starts them, or null when either could not be read: a failed read is
  // not "no automations" (the page would invite making one that already exists).
  const read = useCallback(async (): Promise<Loaded | null> => {
    const [flows, bindings] = await Promise.all([api.listFlows(app.id), api.listFlowBindings(app.id)]);
    if (flows.error || bindings.error) return null;
    return { flows: (flows.data?.flows ?? []) as FlowDefinition[], bindings: (bindings.data?.bindings ?? []) as FlowBinding[] };
  }, [app.id]);
  useEffect(() => {
    let current = true;
    void read().then((next) => {
      if (!current) return;
      setFailed(next === null);
      if (next) setLoaded(next);
    });
    return () => { current = false; };
  }, [read, attempt]);
  // After a change made here: what is shown stays until the new answer is in, and a failed read keeps it.
  const reload = useCallback(async () => {
    const next = await read();
    if (next) setLoaded(next);
  }, [read]);

  if (failed && !loaded) {
    return <div className="mt-4"><LoadFailure compact title="The app’s automations could not be loaded" onRetry={() => { setFailed(false); setAttempt(n => n + 1); }} /></div>;
  }
  if (!loaded) return <p role="status" className="mt-6 text-sm text-slate-500 dark:text-slate-400">Loading automations…</p>;
  return (
    // The section sizes its columns off this container, as it does in the studio.
    <div className="mt-4 @container/studio" data-testid="softn-automations">
      <p className="mb-4 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-300">
        An automation is a flow that runs by itself: when a record in one of this app&rsquo;s tables is added, changed or removed, or at a set time.
        It can send an email or a notification, call another service, or ask an AI.
      </p>
      <AutomationsStep app={app} flows={loaded.flows} bindings={loaded.bindings} appForms={NO_FORMS} formsById={NO_FORMS_BY_ID}
        onReloadFlows={reload} returnTo={{ path: softnWorkspacePath(app.id, 'automations'), label: app.name }} />
    </div>
  );
}
