// The Members section of a SoftN app's own page: who can use the app, the invitations out to
// others, and how people join. It was reached by leaving the app's page for App Studio, which
// opened on roles for form records; a SoftN app's owner comes here to invite someone.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, Lock } from 'lucide-react';
import { PeopleView, SignupView } from '../studio/steps/AccessStep';
import { LoadFailure } from '../ui/LoadFailure';
import { api } from '../../lib/api';
import { softnWorkspacePath } from '../../lib/softnApps';
import type { NativeProject } from '../../lib/nativeHosting';
import type { App, AppRole } from '../../types/app';

const link = 'font-medium text-primary-600 underline-offset-2 hover:underline dark:text-primary-300';

export function SoftnMembers({ app, project, onReloadApp }: { app: App; project: NativeProject; onReloadApp: () => Promise<void> }) {
  // Roles name what each member is; a failed read is not "no roles" (the pickers would empty).
  const [roles, setRoles] = useState<AppRole[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void api.getAppRoles(app.id).then((res) => {
      if (!current) return;
      if (res.error) { setFailed(true); return; }
      setFailed(false);
      setRoles((res.data?.roles ?? []) as AppRole[]);
    });
    return () => { current = false; };
  }, [app.id, attempt]);
  const retry = useCallback(() => { setFailed(false); setAttempt((n) => n + 1); }, []);

  const membersOnly = project.access === 'members';
  const Icon = membersOnly ? Lock : Globe;

  return (
    <div className="mt-4 space-y-4 @container/studio" data-testid="softn-members">
      {/* Who the list below is for, said once, with the way to change it. */}
      <p className="flex items-start gap-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
        <Icon className="mt-1 h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
        <span>
          {membersOnly
            ? 'Only the people here can use this app. They sign in to this site as its members.'
            : 'Anyone with the link can use this app. The people here are the ones you have invited to sign in to it.'}
          {' '}
          <Link to={`${softnWorkspacePath(app.id, 'settings')}#settings-access`} className={link}>Change who can use it</Link>
        </span>
      </p>

      {failed && <LoadFailure compact title="The app’s members could not be loaded" onRetry={retry} />}
      {!failed && roles === null && <p role="status" className="text-sm text-slate-500 dark:text-slate-400">Loading members…</p>}
      {roles !== null && !failed && <>
        <PeopleView app={app} roles={roles} returnLabel="Members" />
        <SignupView app={app} roles={roles} onReloadApp={onReloadApp} peopleName="the list above" />
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          Each member has a role. <Link to={`/apps/${app.id}/studio/access`} className={link}>Roles and what each may do</Link> are set in App Studio.
        </p>
      </>}
    </div>
  );
}
