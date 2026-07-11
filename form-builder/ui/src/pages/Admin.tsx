import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Boxes,
  Database,
  DownloadCloud,
  FileText,
  History,
  LogOut,
  Megaphone,
  Package,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import { Header } from '../components/layout/Header';
import { Card, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../components/ui/DataTable';
import { api, type AdminNotice, type AdminOverview, type AdminUpgradeStatus, type AdminUser, type AdminUserDetail, type MaintenanceStatus } from '../lib/api';
import { toast } from '../stores/toastStore';
import { useAuthStore } from '../stores/authStore';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/**
 * Platform admin panel (/admin — platform administrators only; the backend gate
 * is AdminGateMiddleware, this page just mirrors it client-side).
 *
 * Tabs: Overview (instance stats) · Users (directory → per-user apps/forms/
 * flows with record COUNTS and structural editors — never response data) ·
 * Maintenance (close the site, boot sessions, broadcast toasts) · Upgrade
 * (upload a release zip → auto backup → apply → rollback).
 */

type TabId = 'overview' | 'users' | 'maintenance' | 'upgrade';

const TABS: Array<{ id: TabId; label: string; icon: typeof Users }> = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench },
  { id: 'upgrade', label: 'Upgrade', icon: Package },
];

export function Admin() {
  useDocumentTitle('Admin');
  const isAdmin = useAuthStore((s) => !!s.user?.isAdmin);
  const [tab, setTab] = useState<TabId>('overview');

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950">
      <Header title="Admin" />
      <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto w-full">
        <div className="flex flex-wrap gap-2 mb-6">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={
                tab === id
                  ? 'inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-primary-foreground'
                  : 'inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'maintenance' && <MaintenanceTab />}
        {tab === 'upgrade' && <UpgradeTab />}
      </div>
    </div>
  );
}

/* ── Overview ─────────────────────────────────────────────────────────────── */

function StatTile({ icon: Icon, label, value, hint }: { icon: typeof Users; label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500 dark:text-slate-400">{label}</p>
          <p className="text-xl font-bold text-gray-900 dark:text-white">{value}</p>
          {hint && <p className="text-xs text-gray-400 dark:text-slate-500">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function OverviewTab() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.adminOverview().then((r) => {
      if (r.data) { setData(r.data); setError(null); } else { setError(r.error || 'Could not load'); }
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>;

  const s = data.stats;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile icon={Users} label="Users" value={s.users} hint={`${s.signups7d} new this week · ${s.admins} admin${s.admins === 1 ? '' : 's'}`} />
        <StatTile icon={Activity} label="Online now" value={s.onlineUsers} hint="seen in the last 5 minutes" />
        <StatTile icon={Boxes} label="Apps" value={s.apps} />
        <StatTile icon={FileText} label="Forms" value={s.forms} hint={`${s.responses.toLocaleString()} records`} />
        <StatTile icon={Workflow} label="Flows" value={s.flows} />
        <StatTile icon={Package} label="Version" value={data.version} />
        <StatTile icon={Wrench} label="Maintenance" value={data.maintenance.enabled ? 'ON' : 'off'} />
        <StatTile icon={LogOut} label="Session boot" value={data.sessionEpoch > 0 ? new Date(data.sessionEpoch * 1000).toLocaleString() : 'never'} hint="last global sign-out" />
      </div>
      <Button variant="outline" size="sm" onClick={load} leftIcon={<RefreshCw className="h-4 w-4" />}>Refresh</Button>
    </div>
  );
}

/* ── Users ────────────────────────────────────────────────────────────────── */

function UsersTab() {
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  // setState only inside the promise callback so the effect body stays render-clean
  // (loading starts true; later searches keep the previous rows visible).
  const load = useCallback(() => {
    api.adminListUsers(search, page + 1).then((r) => {
      if (r.data) { setRows(r.data.users); setTotal(r.data.total); }
      setLoading(false);
    });
  }, [search, page]);
  useEffect(() => { load(); }, [load]);

  const columns: Column<AdminUser>[] = useMemo(() => [
    {
      key: 'email', label: 'User',
      render: (u) => (
        <div className="min-w-0">
          <p className="font-medium text-gray-900 dark:text-white truncate">{u.email}</p>
          <p className="text-xs text-gray-500 dark:text-slate-400 truncate">
            {u.name || '—'}
            {u.isAdmin && <span className="ml-2 text-primary-600 dark:text-primary-400 font-semibold">admin</span>}
            {u.isDemo && <span className="ml-2 text-amber-600 dark:text-amber-400 font-semibold">demo</span>}
          </p>
        </div>
      ),
    },
    {
      key: 'online', label: 'Presence',
      render: (u) => u.online
        ? <Badge variant="success">online</Badge>
        : <span className="text-xs text-gray-500 dark:text-slate-400">{u.lastSeenAt ? `seen ${new Date(u.lastSeenAt).toLocaleString()}` : 'never seen'}</span>,
    },
    {
      key: 'resources', label: 'Resources',
      render: (u) => (
        <span className="text-xs text-gray-600 dark:text-slate-300">
          {u.appsCount ?? 0} apps · {u.formsCount ?? 0} forms · {u.flowsCount ?? 0} flows
        </span>
      ),
    },
    {
      key: 'responsesCount', label: 'Records',
      render: (u) => <span className="text-xs text-gray-600 dark:text-slate-300">{(u.responsesCount ?? 0).toLocaleString()}</span>,
    },
    { key: 'plan', label: 'Plan', render: (u) => <span className="text-xs">{u.plan}</span> },
  ], []);

  return (
    <div className="space-y-4">
      <DataTable<AdminUser & Record<string, unknown>>
        data={rows as Array<AdminUser & Record<string, unknown>>}
        columns={columns as Column<AdminUser & Record<string, unknown>>[]}
        serverMode
        totalCount={total}
        page={page}
        onPageChange={setPage}
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(0); }}
        searchable
        searchPlaceholder="Search email or name…"
        isLoading={loading}
        onRowClick={(u) => setSelected(String(u.id))}
        emptyMessage="No users match"
      />
      {selected && <UserDetailModal userId={selected} onClose={() => { setSelected(null); load(); }} />}
    </div>
  );
}

function UserDetailModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const me = useAuthStore((s) => s.user);
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [structure, setStructure] = useState<{ kind: 'form' | 'app' | 'flow'; id: string } | null>(null);
  const [confirmAdmin, setConfirmAdmin] = useState<boolean | null>(null);

  const load = useCallback(() => {
    api.adminGetUser(userId).then((r) => { if (r.data) setUser(r.data.user); });
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const toggleAdmin = async (next: boolean) => {
    const r = await api.adminSetAdmin(userId, next);
    if (r.error) toast.error('Could not update', r.error);
    else { toast.success(next ? 'Administrator access granted' : 'Administrator access removed'); load(); }
    setConfirmAdmin(null);
  };

  return (
    <Modal isOpen onClose={onClose} title={user ? user.email : 'User'} size="2xl">
      <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto">
        {!user ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-slate-300">
              <span>{user.name || 'No name'}</span>
              <span>· plan {user.plan}</span>
              <span>· joined {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</span>
              {user.online ? <Badge variant="success">online</Badge> : <span>· last seen {user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : 'never'}</span>}
              {!user.isDemo && user.id !== me?.id && (
                <Button size="sm" variant={user.isAdmin ? 'outline' : 'secondary'} onClick={() => setConfirmAdmin(!user.isAdmin)} leftIcon={<ShieldCheck className="h-3.5 w-3.5" />}>
                  {user.isAdmin ? 'Remove admin' : 'Make admin'}
                </Button>
              )}
            </div>

            <section>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Apps ({user.apps.length})</h3>
              {user.apps.length === 0 ? <p className="text-xs text-gray-400 dark:text-slate-500">None</p> : (
                <div className="space-y-1.5">
                  {user.apps.map((a) => (
                    <button key={a.id} type="button" onClick={() => setStructure({ kind: 'app', id: a.id })}
                      className="w-full text-left rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{a.name}</span>
                      <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                        {a.status} · {a.formCount} forms · {a.flowCount} flows · {a.memberCount} members
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Forms ({user.forms.length})</h3>
              {user.forms.length === 0 ? <p className="text-xs text-gray-400 dark:text-slate-500">None</p> : (
                <div className="space-y-1.5">
                  {user.forms.map((f) => (
                    <button key={f.id} type="button" onClick={() => setStructure({ kind: 'form', id: f.id })}
                      className="w-full text-left rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{f.title}</span>
                      <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                        {f.status} · {f.responseCount === null ? '?' : f.responseCount} records{f.apps ? ` · in ${f.apps}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Flows ({user.flows.length})</h3>
              {user.flows.length === 0 ? <p className="text-xs text-gray-400 dark:text-slate-500">None</p> : (
                <div className="space-y-1.5">
                  {user.flows.map((f) => (
                    <button key={f.id} type="button" onClick={() => setStructure({ kind: 'flow', id: f.id })}
                      className="w-full text-left rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800">
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{f.name}</span>
                      <span className="ml-2 text-xs text-gray-500 dark:text-slate-400">
                        {f.appName ? `app: ${f.appName}` : 'workspace'} · v{f.version} · {f.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
      {structure && <StructureModal kind={structure.kind} id={structure.id} onClose={() => setStructure(null)} />}
      <ConfirmDialog
        isOpen={confirmAdmin !== null}
        onClose={() => setConfirmAdmin(null)}
        onConfirm={() => confirmAdmin !== null && toggleAdmin(confirmAdmin)}
        title={confirmAdmin ? 'Grant administrator access?' : 'Remove administrator access?'}
        message={confirmAdmin
          ? 'This user will be able to manage every account, close the site and apply upgrades.'
          : 'This user will lose access to the admin panel.'}
        confirmLabel={confirmAdmin ? 'Grant admin' : 'Remove admin'}
        variant={confirmAdmin ? 'default' : 'danger'}
      />
    </Modal>
  );
}

/**
 * Structure viewer/editor for a user's form / app / flow. Structure ONLY —
 * the server never returns response data here, just counts. Edits go through
 * the same validated service paths the owner's own UI uses.
 */
function StructureModal({ kind, id, onClose }: { kind: 'form' | 'app' | 'flow'; id: string; onClose: () => void }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [meta, setMeta] = useState<string>('');
  const [json, setJson] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (kind === 'form') {
      api.adminGetForm(id).then((r) => {
        if (!r.data) return;
        const f = r.data.form;
        setData(f);
        setMeta(`${f.responseCount ?? '?'} records`);
        setJson(JSON.stringify({ title: f.title, status: f.status, fields: f.fields ?? [], settings: f.settings ?? {} }, null, 2));
      });
    } else if (kind === 'app') {
      api.adminGetApp(id).then((r) => {
        if (!r.data) return;
        setData(r.data.app);
        setMeta(`${r.data.forms.length} forms (${r.data.forms.map((f) => `${f.displayName ?? f.formId}: ${f.responseCount ?? '?'} records`).join(', ') || 'none'}) · ${r.data.flows.length} flows · ${r.data.bindings.length} bindings`);
        const a = r.data.app;
        setJson(JSON.stringify({ name: a.name, slug: a.slug, status: a.status, description: a.description ?? null }, null, 2));
      });
    } else {
      api.adminGetFlow(id).then((r) => {
        if (!r.data) return;
        setData(r.data.flow);
        const fl = r.data.flow as { version?: number; enabled?: boolean };
        setMeta(`version ${fl.version ?? '?'} · ${fl.enabled ? 'enabled' : 'disabled'}`);
        setJson(JSON.stringify({ name: r.data.flow.name, slug: r.data.flow.slug, enabled: r.data.flow.enabled, flowJson: r.data.flow.flowJson }, null, 2));
      });
    }
  }, [kind, id]);

  const save = async () => {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(json);
    } catch {
      toast.error('Invalid JSON', 'Fix the syntax before saving.');
      return;
    }
    setSaving(true);
    const r = kind === 'form' ? await api.adminUpdateForm(id, input)
      : kind === 'app' ? await api.adminUpdateApp(id, input)
      : await api.adminUpdateFlow(id, input);
    setSaving(false);
    if (r.error) toast.error('Save failed', r.error);
    else { toast.success('Saved', 'The change is live for the owner.'); onClose(); }
  };

  const titles = { form: 'Form structure', app: 'App structure', flow: 'Flow structure' } as const;
  return (
    <Modal isOpen onClose={onClose} title={titles[kind]} size="2xl">
      <div className="p-5 space-y-3">
        {!data ? (
          <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
        ) : (
          <>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              {meta} — record contents are never shown here; edit the structure below to help the owner
              (saved through the same validation their own editor uses).
            </p>
            <textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              spellCheck={false}
              className="w-full h-80 font-mono text-xs rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100 p-3"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={save} isLoading={saving}>Save changes</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── Maintenance ──────────────────────────────────────────────────────────── */

function MaintenanceTab() {
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [online, setOnline] = useState<number>(0);
  const [message, setMessage] = useState('');
  const [confirmBoot, setConfirmBoot] = useState(false);
  const [notices, setNotices] = useState<AdminNotice[]>([]);
  const [noticeText, setNoticeText] = useState('');
  const [noticeLevel, setNoticeLevel] = useState<'info' | 'warning' | 'success'>('info');
  const [noticeAudience, setNoticeAudience] = useState<'online' | 'all'>('online');

  const load = useCallback(() => {
    api.adminGetMaintenance().then((r) => {
      if (r.data) {
        setStatus(r.data.maintenance);
        setOnline(r.data.onlineUsers);
        setMessage((m) => m || r.data!.maintenance.message);
      }
    });
    api.adminListNotices().then((r) => { if (r.data) setNotices(r.data.notices); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (enabled: boolean) => {
    const r = await api.adminSetMaintenance(enabled, message);
    if (r.error) toast.error('Could not update maintenance mode', r.error);
    else {
      setStatus(r.data!.maintenance);
      toast.success(enabled ? 'Site closed for maintenance' : 'Site reopened');
    }
  };

  const boot = async () => {
    setConfirmBoot(false);
    const r = await api.adminBootSessions();
    if (r.error) toast.error('Could not boot sessions', r.error);
    else toast.success('All users signed out', 'Every non-admin session is now invalid.');
  };

  const sendNotice = async () => {
    if (!noticeText.trim()) return;
    const r = await api.adminCreateNotice(noticeText.trim(), noticeLevel, noticeAudience);
    if (r.error) toast.error('Could not send', r.error);
    else {
      toast.success('Notice sent', noticeAudience === 'online' ? 'Signed-in users will see it within a minute.' : 'Every user will see it once, until it expires.');
      setNoticeText('');
      load();
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                <Wrench className="h-4 w-4" /> Maintenance mode
                {status?.enabled ? <Badge variant="warning">ON — site closed</Badge> : <Badge variant="default">off</Badge>}
              </h3>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                Closes the whole site (dashboards, APIs and embedded forms show your message). Administrators keep full access.
              </p>
            </div>
            <div className="text-sm text-gray-600 dark:text-slate-300 flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-500" /> {online} user{online === 1 ? '' : 's'} online now
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Visitor-facing message (shown on dashboards and embedded forms)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              maxLength={500}
              className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-slate-100 p-3"
              placeholder="We are briefly down for maintenance. Please check back in a few minutes."
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {status?.enabled ? (
              <>
                <Button onClick={() => toggle(false)} leftIcon={<RefreshCw className="h-4 w-4" />}>Reopen the site</Button>
                <Button variant="outline" onClick={() => toggle(true)}>Update message</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => toggle(true)} leftIcon={<Wrench className="h-4 w-4" />}>Close site for maintenance</Button>
            )}
            <Button variant="outline" onClick={() => setConfirmBoot(true)} leftIcon={<LogOut className="h-4 w-4" />}>
              Sign everyone out
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Broadcast a message
          </h3>
          <p className="text-sm text-gray-500 dark:text-slate-400">
            Pops up as a toast on users&apos; dashboards. <strong>Signed-in now</strong> reaches current sessions
            (expires in an hour); <strong>all users</strong> stays live for a week so everyone sees it once.
          </p>
          <textarea
            value={noticeText}
            onChange={(e) => setNoticeText(e.target.value)}
            rows={2}
            maxLength={500}
            className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-slate-100 p-3"
            placeholder="e.g. Heads up — we're upgrading tonight at 10pm, expect a short outage."
          />
          <div className="flex flex-wrap items-center gap-3">
            <select value={noticeLevel} onChange={(e) => setNoticeLevel(e.target.value as typeof noticeLevel)}
              className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100">
              <option value="info">Info</option>
              <option value="warning">Warning (stays until dismissed)</option>
              <option value="success">Success</option>
            </select>
            <select value={noticeAudience} onChange={(e) => setNoticeAudience(e.target.value as typeof noticeAudience)}
              className="rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm p-2 text-gray-900 dark:text-slate-100">
              <option value="online">Users signed in now</option>
              <option value="all">All users</option>
            </select>
            <Button onClick={sendNotice} disabled={!noticeText.trim()} leftIcon={<Megaphone className="h-4 w-4" />}>Send</Button>
          </div>
          {notices.length > 0 && (
            <div className="space-y-1.5">
              {notices.slice(0, 8).map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                  <div className="min-w-0 text-sm">
                    <p className="text-gray-900 dark:text-white truncate">{n.message}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      {n.level} · {n.audience === 'online' ? 'signed-in users' : 'all users'} · {new Date(n.createdAt).toLocaleString()}
                      {!n.active && ' · ended'}
                    </p>
                  </div>
                  {n.active && (
                    <Button size="sm" variant="outline" onClick={async () => { await api.adminRevokeNotice(n.id); load(); }}>Retract</Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        isOpen={confirmBoot}
        onClose={() => setConfirmBoot(false)}
        onConfirm={boot}
        title="Sign every user out?"
        message="All non-admin sessions become invalid immediately — everyone will have to log in again. Your own admin session survives. Usually combined with maintenance mode."
        confirmLabel="Sign everyone out"
        variant="danger"
      />
    </div>
  );
}

/* ── Upgrade ──────────────────────────────────────────────────────────────── */

function UpgradeTab() {
  const [status, setStatus] = useState<AdminUpgradeStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [rollbackId, setRollbackId] = useState<string | null>(null);
  const [restoreDbId, setRestoreDbId] = useState<string | null>(null);
  const [journal, setJournal] = useState<string[] | null>(null);

  const load = useCallback(() => {
    api.adminUpgradeStatus().then((r) => { if (r.data) setStatus(r.data); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    setJournal(null);
    const r = await api.adminUpgradeUpload(file);
    setUploading(false);
    if (r.error) toast.error('Package rejected', r.error);
    else toast.success(`Package v${r.data!.staged.version} staged`, r.data!.staged.integrity === 'verified' ? 'All file checksums verified.' : 'No integrity manifest — an older package. Proceed only if you trust the source.');
    load();
  };

  const apply = async () => {
    setConfirmApply(false);
    setApplying(true);
    setJournal(null);
    const r = await api.adminUpgradeApply();
    setApplying(false);
    if (r.error) {
      toast.error('Upgrade failed', r.error);
    } else {
      setJournal(r.data!.journal);
      toast.success(`Upgraded to v${r.data!.toVersion}`, 'A database export and code snapshot were saved first.');
    }
    load();
  };

  const rollback = async () => {
    if (!rollbackId) return;
    const id = rollbackId;
    setRollbackId(null);
    const r = await api.adminUpgradeRollback(id);
    if (r.error) toast.error('Rollback failed', r.error);
    else {
      setJournal(r.data!.journal);
      toast.success(`Rolled back to v${r.data!.restoredVersion}`);
    }
    load();
  };

  const restoreDb = async () => {
    if (!restoreDbId) return;
    const id = restoreDbId;
    setRestoreDbId(null);
    const r = await api.adminUpgradeRestoreDb(id);
    if (r.error) toast.error('Database restore failed', r.error);
    else toast.success('Database restored', `${r.data!.statements.toLocaleString()} statements executed.`);
    load();
  };

  if (!status) return <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>;

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Package className="h-4 w-4" /> Current version: {status.currentVersion}
            </h3>
            <Badge variant={status.layout.supported ? 'success' : 'warning'}>
              layout: {status.layout.mode}
            </Badge>
          </div>
          {!status.layout.supported && (
            <p className="text-sm text-amber-600 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              This installation&apos;s folder layout wasn&apos;t recognized — set FORMLOGIC_WEB_ROOT in the backend .env to the folder holding index.html to enable in-place upgrades.
            </p>
          )}
          {status.layout.mode === 'dev' && (
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Dev checkout detected — applying here overwrites <code>ui/dist</code> and the backend source (both recoverable via git/rebuild).
            </p>
          )}

          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-slate-300">
              <strong>How it works:</strong> upload the release zip from GitHub (the same <code>formlogic-vX.Y.Z.zip</code> the CI attaches to
              each release) → the wizard verifies its checksums → applying closes the site, <strong>exports the database and snapshots the
              current code automatically</strong>, swaps the files and reopens. Your users&apos; form databases, uploads and .env are never touched.
            </p>
            <label className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-primary-foreground cursor-pointer hover:bg-primary-700">
              <UploadCloud className="h-4 w-4" />
              {uploading ? 'Validating…' : 'Upload release zip'}
              <input type="file" accept=".zip" className="hidden" disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
            </label>
          </div>

          {status.staged && (
            <div className="rounded-xl border border-primary-200 dark:border-primary-500/30 bg-primary-50/50 dark:bg-primary-500/10 p-4 space-y-2">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">
                Ready to install: v{status.staged.version}
                <span className="ml-2 text-xs font-normal text-gray-500 dark:text-slate-400">
                  (currently v{status.staged.currentVersion} · integrity {status.staged.integrity}
                  {status.staged.integrity === 'verified' && ` · ${status.staged.verifiedFiles} files checked`})
                </span>
              </p>
              {status.staged.isDowngrade && (
                <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> This package is OLDER than the running version.
                </p>
              )}
              <div className="flex gap-2">
                <Button onClick={() => setConfirmApply(true)} isLoading={applying} disabled={!status.layout.supported} leftIcon={<Package className="h-4 w-4" />}>
                  {applying ? 'Applying…' : `Install v${status.staged.version}`}
                </Button>
                <Button variant="outline" onClick={async () => { await api.adminUpgradeDiscard(); load(); }}>Discard</Button>
              </div>
            </div>
          )}

          {journal && (
            <div className="rounded-lg bg-gray-900 text-gray-100 p-3 text-xs font-mono space-y-1">
              {journal.map((line, i) => <p key={i}>✓ {line}</p>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Database className="h-4 w-4" /> Backups
            </h3>
            <Button size="sm" variant="outline" leftIcon={<DownloadCloud className="h-4 w-4" />}
              onClick={async () => {
                const r = await api.adminUpgradeExportDb();
                if (r.error) toast.error('Export failed', r.error);
                else toast.success('Database exported', `Backup ${r.data!.backupId} created.`);
                load();
              }}>
              Export database now
            </Button>
          </div>
          {status.backups.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-slate-500">No backups yet — one is created automatically before every upgrade.</p>
          ) : (
            <div className="space-y-1.5">
              {status.backups.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-slate-700 px-3 py-2">
                  <div className="text-sm min-w-0">
                    <p className="font-medium text-gray-900 dark:text-white">{b.id}</p>
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      {b.version ? `v${b.version} · ` : ''}{b.at ? new Date(b.at).toLocaleString() : ''} · {(b.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                      {b.hasCode ? ' · code' : ''}{b.hasDatabase ? ' · database' : ''}{b.manual ? ' · manual' : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {b.hasCode && (
                      <Button size="sm" variant="outline" onClick={() => setRollbackId(b.id)} leftIcon={<History className="h-3.5 w-3.5" />}>
                        Roll back code
                      </Button>
                    )}
                    {b.hasDatabase && (
                      <Button size="sm" variant="outline" onClick={() => setRestoreDbId(b.id)}>Restore DB…</Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {status.history.length > 0 && (
            <div className="pt-2">
              <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">History</p>
              <div className="text-xs text-gray-500 dark:text-slate-400 space-y-0.5">
                {status.history.slice(0, 8).map((h, i) => (
                  <p key={i}>
                    {new Date(h.at).toLocaleString()} — {h.action}
                    {h.fromVersion ? ` ${h.fromVersion} → ${h.toVersion}` : ''}
                    {h.backupId ? ` (backup ${h.backupId})` : ''}
                  </p>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        isOpen={confirmApply}
        onClose={() => setConfirmApply(false)}
        onConfirm={apply}
        title={`Install v${status.staged?.version}?`}
        message="The site closes for maintenance, the database is exported and the current code is snapshotted automatically, then the new files are applied and the site reopens. User form data (SQLite databases, uploads) and your .env are never touched. You can roll the code back from the backup afterwards."
        confirmLabel="Install upgrade"
      />
      <ConfirmDialog
        isOpen={rollbackId !== null}
        onClose={() => setRollbackId(null)}
        onConfirm={rollback}
        title="Roll back to this code snapshot?"
        message="The backend and frontend files are restored from the backup. The database is NOT touched (records created since the upgrade stay), and user form data is never affected."
        confirmLabel="Roll back code"
        variant="danger"
      />
      <ConfirmDialog
        isOpen={restoreDbId !== null}
        onClose={() => setRestoreDbId(null)}
        onConfirm={restoreDb}
        title="Restore the database export?"
        message="DESTRUCTIVE: the MySQL database is replaced with this backup's export — anything created after it (accounts, apps, form metadata) is lost. Per-form response databases (SQLite) are not affected. Only do this if an upgrade corrupted the database."
        confirmLabel="Restore database"
        variant="danger"
      />
    </div>
  );
}
