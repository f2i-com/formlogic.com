import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Cloud,
  Headphones,
  Laptop,
  PhoneCall,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import {
  api,
  type AokieCompanionActivity,
  type AokieCompanionAvailability,
  type AokieCompanionDevice,
  type AokieCompanionDiscovery,
  type AokieCompanionRemoteConsent,
  type AokieCompanionRemoteConsentInput,
  type AokieCompanionRoutingGroup,
  type AokieCompanionSession,
} from '../../../lib/api';
import { toast } from '../../../stores/toastStore';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import {
  companionDesktopDiagnostic,
  companionEndpointView,
  companionReadiness,
  type CompanionDesktopDiagnostic,
  type ReadinessTone,
} from './aokieCompanionUi';
import {
  CompanionHistorySection,
  RemoteAccessPolicySection,
  RoutingGroupsSection,
  type RoutingGroupDraft,
} from './AokieCompanionAdminSections';

const card = 'bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60';

function statusClass(tone: ReadinessTone): string {
  if (tone === 'ready') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400';
  }
  if (tone === 'warning') {
    return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400';
  }
  return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400';
}

function ReadinessChip({ label, tone }: { label: string; tone: ReadinessTone }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusClass(tone)}`}>
      {label}
    </span>
  );
}

interface AokieCompanionPanelProps {
  appId?: string;
  appSlug?: string;
  isOwner: boolean;
  canManage: boolean;
  canAudit: boolean;
  currentUserId: string | null;
  demoMode: boolean;
  /** Incremented by Device Setup's page-level Refresh button. */
  refreshToken: number;
}

/** Missing or malformed policy is deliberately represented as all-disabled. */
const closedPolicy: AokieCompanionRemoteConsentInput = {
  remoteMonitoring: false,
  remoteConsult: false,
  remoteTakeover: false,
  remoteCaptions: false,
  remoteAssistance: false,
};

/** Managed readiness, role-aware policy/audit controls, and endpoint routing. */
export function AokieCompanionPanel({
  appId,
  appSlug,
  isOwner,
  canManage,
  canAudit,
  currentUserId,
  demoMode,
  refreshToken,
}: AokieCompanionPanelProps) {
  const [discovery, setDiscovery] = useState<AokieCompanionDiscovery | null>(null);
  const [devices, setDevices] = useState<AokieCompanionDevice[] | null>(null);
  const [policy, setPolicy] = useState<AokieCompanionRemoteConsent | null>(null);
  const [policyDraft, setPolicyDraft] = useState<AokieCompanionRemoteConsentInput>(closedPolicy);
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const [history, setHistory] = useState<{ activity: AokieCompanionActivity[]; sessions: AokieCompanionSession[] } | null>(null);
  const [routingGroups, setRoutingGroups] = useState<AokieCompanionRoutingGroup[] | null>(null);
  const [routingDraft, setRoutingDraft] = useState<RoutingGroupDraft | null>(null);
  const [desktopDiagnostic, setDesktopDiagnostic] = useState<CompanionDesktopDiagnostic | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [availabilityBusyId, setAvailabilityBusyId] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<AokieCompanionDevice | null>(null);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<AokieCompanionRoutingGroup | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (cancelled: () => boolean = () => false) => {
    if (cancelled()) return;
    const run = ++generation.current;
    if (demoMode || !appSlug) {
      setDiscovery(null);
      setDevices([]);
      setPolicy(null);
      setHistory({ activity: [], sessions: [] });
      setRoutingGroups([]);
      setDesktopDiagnostic(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const diagnosticsRequest = isOwner && appId
      ? Promise.all([api.getConnectorAssignments(), api.getDesktopConnections(), api.getApiKeys()])
      : Promise.resolve(null);
    const [discoveryResult, policyResult, routingResult, deviceResult, historyResult, diagnosticResults] = await Promise.all([
      api.getAokieCompanionDiscovery(appSlug),
      appId ? api.getAokieCompanionPolicy(appId) : Promise.resolve(null),
      appId ? api.getAokieCompanionRoutingGroups(appId) : Promise.resolve(null),
      canAudit && appId ? api.getAokieCompanionDevices(appId) : Promise.resolve(null),
      canAudit && appId ? api.getAokieCompanionHistory(appId) : Promise.resolve(null),
      diagnosticsRequest,
    ]);
    if (cancelled() || generation.current !== run) return;
    setDiscovery(discoveryResult.data ?? null);
    const loadedPolicy = policyResult?.data?.remoteConsent ?? null;
    setPolicy(loadedPolicy);
    setPolicyDraft(loadedPolicy ? {
      remoteMonitoring: loadedPolicy.remoteMonitoring,
      remoteConsult: loadedPolicy.remoteConsult,
      remoteTakeover: loadedPolicy.remoteTakeover,
      remoteCaptions: loadedPolicy.remoteCaptions,
      remoteAssistance: loadedPolicy.remoteAssistance,
    } : closedPolicy);
    setDisclosureAccepted(false);
    setRoutingGroups(routingResult?.data?.groups ?? (routingResult ? [] : null));
    setDevices(deviceResult?.data?.devices ?? (deviceResult ? [] : null));
    setHistory(historyResult?.data ?? (historyResult ? { activity: [], sessions: [] } : null));
    if (diagnosticResults && appId
      && diagnosticResults[0].data
      && diagnosticResults[1].data
      && diagnosticResults[2].data) {
      setDesktopDiagnostic(companionDesktopDiagnostic(
        appId,
        diagnosticResults[0].data,
        diagnosticResults[1].data.connections,
        diagnosticResults[2].data.keys,
      ));
    } else {
      setDesktopDiagnostic(null);
    }
    const errors = [
      discoveryResult.error,
      policyResult?.error,
      routingResult?.error,
      deviceResult?.error,
      historyResult?.error,
      ...(diagnosticResults?.map((result) => result.error) ?? []),
    ].filter((value): value is string => !!value);
    setError(errors.length > 0 ? Array.from(new Set(errors)).join(' ') : null);
    setLoading(false);
  }, [appId, appSlug, canAudit, demoMode, isOwner]);

  useEffect(() => {
    let cancelled = false;
    // Defer the external fetch out of the synchronous effect body. The cancellation
    // predicate also prevents a completed request from painting after unmount.
    void Promise.resolve().then(() => load(() => cancelled));
    return () => { cancelled = true; };
  }, [load, refreshToken]);

  const revoke = useCallback(async () => {
    if (!confirmRevoke || busyId) return;
    const target = confirmRevoke;
    setBusyId(target.id);
    setError(null);
    const result = await api.revokeAokieCompanionDevice(target.id);
    if (result.error) {
      setError(result.error);
    } else {
      toast.success('Companion endpoint revoked', `${target.displayName} must be approved and authorized again before it can connect.`);
      setConfirmRevoke(null);
      await load();
    }
    setBusyId(null);
  }, [busyId, confirmRevoke, load]);

  const approveAgain = useCallback(async (device: AokieCompanionDevice) => {
    if (busyId) return;
    setBusyId(device.id);
    setError(null);
    const result = await api.approveAokieCompanionDevice(device.id);
    if (result.error) {
      setError(result.error);
    } else {
      toast.success('Endpoint can be linked again', `${device.displayName} must now sign in and authorize this app again.`);
      await load();
    }
    setBusyId(null);
  }, [busyId, load]);

  const savePolicy = useCallback(async () => {
    if (!appId || !canManage || savingPolicy) return;
    setSavingPolicy(true);
    setError(null);
    const result = await api.updateAokieCompanionPolicy(appId, policyDraft);
    if (result.error || !result.data) {
      setError(result.error ?? 'The remote access policy could not be saved.');
    } else {
      setPolicy(result.data.remoteConsent);
      setDisclosureAccepted(false);
      toast.success('Remote access policy saved', 'New admissions will use the explicit app policy immediately.');
      await load();
    }
    setSavingPolicy(false);
  }, [appId, canManage, load, policyDraft, savingPolicy]);

  const createRoutingDraft = useCallback(() => {
    setRoutingDraft({ id: null, name: '', policy: 'all', enabled: true, members: {} });
  }, []);

  const editRoutingGroup = useCallback((group: AokieCompanionRoutingGroup) => {
    setRoutingDraft({
      id: group.id,
      name: group.name,
      policy: group.policy,
      enabled: group.enabled,
      members: Object.fromEntries(group.members.map((member) => [member.deviceId, {
        enabled: member.enabled,
        priority: member.priority,
      }])),
    });
  }, []);

  const saveRoutingGroup = useCallback(async () => {
    if (!appId || !canManage || !routingDraft || routingBusy) return;
    if (Object.values(routingDraft.members).some((member) => !Number.isInteger(member.priority)
      || member.priority < 0 || member.priority > 10000)) {
      setError('Every routing priority must be a whole number from 0 to 10000.');
      return;
    }
    setRoutingBusy(true);
    setError(null);
    const input = {
      appId,
      name: routingDraft.name.trim(),
      policy: routingDraft.policy,
      enabled: routingDraft.enabled,
      members: Object.entries(routingDraft.members).map(([deviceId, member]) => ({ deviceId, ...member })),
    };
    const result = routingDraft.id
      ? await api.updateAokieCompanionRoutingGroup(routingDraft.id, input)
      : await api.createAokieCompanionRoutingGroup(input);
    if (result.error) {
      setError(result.error);
    } else {
      toast.success('Routing group saved', `${input.name} now uses the ${input.policy.replace('_', ' ')} policy.`);
      setRoutingDraft(null);
      await load();
    }
    setRoutingBusy(false);
  }, [appId, canManage, load, routingBusy, routingDraft]);

  const deleteRoutingGroup = useCallback(async () => {
    if (!appId || !confirmDeleteGroup || routingBusy) return;
    const target = confirmDeleteGroup;
    setRoutingBusy(true);
    setError(null);
    const result = await api.deleteAokieCompanionRoutingGroup(target.id, appId);
    if (result.error) {
      setError(result.error);
    } else {
      toast.success('Routing group deleted', target.name);
      setConfirmDeleteGroup(null);
      if (routingDraft?.id === target.id) setRoutingDraft(null);
      await load();
    }
    setRoutingBusy(false);
  }, [appId, confirmDeleteGroup, load, routingBusy, routingDraft?.id]);

  const setAvailability = useCallback(async (deviceId: string, availability: AokieCompanionAvailability) => {
    if (!appId || availabilityBusyId) return;
    setAvailabilityBusyId(deviceId);
    setError(null);
    const result = await api.setAokieCompanionAvailability(appId, deviceId, availability);
    if (result.error) {
      setError(result.error);
    } else {
      setRoutingGroups((groups) => groups?.map((group) => ({
        ...group,
        members: group.members.map((member) => member.deviceId === deviceId
          ? { ...member, availability }
          : member),
      })) ?? groups);
      toast.success('Availability updated', `Endpoint is now ${availability.replaceAll('_', ' ')}.`);
    }
    setAvailabilityBusyId(null);
  }, [appId, availabilityBusyId]);

  const readiness = companionReadiness(discovery, appId);

  return (
    <div className={`${card} p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-gray-900 dark:text-white">Aokie Companion &amp; realtime</h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-slate-400">
              The server authenticates endpoints and routes call state, claims and WebRTC signalling. The Aokie
              Desktop plugin remains the only owner of the Bluetooth dongle and HFP/SCO audio.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || demoMode}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {demoMode ? (
        <p className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
          Companion enrollment is disabled in the shared demo. Use an app you own to link native endpoints.
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-slate-500">Server</p>
              <div className="mt-1.5"><ReadinessChip {...readiness.server} /></div>
            </div>
            <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-slate-500">Discovery trust</p>
              <div className="mt-1.5"><ReadinessChip {...readiness.trust} /></div>
            </div>
            <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-slate-500">Realtime gateway</p>
              <div className="mt-1.5"><ReadinessChip {...readiness.gateway} /></div>
            </div>
            <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-slate-500">Media contract</p>
              <div className="mt-1.5"><ReadinessChip {...readiness.media} /></div>
            </div>
            <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-slate-500">ICE / relay</p>
              <div className="mt-1.5"><ReadinessChip {...readiness.relay} /></div>
            </div>
          </div>

          {discovery && (
            <div className={`mt-3 rounded-xl border px-3 py-3 ${readiness.ready ? 'border-emerald-200/80 bg-emerald-50/60 dark:border-emerald-500/20 dark:bg-emerald-500/5' : 'border-amber-200/80 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5'}`}>
              <div className="flex items-start gap-2">
                {readiness.ready
                  ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />}
                <div className="min-w-0 text-xs">
                  <p className="font-medium text-gray-900 dark:text-white">
                    {readiness.ready ? 'Managed Companion discovery is ready' : 'Managed Companion discovery needs attention'}
                  </p>
                  <p className="mt-1 break-all text-gray-500 dark:text-slate-400">
                    Gateway: {discovery.gatewayUrl ?? 'not configured'}
                  </p>
                  <p className="mt-1 text-gray-500 dark:text-slate-400">
                    {discovery.signatureVerified
                      ? `${discovery.signatureAlgorithm ?? 'Ed25519'} signature verified${discovery.signingKeyId ? ` (${discovery.signingKeyId})` : ''}.`
                      : 'The signed discovery envelope could not be verified in this browser; native enrollment must remain locked.'}
                    {' '}{discovery.hasTurnRelay
                      ? `TURN ${discovery.relayOnly ? 'is required' : 'fallback is configured'} (${discovery.iceServerCount} ICE server ${discovery.iceServerCount === 1 ? 'entry' : 'entries'}; credentials and URLs hidden).`
                      : discovery.relayOnly
                        ? 'Relay-only mode is requested but no usable TURN service is advertised.'
                        : 'No TURN fallback is advertised; direct connectivity may still work.'}
                  </p>
                  {discovery.turnCredentialExpiresAt !== null && (
                    <p className="mt-1 text-gray-500 dark:text-slate-400">
                      Short-lived TURN credentials expire {new Date(discovery.turnCredentialExpiresAt * 1000).toLocaleString()}.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {isOwner && (
            <div className={`mt-3 rounded-xl border px-3 py-3 ${desktopDiagnostic ? statusClass(desktopDiagnostic.tone) : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300'}`}>
              <p className="text-xs font-medium">{desktopDiagnostic?.label ?? 'Desktop authority diagnostic unavailable'}</p>
              <p className="mt-1 text-[11px] leading-relaxed">
                {desktopDiagnostic?.detail ?? 'The exact connector assignment, linked Desktop key and scope could not be inspected.'}
                {desktopDiagnostic?.desktopName ? ` Assigned Desktop: ${desktopDiagnostic.desktopName}.` : ''}
              </p>
              <p className="mt-1 text-[10px] opacity-80">Production admission requires the dedicated aokie:realtime scope; connector:relay is not accepted as media authority.</p>
            </div>
          )}

          {error && (
            <div className="mt-3 break-words rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2">
              <Server className="h-4 w-4 text-gray-400 dark:text-slate-500" />
              <h3 className="text-xs font-medium text-gray-700 dark:text-slate-200">Media path</h3>
            </div>
            <div className="grid items-stretch gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
              <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
                <PhoneCall className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                <p className="mt-2 text-xs font-medium text-gray-900 dark:text-white">Caller + cellular phone</p>
                <p className="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-slate-400">The live cellular call enters through the phone paired to Aokie.</p>
              </div>
              <ArrowRight className="m-auto hidden h-4 w-4 text-gray-300 dark:text-slate-600 md:block" />
              <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
                <Laptop className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                <p className="mt-2 text-xs font-medium text-gray-900 dark:text-white">Aokie Desktop + plugin</p>
                <p className="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-slate-400">Owns the dongle, HFP/SCO and physical call truth, then bridges approved WebRTC audio.</p>
              </div>
              <ArrowRight className="m-auto hidden h-4 w-4 text-gray-300 dark:text-slate-600 md:block" />
              <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
                <Headphones className="h-4 w-4 text-gray-400 dark:text-slate-500" />
                <p className="mt-2 text-xs font-medium text-gray-900 dark:text-white">Companion endpoint</p>
                <p className="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-slate-400">Uses its own microphone and speakers. It never connects to the Bluetooth dongle.</p>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-gray-400 dark:text-slate-500">
              FormLogic or a custom compatible server handles identity, control and signalling only. A TURN service may relay encrypted WebRTC packets when direct peer connectivity is unavailable.
            </p>
          </div>

          <RemoteAccessPolicySection
            policy={policy}
            draft={policyDraft}
            canManage={canManage}
            saving={savingPolicy}
            disclosureAccepted={disclosureAccepted}
            advertisedFeatures={discovery?.trustStatus === 'signed' && discovery.signatureVerified
              ? discovery.features
              : null}
            onChange={(key, enabled) => {
              setPolicyDraft((current) => ({ ...current, [key]: enabled }));
              setDisclosureAccepted(false);
            }}
            onDisclosureAccepted={setDisclosureAccepted}
            onSave={() => void savePolicy()}
          />

          <RoutingGroupsSection
            groups={routingGroups}
            devices={devices}
            currentUserId={currentUserId}
            canManage={canManage}
            draft={routingDraft}
            busy={routingBusy}
            availabilityBusyId={availabilityBusyId}
            onCreate={createRoutingDraft}
            onEdit={editRoutingGroup}
            onCancel={() => setRoutingDraft(null)}
            onDraftChange={setRoutingDraft}
            onSave={() => void saveRoutingGroup()}
            onDelete={setConfirmDeleteGroup}
            onAvailability={(deviceId, availability) => void setAvailability(deviceId, availability)}
          />

          <CompanionHistorySection canAudit={canAudit} history={history} />

          <div className="mt-5 border-t border-gray-100 pt-4 dark:border-slate-800">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-gray-900 dark:text-white">Enrolled endpoints</h3>
                <p className="mt-0.5 text-[11px] text-gray-400 dark:text-slate-500">Approval status is durable; “last admission” is not a live-online indicator.</p>
              </div>
              {loading && <RefreshCw className="h-4 w-4 animate-spin text-gray-400 dark:text-slate-500" />}
            </div>
            {!canAudit ? (
              <p className="rounded-xl border border-gray-100 px-3 py-2.5 text-xs text-gray-500 dark:border-slate-800 dark:text-slate-400">
                Your role does not include Aokie Companion audit access, so the endpoint registry is hidden.
              </p>
            ) : devices === null ? (
              <p className="text-xs text-gray-400 dark:text-slate-500">Loading enrolled endpoints…</p>
            ) : devices.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">
                No endpoints have enrolled for this app yet. The Desktop bridge appears after its first managed admission; Companion endpoints appear after native sign-in and app approval.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-slate-800">
                {devices.map((device) => {
                  const view = companionEndpointView(device);
                  const revoked = view.statusLabel === 'Revoked';
                  const canRevoke = canManage || device.userId === currentUserId;
                  const canApprove = canManage;
                  return (
                    <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="break-words text-sm font-medium text-gray-900 dark:text-white">{device.displayName}</p>
                          <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{view.roleLabel}</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${revoked ? statusClass('unavailable') : statusClass('ready')}`}>{view.statusLabel}</span>
                        </div>
                        <p title={view.lastSeenTitle ?? undefined} className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">{view.lastSeenLabel}</p>
                      </div>
                      {revoked && canApprove ? (
                        <button
                          type="button"
                          onClick={() => void approveAgain(device)}
                          disabled={busyId !== null}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {busyId === device.id ? 'Approving…' : 'Approve again'}
                        </button>
                      ) : !revoked && canRevoke ? (
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(device)}
                          disabled={busyId !== null}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
                        >
                          <Ban className="h-3.5 w-3.5" /> Revoke
                        </button>
                      ) : (
                        <span className="text-[10px] text-gray-400 dark:text-slate-500">Read-only</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      <ConfirmDialog
        isOpen={confirmRevoke !== null}
        onClose={() => { if (!busyId) setConfirmRevoke(null); }}
        onConfirm={() => void revoke()}
        title="Revoke Companion endpoint?"
        message={confirmRevoke
          ? `${confirmRevoke.displayName} will immediately lose its Aokie access, including existing access and refresh sessions. You can approve it again later, but it must authorize again.`
          : ''}
        confirmLabel="Revoke endpoint"
        variant="danger"
        isLoading={busyId === confirmRevoke?.id}
      />
      <ConfirmDialog
        isOpen={confirmDeleteGroup !== null}
        onClose={() => { if (!routingBusy) setConfirmDeleteGroup(null); }}
        onConfirm={() => void deleteRoutingGroup()}
        title="Delete Companion routing group?"
        message={confirmDeleteGroup
          ? `${confirmDeleteGroup.name} will stop receiving newly routed Companion call offers. Enrolled endpoints are not revoked.`
          : ''}
        confirmLabel="Delete routing group"
        variant="danger"
        isLoading={routingBusy && confirmDeleteGroup !== null}
      />
    </div>
  );
}
