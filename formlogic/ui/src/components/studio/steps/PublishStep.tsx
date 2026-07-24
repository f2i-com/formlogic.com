import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  GitBranch,
  Globe2,
  History,
  Rocket,
  Settings,
  Workflow,
} from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { Modal } from '../../ui/Modal';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { useAppStore } from '../../../stores/appStore';
import { useAuthStore } from '../../../stores/authStore';
import { isDemoLocalId } from '../../../lib/demoLocal';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { buildPreflightChecks, type StudioStepId, type UnpublishedChanges } from '../studioSteps';
import { returnToState } from '../../../hooks/useReturnTo';
import type { App, AppForm, AppRole, AppVersion } from '../../../types/app';
import type { AppDomain } from '../../../lib/api';
import type { Form } from '../../../types/form';
import type { FlowDefinition } from '../../../types/flows';

/**
 * Studio step 6 — Review & publish: a real preflight over the app's state, the
 * versioned publish flow (status + version bump + history server-side), the
 * live link, and publish history.
 */
export function PublishStep({
  app,
  appForms,
  formsById,
  flows,
  roles,
  domains,
  versions,
  memberCount,
  changes,
  onStepChange,
  onPublished,
}: {
  app: App;
  appForms: AppForm[];
  formsById: Record<string, Form>;
  flows: FlowDefinition[];
  roles: AppRole[];
  domains: AppDomain[];
  versions: AppVersion[];
  memberCount: number;
  changes: UnpublishedChanges;
  onStepChange: (step: StudioStepId) => void;
  onPublished: () => Promise<void>;
}) {
  const navigate = useNavigate();
  // Deploy/domain settings return here via their Back buttons.
  const studioReturn = returnToState(`/apps/${app.id}/studio/publish`, 'App Studio');
  const updateApp = useAppStore((s) => s.updateApp);
  const fetchApps = useAppStore((s) => s.fetchApps);
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const browserOnlyDemo = isDemo && isDemoLocalId(app.id);
  const seededDemoReadOnly = isDemo && !browserOnlyDemo;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showUnpublish, setShowUnpublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [justPublished, setJustPublished] = useState<number | null>(null);

  const appUrl = `${window.location.origin}/app/${app.slug}`;
  const published = app.status === 'published';
  const currentVersion = app.publishedVersion ?? 0;
  const nextVersion = currentVersion + 1;
  const legacyPublished = published && !changes.everPublished;
  const hasChanges = !published || (changes.everPublished && changes.count > 0);

  const checks = useMemo(() => {
    // Landing pages that target a FORM must still point at an attached form —
    // 'dashboard' (and other non-form values) are always valid.
    const landing = (app.settings as { landingPage?: string } | undefined)?.landingPage;
    const landingPageMissing =
      !!landing && landing !== 'dashboard' && landing !== 'records' && !appForms.some((af) => af.formId === landing);
    const settings = app.settings as { allowSelfRegistration?: boolean; defaultRoleId?: string } | undefined;
    const preflight = buildPreflightChecks({
      formCount: appForms.length,
      formsWithoutFields: appForms
        .filter((af) => (formsById[af.formId]?.fields.length ?? 1) === 0)
        .map((af) => af.displayName || formsById[af.formId]?.title || 'Untitled'),
      flowCount: flows.length,
      activeFlowCount: flows.filter((f) => f.enabled).length,
      roleCount: roles.length,
      hasHomeScreen: !!(app.customScreen as { kind?: string } | undefined)?.kind,
      hasCustomDomain: domains.some((d) => d.status === 'active'),
      memberCount,
      landingPageMissing,
      signupWithoutDefaultRole: settings?.allowSelfRegistration === true && !settings?.defaultRoleId,
      // Identity = a curated icon (settings.icon) or an uploaded logo (theme.logoUrl).
      hasIcon: !!(app.settings?.icon || app.theme?.logoUrl),
    });
    return browserOnlyDemo ? preflight.filter((check) => check.id !== 'members') : preflight;
  }, [app.settings, app.customScreen, app.theme?.logoUrl, appForms, formsById, flows, roles, domains, memberCount, browserOnlyDemo]);
  const warnings = checks.filter((c) => c.state === 'warning');
  const blocking = warnings.filter((c) => c.severity === 'blocking');

  const doPublish = async (label: string) => {
    if (publishing) return;
    setPublishing(true);
    const res = await api.publishApp(app.id, label.trim() || undefined);
    setPublishing(false);
    if (res.error || !res.data) {
      toast.error('Publish failed', typeof res.error === 'string' ? res.error : 'Could not publish the app.');
      return;
    }
    setDialogOpen(false);
    setJustPublished(res.data.version);
    window.setTimeout(() => setJustPublished(null), 5000);
    toast.success(
      `Version ${res.data.version} is live`,
      browserOnlyDemo
        ? 'This browser-only preview now serves your latest changes.'
        : 'The published app now serves your latest changes.',
    );
    await Promise.all([onPublished(), fetchApps()]);
  };

  const doUnpublish = async () => {
    setShowUnpublish(false);
    const ok = await updateApp(app.id, { status: 'draft' });
    if (ok) {
      toast.success(
        'App unpublished',
        browserOnlyDemo
          ? 'The preview is offline in this browser until you publish again.'
          : 'Members lose access until you publish again.',
      );
      await Promise.all([onPublished(), fetchApps()]);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(appUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Copy failed', 'Could not copy to clipboard');
    }
  };

  return (
    <>
      {justPublished !== null && (
        <div className="mb-4 rounded-xl border border-emerald-200 dark:border-emerald-400/20 bg-emerald-50 dark:bg-emerald-400/10 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white">
              <Check className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                {browserOnlyDemo ? `${app.name} is live in this browser` : `${app.name} is live`}
              </p>
              <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                {browserOnlyDemo
                  ? `Version ${justPublished} is ready to preview on this device.`
                  : `Version ${justPublished} is published and available to your users.`}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => window.open(appUrl, '_blank', 'noopener,noreferrer')} leftIcon={<ExternalLink className="h-4 w-4" />}>
              Open app
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          {/* Preflight */}
          <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
            <div className="flex flex-col gap-3 border-b border-gray-200/80 dark:border-white/[0.06] p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {blocking.length > 0
                      ? 'A few things need fixing'
                      : published
                        ? warnings.length === 0 ? 'Live and ready' : 'Live with recommendations'
                        : warnings.length === 0 ? 'Ready to publish' : 'Almost ready'}
                  </h3>
                  <Badge variant={blocking.length > 0 ? 'error' : warnings.length === 0 ? 'success' : 'warning'} size="sm">
                    <CheckCircle2 className="h-3 w-3 mr-1 inline" />
                    {checks.length - warnings.length}/{checks.length} checks
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
                  {blocking.length > 0
                    ? 'Blocking issues would break the app for members — everything else is advice, not homework.'
                    : published
                      ? 'The live app passes every blocking check. Recommendations can be finished whenever they are useful.'
                      : 'Everything below is read from the app\'s real state. Recommendations can be finished later.'}
                </p>
              </div>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
              {checks.map((check) => {
                const isBlocking = check.state === 'warning' && check.severity === 'blocking';
                return (
                <div key={check.id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                      check.state === 'complete'
                        ? 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-300'
                        : isBlocking
                          ? 'bg-red-50 dark:bg-red-400/10 text-red-600 dark:text-red-300'
                          : 'bg-amber-50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-300'
                    )}
                  >
                    {check.state === 'complete' ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="block text-xs font-bold text-gray-800 dark:text-slate-200">{check.title}</span>
                      {check.state === 'warning' && check.severity && (
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide',
                            isBlocking
                              ? 'bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300'
                              : check.severity === 'recommended'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300'
                                : 'bg-gray-100 text-gray-500 dark:bg-white/[0.08] dark:text-slate-400'
                          )}
                        >
                          {isBlocking ? 'Blocking' : check.severity === 'recommended' ? 'Recommended' : 'Optional'}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500">{check.detail}</span>
                  </span>
                  {check.state === 'warning' && check.step && (
                    <button
                      type="button"
                      onClick={() => onStepChange(check.step!)}
                      className={cn(
                        'cursor-pointer text-xs font-bold hover:underline',
                        isBlocking ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300'
                      )}
                    >
                      {isBlocking ? 'Fix' : 'Set up'}
                    </button>
                  )}
                  {check.state === 'warning' && check.id === 'domain' && (
                    <button
                      type="button"
                      onClick={() => navigate(`/apps/${app.id}/deploy`, { state: studioReturn })}
                      className="cursor-pointer text-xs font-bold text-amber-600 dark:text-amber-300 hover:underline"
                    >
                      Set up
                    </button>
                  )}
                </div>
                );
              })}
            </div>
          </section>

          {/* What's in this release */}
          <section className="overflow-hidden rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 shadow-sm">
            <div className="border-b border-gray-200/80 dark:border-white/[0.06] p-4">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                {legacyPublished ? 'Current release' : changes.everPublished ? 'Changed since the last publish' : 'First release'}
              </h3>
              <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
                {legacyPublished
                  ? 'This app is live but predates release history. Future publishes will record versions here.'
                  : changes.everPublished
                  ? changes.count === 0
                    ? 'Nothing has changed — the live app is up to date.'
                    : currentVersion > 0
                      ? `${changes.count} ${changes.count === 1 ? 'resource' : 'resources'} updated since version ${currentVersion}.`
                      : `${changes.count} ${changes.count === 1 ? 'resource' : 'resources'} updated since the last publish.`
                  : 'Everything in the draft goes live with the first publish.'}
              </p>
            </div>
            {changes.everPublished && changes.count > 0 && (
              <div className="divide-y divide-gray-100 dark:divide-white/[0.06]">
                {changes.changed.map((item) => (
                  <div key={`${item.kind}-${item.id}`} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400">
                      {item.kind === 'form' ? <FileText className="h-4 w-4" /> : item.kind === 'flow' ? <Workflow className="h-4 w-4" /> : <Settings className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-gray-800 dark:text-slate-200">{item.label}</span>
                      <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500 capitalize">
                        {item.kind === 'app' ? 'App configuration' : item.kind} · updated {formatRelativeTime(item.updatedAt)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="min-w-0 space-y-5">
          {/* Publish card */}
          <section className="rounded-xl border border-primary-200 dark:border-primary-500/20 bg-gradient-to-br from-primary-50 to-white dark:from-primary-500/[0.09] dark:to-slate-900/60 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-600 text-primary-foreground shadow-lg shadow-primary-600/20">
                {hasChanges ? <Rocket className="h-5 w-5" /> : <Check className="h-5 w-5" />}
              </span>
              <Badge variant={hasChanges ? 'warning' : 'success'} size="sm">
                {!published ? 'Draft' : changes.count > 0 ? `${changes.count} changes` : 'Published'}
              </Badge>
            </div>
            <h3 className="mt-5 text-lg font-semibold text-gray-900 dark:text-white">
              {!published
                ? `Publish version ${nextVersion}`
                : changes.count > 0
                  ? `Publish version ${nextVersion}`
                  : currentVersion > 0
                    ? `Live version ${currentVersion} is up to date`
                    : 'Live app is up to date'}
            </h3>
            <p className="mt-1 text-sm leading-6 text-gray-500 dark:text-slate-400">
              {!published
                ? 'Make the app available at its link. You can unpublish at any time — data is kept.'
                : changes.count > 0
                  ? `Update the live app for everyone. Version ${currentVersion} stays in the history.`
                  : 'Every saved change is live. Make another edit and it will appear here for review.'}
            </p>
            <Button
              className="mt-5 w-full"
              onClick={() => setDialogOpen(true)}
              disabled={(published && !hasChanges) || seededDemoReadOnly || blocking.length > 0}
              leftIcon={hasChanges ? <Rocket className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              title={
                seededDemoReadOnly
                  ? 'Publishing is disabled in the shared demo'
                  : blocking.length > 0
                    ? 'Fix the blocking issues in the checklist first'
                    : undefined
              }
            >
              {blocking.length > 0
                ? `Fix ${blocking.length} blocking ${blocking.length === 1 ? 'issue' : 'issues'} first`
                : !published ? 'Publish app' : changes.count > 0 ? 'Publish changes' : 'No changes to publish'}
            </Button>
            {browserOnlyDemo && (
              <p className="mt-3 text-center text-[10px] leading-4 text-primary-700 dark:text-primary-300">
                Demo releases stay in this browser and never touch the shared cloud data.
              </p>
            )}
            {published && (
              <Button variant="secondary" className="mt-2 w-full" onClick={() => setShowUnpublish(true)} disabled={seededDemoReadOnly}>
                Unpublish
              </Button>
            )}
          </section>

          {/* Live app card */}
          <section className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <span className={cn(
                'flex h-10 w-10 items-center justify-center rounded-xl',
                published
                  ? 'bg-emerald-50 dark:bg-emerald-400/10 text-emerald-600 dark:text-emerald-300'
                  : 'bg-gray-100 dark:bg-white/[0.05] text-gray-400'
              )}>
                <Globe2 className="h-4.5 w-4.5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{published ? 'Live app' : 'App link'}</p>
                <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">
                  {published ? (currentVersion > 0 ? `Published · version ${currentVersion}` : 'Published') : 'Goes live when you publish'}
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-1.5 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.04] p-1.5">
              <span className="min-w-0 flex-1 truncate px-2 text-xs font-mono text-gray-500 dark:text-slate-400">{appUrl}</span>
              <button
                type="button"
                onClick={copyLink}
                aria-label="Copy app link"
                className="p-2 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:text-primary-400 dark:hover:bg-primary-500/10 cursor-pointer"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" onClick={() => window.open(appUrl, '_blank', 'noopener,noreferrer')} leftIcon={<ExternalLink className="h-4 w-4" />}>
                Open app
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(`/apps/${app.id}/deploy`, { state: studioReturn })}
                leftIcon={<Eye className="h-4 w-4" />}
                disabled={browserOnlyDemo}
                title={browserOnlyDemo ? 'Cloud deployment is not available for a browser-only demo app' : undefined}
              >
                {browserOnlyDemo ? 'Browser only' : 'Deploy & share'}
              </Button>
            </div>
            <p className="mt-3 text-[10px] text-gray-400 dark:text-slate-500">
              {browserOnlyDemo
                ? 'This preview is private to this browser. Sign up free when you are ready for sharing, PWA installs and custom domains.'
                : 'QR code, install-as-app (PWA), custom domains and signed package exports live in Deploy & share.'}
            </p>
          </section>

          {/* Version history */}
          <section className="rounded-xl border border-gray-200/80 dark:border-white/[0.06] bg-white dark:bg-slate-900/50 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">Version history</p>
                <p className="mt-0.5 text-xs text-gray-400 dark:text-slate-500">One entry per publish</p>
              </div>
              <History className="h-4 w-4 text-gray-400" />
            </div>
            <div className="mt-4 space-y-3">
              {versions.length === 0 && (
                <p className="text-xs text-gray-400 dark:text-slate-500">
                  {published
                    ? 'No recorded releases yet — future publishes will appear here.'
                    : 'No versions yet — the first publish starts the history.'}
                </p>
              )}
              {versions.slice(0, 6).map((version, index) => (
                <div key={version.id} className="flex items-start gap-3">
                  <span
                    className={cn(
                      'mt-1 h-2 w-2 shrink-0 rounded-full',
                      index === 0 && published ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-slate-600'
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-bold text-gray-800 dark:text-slate-200">
                      v{version.version}
                      {version.label ? ` · ${version.label}` : ''}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-gray-400 dark:text-slate-500">
                      {version.createdAt ? formatRelativeTime(version.createdAt) : ''}
                    </span>
                  </span>
                  {index === 0 && published && <Badge variant="success" size="sm">Live</Badge>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <PublishDialog
        open={dialogOpen}
        appName={app.name}
        nextVersion={nextVersion}
        changes={changes}
        publishing={publishing}
        browserOnly={browserOnlyDemo}
        onClose={() => setDialogOpen(false)}
        onConfirm={doPublish}
      />

      <ConfirmDialog
        isOpen={showUnpublish}
        onClose={() => setShowUnpublish(false)}
        onConfirm={doUnpublish}
        title="Take this app offline?"
        message="Users lose access until you republish. Existing data and the version history are kept."
        confirmLabel="Unpublish"
        variant="danger"
      />
    </>
  );
}

function PublishDialog({
  open,
  appName,
  nextVersion,
  changes,
  publishing,
  browserOnly,
  onClose,
  onConfirm,
}: {
  open: boolean;
  appName: string;
  nextVersion: number;
  changes: UnpublishedChanges;
  publishing: boolean;
  browserOnly: boolean;
  onClose: () => void;
  onConfirm: (label: string) => void;
}) {
  const [label, setLabel] = useState('');
  return (
    <Modal isOpen={open} onClose={onClose} title={`Publish version ${nextVersion}?`} size="sm">
      <div className="p-4 sm:p-5 space-y-4">
        <p className="text-sm leading-6 text-gray-500 dark:text-slate-400">
          {browserOnly
            ? `Version ${nextVersion} becomes the preview served from this browser for ${appName}. Existing records are unchanged.`
            : `Version ${nextVersion} replaces the live app for everyone using ${appName}. Existing records are unchanged.`}
        </p>
        <div className="rounded-xl bg-gray-50 dark:bg-white/[0.04] p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">Included in this release</p>
          <ul className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-slate-300">
            {changes.everPublished && changes.count > 0 ? (
              changes.changed.slice(0, 5).map((item) => (
                <li key={`${item.kind}-${item.id}`} className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" /> {item.label}
                </li>
              ))
            ) : (
              <li className="flex items-center gap-2">
                <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" /> Everything currently saved in the draft
              </li>
            )}
            {changes.everPublished && changes.count > 5 && (
              <li className="flex items-center gap-2 text-gray-400">
                <GitBranch className="h-3.5 w-3.5 shrink-0" /> …and {changes.count - 5} more
              </li>
            )}
          </ul>
        </div>
        <div>
          <label htmlFor="publish-label" className="block text-xs font-semibold text-gray-600 dark:text-slate-300 mb-1.5">
            Release note <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <Input
            id="publish-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Improved job dashboard"
            maxLength={160}
          />
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Keep editing
          </Button>
          <Button className="flex-1" onClick={() => onConfirm(label)} isLoading={publishing} leftIcon={<Rocket className="h-4 w-4" />}>
            Publish v{nextVersion}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
