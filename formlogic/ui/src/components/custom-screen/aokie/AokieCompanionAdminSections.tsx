import { Activity, GitBranch, Plus, Save, Trash2 } from 'lucide-react';
import type {
  AokieCompanionActivity,
  AokieCompanionAvailability,
  AokieCompanionDevice,
  AokieCompanionRemoteConsent,
  AokieCompanionRemoteConsentInput,
  AokieCompanionRoutingGroup,
  AokieCompanionRoutingPolicy,
  AokieCompanionSession,
} from '../../../lib/api';
import { companionActivityLabel, companionTimestamp } from './aokieCompanionUi';

const REMOTE_ACCESS_DISCLOSURE_VERSION = 'Aokie remote-access policy v2';

const REMOTE_CONSENT_OPTIONS: Array<{
  key: keyof AokieCompanionRemoteConsentInput;
  label: string;
  description: string;
  feature: string;
}> = [
  {
    key: 'remoteMonitoring',
    label: 'Remote monitoring',
    description: 'Approved Companion endpoints may hear live caller audio, but cannot publish microphone audio.',
    feature: 'monitor',
  },
  {
    key: 'remoteConsult',
    label: 'Private voice consultation',
    description: 'Invited, authorized endpoints may join the isolated consult lane. Consult microphones are never routed to the caller.',
    feature: 'consult',
  },
  {
    key: 'remoteTakeover',
    label: 'Remote takeover and return',
    description: 'Authorized members may become the one active talker after the Desktop confirms physical hold, then return the call to Aokie.',
    feature: 'takeover',
  },
  {
    key: 'remoteCaptions',
    label: 'Remote captions',
    description: 'Authorized members may read the live call transcript and caller context exposed by the app.',
    feature: 'captions',
  },
  {
    key: 'remoteAssistance',
    label: 'Typed assistance',
    description: 'Authorized members may read and send typed help messages independently of private voice consultation.',
    feature: 'typed_assistance',
  },
];

interface RemoteAccessPolicySectionProps {
  policy: AokieCompanionRemoteConsent | null;
  draft: AokieCompanionRemoteConsentInput;
  canManage: boolean;
  saving: boolean;
  disclosureAccepted: boolean;
  advertisedFeatures: string[] | null;
  onChange: (key: keyof AokieCompanionRemoteConsentInput, enabled: boolean) => void;
  onDisclosureAccepted: (accepted: boolean) => void;
  onSave: () => void;
}

/** Exported so the disclosure and non-manager rendering receive focused component coverage. */
export function RemoteAccessPolicySection({
  policy,
  draft,
  canManage,
  saving,
  disclosureAccepted,
  advertisedFeatures,
  onChange,
  onDisclosureAccepted,
  onSave,
}: RemoteAccessPolicySectionProps) {
  const dirty = policy !== null && REMOTE_CONSENT_OPTIONS.some(({ key }) => policy[key] !== draft[key]);
  const enablesRemoteAccess = REMOTE_CONSENT_OPTIONS.some(({ key }) => draft[key]);
  const saveBlockedByDisclosure = enablesRemoteAccess && !disclosureAccepted;
  return (
    <section className="mt-5 border-t border-gray-100 pt-4 dark:border-slate-800" aria-labelledby="aokie-remote-policy-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="aokie-remote-policy-title" className="text-sm font-medium text-gray-900 dark:text-white">Remote access policy</h3>
          <p className="mt-0.5 text-[11px] text-gray-400 dark:text-slate-500">Disclosure version: {REMOTE_ACCESS_DISCLOSURE_VERSION}</p>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${policy?.configured
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400'
          : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'}`}>
          {policy?.configured ? 'Explicit policy saved' : 'Not acknowledged - fail closed'}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-gray-500 dark:text-slate-400">
        These app-level switches only remove or allow capability. A member also needs the matching role permission,
        an approved endpoint, and a fresh short-lived admission. Saving a change applies to newly issued admissions;
        existing admissions expire within minutes.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {REMOTE_CONSENT_OPTIONS.map((option) => {
          const advertised = advertisedFeatures?.includes(option.feature) ?? false;
          const savedEnabled = policy?.[option.key] === true;
          return (
          <label key={option.key} className={`rounded-xl border p-3 ${draft[option.key]
            ? 'border-primary-200 bg-primary-50/50 dark:border-primary-500/20 dark:bg-primary-500/5'
            : 'border-gray-100 dark:border-slate-800'}`}>
            <span className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={draft[option.key]}
                disabled={!canManage || saving || policy === null}
                onChange={(event) => onChange(option.key, event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:cursor-not-allowed"
              />
              <span>
                <span className="block text-xs font-medium text-gray-900 dark:text-white">{option.label}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-gray-500 dark:text-slate-400">{option.description}</span>
                <span className={`mt-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${!draft[option.key]
                  ? 'border-gray-200 text-gray-500 dark:border-slate-700 dark:text-slate-400'
                  : advertised
                    ? 'border-emerald-200 text-emerald-700 dark:border-emerald-500/20 dark:text-emerald-400'
                    : 'border-amber-200 text-amber-700 dark:border-amber-500/20 dark:text-amber-400'}`}>
                  {!draft[option.key]
                    ? 'Disabled by app policy'
                    : advertised
                      ? 'Advertised by signed discovery'
                      : advertisedFeatures === null
                        ? 'Signed discovery not verified'
                      : savedEnabled
                        ? 'Discovery mismatch - refresh or inspect server'
                        : 'Save policy to advertise'}
                </span>
              </span>
            </span>
          </label>
          );
        })}
      </div>
      {!canManage ? (
        <p className="mt-3 rounded-xl border border-gray-100 px-3 py-2 text-xs text-gray-500 dark:border-slate-800 dark:text-slate-400">
          You can inspect this policy, but your role does not include Manage Aokie Companion access.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex max-w-2xl items-start gap-2 text-[11px] leading-relaxed text-gray-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={disclosureAccepted}
              disabled={saving || !enablesRemoteAccess}
              onChange={(event) => onDisclosureAccepted(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:cursor-not-allowed"
            />
            I understand that enabled capabilities may expose live caller audio, captions, caller context, or typed
            assistance to members whose roles separately allow them.
          </label>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving || saveBlockedByDisclosure}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Save className="h-3.5 w-3.5" /> {saving ? 'Saving...' : 'Save remote policy'}
          </button>
        </div>
      )}
    </section>
  );
}

export interface RoutingGroupDraft {
  id: string | null;
  name: string;
  policy: AokieCompanionRoutingPolicy;
  enabled: boolean;
  members: Record<string, { enabled: boolean; priority: number }>;
}

interface RoutingGroupsSectionProps {
  groups: AokieCompanionRoutingGroup[] | null;
  devices: AokieCompanionDevice[] | null;
  currentUserId: string | null;
  canManage: boolean;
  draft: RoutingGroupDraft | null;
  busy: boolean;
  availabilityBusyId: string | null;
  onCreate: () => void;
  onEdit: (group: AokieCompanionRoutingGroup) => void;
  onCancel: () => void;
  onDraftChange: (draft: RoutingGroupDraft) => void;
  onSave: () => void;
  onDelete: (group: AokieCompanionRoutingGroup) => void;
  onAvailability: (deviceId: string, availability: AokieCompanionAvailability) => void;
}

const POLICY_LABEL: Record<AokieCompanionRoutingPolicy, string> = {
  all: 'Ring all available endpoints',
  priority: 'First available by priority',
  round_robin: 'Rotate one available endpoint',
};

const AVAILABILITY_LABEL: Record<AokieCompanionAvailability, string> = {
  available: 'Available',
  busy: 'Busy',
  offline: 'Offline',
  do_not_disturb: 'Do not disturb',
};

export function RoutingGroupsSection({
  groups,
  devices,
  currentUserId,
  canManage,
  draft,
  busy,
  availabilityBusyId,
  onCreate,
  onEdit,
  onCancel,
  onDraftChange,
  onSave,
  onDelete,
  onAvailability,
}: RoutingGroupsSectionProps) {
  // Keep revoked members visible while editing so a manager can remove stale routing rows;
  // they cannot be newly selected and the backend still rejects them on save.
  const candidates = (devices ?? []).filter((device) => device.role === 'mobile');
  return (
    <section className="mt-5 border-t border-gray-100 pt-4 dark:border-slate-800" aria-labelledby="aokie-routing-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-gray-400 dark:text-slate-500" />
            <h3 id="aokie-routing-title" className="text-sm font-medium text-gray-900 dark:text-white">Companion routing groups</h3>
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">Only enabled, available, approved endpoints are selected at call time.</p>
        </div>
        {canManage && !draft && (
          <button type="button" onClick={onCreate} disabled={busy} className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
            <Plus className="h-3.5 w-3.5" /> New group
          </button>
        )}
      </div>

      {draft && canManage && (
        <div className="mt-3 rounded-xl border border-primary-200 bg-primary-50/30 p-3 dark:border-primary-500/20 dark:bg-primary-500/5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-gray-600 dark:text-slate-300">
              Group name
              <input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} maxLength={120} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white" />
            </label>
            <label className="text-xs text-gray-600 dark:text-slate-300">
              Routing policy
              <select value={draft.policy} onChange={(event) => onDraftChange({ ...draft, policy: event.target.value as AokieCompanionRoutingPolicy })} className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white">
                <option value="all">Ring all</option>
                <option value="priority">Priority</option>
                <option value="round_robin">Round robin</option>
              </select>
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-gray-600 dark:text-slate-300">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })} />
            Group enabled
          </label>
          <div className="mt-3">
            <p className="text-xs font-medium text-gray-700 dark:text-slate-200">Endpoints</p>
            {candidates.length === 0 ? (
              <p className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">No approved mobile Companion endpoints are enrolled yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {candidates.map((device) => {
                  const member = draft.members[device.id];
                  const revoked = device.revokedAt !== null;
                  return (
                    <div key={device.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-100 bg-white px-2.5 py-2 dark:border-slate-800 dark:bg-slate-900">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-gray-800 dark:text-slate-200">
                        <input
                          type="checkbox"
                          checked={member !== undefined}
                          disabled={revoked && member === undefined}
                          onChange={(event) => {
                            const members = { ...draft.members };
                            if (event.target.checked) members[device.id] = { enabled: true, priority: 100 };
                            else delete members[device.id];
                            onDraftChange({ ...draft, members });
                          }}
                        />
                        <span className="truncate">{device.displayName}{revoked ? ' (revoked - remove before saving)' : ''}</span>
                      </label>
                      {member && (
                        <>
                          <label className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-slate-400">
                            Priority
                            <input
                              type="number"
                              min={0}
                              max={10000}
                              value={member.priority}
                              onChange={(event) => onDraftChange({
                                ...draft,
                                members: { ...draft.members, [device.id]: { ...member, priority: Number(event.target.value) } },
                              })}
                              className="w-20 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                            />
                          </label>
                          <label className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-slate-400">
                            <input type="checkbox" checked={member.enabled} onChange={(event) => onDraftChange({ ...draft, members: { ...draft.members, [device.id]: { ...member, enabled: event.target.checked } } })} />
                            Route to endpoint
                          </label>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onCancel} disabled={busy} className="cursor-pointer rounded-xl border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 disabled:opacity-45 dark:border-slate-700 dark:text-slate-300">Cancel</button>
            <button type="button" onClick={onSave} disabled={busy || draft.name.trim() === ''} className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-primary-600 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45">
              <Save className="h-3.5 w-3.5" /> {busy ? 'Saving...' : 'Save group'}
            </button>
          </div>
        </div>
      )}

      {groups === null ? (
        <p className="mt-3 text-xs text-gray-400 dark:text-slate-500">Loading routing groups...</p>
      ) : groups.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">No routing groups have been configured.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {groups.map((group) => (
            <div key={group.id} className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-gray-900 dark:text-white">{group.name}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${group.enabled ? 'border-emerald-200 text-emerald-700 dark:border-emerald-500/20 dark:text-emerald-400' : 'border-gray-200 text-gray-500 dark:border-slate-700 dark:text-slate-400'}`}>{group.enabled ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">{POLICY_LABEL[group.policy]}</p>
                </div>
                {canManage && (
                  <div className="flex gap-1.5">
                    <button type="button" onClick={() => onEdit(group)} disabled={busy} className="cursor-pointer rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-600 disabled:opacity-45 dark:border-slate-700 dark:text-slate-300">Edit</button>
                    <button type="button" onClick={() => onDelete(group)} disabled={busy} aria-label={`Delete ${group.name}`} className="cursor-pointer rounded-lg border border-red-200 p-1 text-red-600 disabled:opacity-45 dark:border-red-500/20 dark:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
              {group.members.length === 0 ? (
                <p className="mt-2 text-[11px] text-gray-400 dark:text-slate-500">No endpoints in this group.</p>
              ) : (
                <ul className="mt-2 divide-y divide-gray-100 dark:divide-slate-800">
                  {group.members.map((member) => {
                    const canSetAvailability = canManage || member.userId === currentUserId;
                    return (
                      <li key={member.deviceId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div>
                          <p className="text-xs text-gray-800 dark:text-slate-200">{member.displayName}</p>
                          <p className="mt-0.5 text-[10px] text-gray-400 dark:text-slate-500">Priority {member.priority}{member.enabled ? '' : ' - routing disabled'}</p>
                        </div>
                        {canSetAvailability ? (
                          <select
                            aria-label={`${member.displayName} availability`}
                            value={member.availability}
                            disabled={availabilityBusyId === member.deviceId}
                            onChange={(event) => onAvailability(member.deviceId, event.target.value as AokieCompanionAvailability)}
                            className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700 disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                          >
                            {Object.entries(AVAILABILITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        ) : (
                          <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500 dark:border-slate-700 dark:text-slate-400">{AVAILABILITY_LABEL[member.availability]}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface CompanionHistorySectionProps {
  canAudit: boolean;
  history: { activity: AokieCompanionActivity[]; sessions: AokieCompanionSession[] } | null;
}

export function CompanionHistorySection({ canAudit, history }: CompanionHistorySectionProps) {
  return (
    <section className="mt-5 border-t border-gray-100 pt-4 dark:border-slate-800" aria-labelledby="aokie-history-title">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-gray-400 dark:text-slate-500" />
        <h3 id="aokie-history-title" className="text-sm font-medium text-gray-900 dark:text-white">Companion audit and call sessions</h3>
      </div>
      {!canAudit ? (
        <p className="mt-2 rounded-xl border border-gray-100 px-3 py-2.5 text-xs text-gray-500 dark:border-slate-800 dark:text-slate-400">Your role does not include Aokie Companion audit history.</p>
      ) : history === null ? (
        <p className="mt-2 text-xs text-gray-400 dark:text-slate-500">Loading audit history...</p>
      ) : history.activity.length === 0 && history.sessions.length === 0 ? (
        <p className="mt-2 rounded-xl border border-dashed border-gray-200 px-3 py-3 text-xs text-gray-500 dark:border-slate-700 dark:text-slate-400">No Companion activity has been recorded for this app.</p>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
            <p className="text-xs font-medium text-gray-700 dark:text-slate-200">Recent activity</p>
            <ul className="mt-2 max-h-72 divide-y divide-gray-100 overflow-auto dark:divide-slate-800">
              {history.activity.slice(0, 100).map((activity) => {
                const time = companionTimestamp(activity.occurredAt);
                return (
                  <li key={activity.id} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-gray-800 dark:text-slate-200">{companionActivityLabel(activity)}</p>
                      <time title={time.title ?? undefined} className="shrink-0 text-[10px] text-gray-400 dark:text-slate-500">{time.label}</time>
                    </div>
                    <p className="mt-0.5 text-[10px] text-gray-400 dark:text-slate-500">Endpoint {activity.subjectId}{activity.callId ? ` - call ${activity.callId}` : ''}{activity.reason ? ` - ${activity.reason}` : ''}</p>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="rounded-xl border border-gray-100 p-3 dark:border-slate-800">
            <p className="text-xs font-medium text-gray-700 dark:text-slate-200">Durable sessions</p>
            <ul className="mt-2 max-h-72 divide-y divide-gray-100 overflow-auto dark:divide-slate-800">
              {history.sessions.slice(0, 100).map((session) => {
                const time = companionTimestamp(session.lastEventAt);
                return (
                  <li key={session.id} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-gray-800 dark:text-slate-200">{session.mode} - {session.state}</p>
                      <time title={time.title ?? undefined} className="shrink-0 text-[10px] text-gray-400 dark:text-slate-500">{time.label}</time>
                    </div>
                    <p className="mt-0.5 text-[10px] text-gray-400 dark:text-slate-500">Endpoint {session.subjectId} - call {session.callId}{session.endReason ? ` - ${session.endReason}` : ''}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
