import { useCallback, useEffect, useState } from 'react';
import { Plug, Copy, Loader2, Trash2, ShieldAlert, Sparkles, ChevronDown } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { LoadFailure } from '../ui/LoadFailure';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { formatRelativeTime, formatTimeUntil, copyToClipboard } from '../../lib/utils';

type Session = { id: string; appId: string | null; creator?: boolean; scopes?: string[]; expiresAt: string; idleTimeout: number; lastUsedAt: string | null; createdAt: string };
type NewToken = { token: string; mcpUrl: string; expiresAt: string; idleTimeout: number };

export function ConnectAiModal({ isOpen, onClose, appId, appName, creator = false }: { isOpen: boolean; onClose: () => void; appId?: string; appName?: string; creator?: boolean }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  // A failed read must not render as "No active connections": these are live grants
  // that let an outside AI act in this account, so an owner who cannot see one cannot
  // revoke it — and would reasonably conclude there was nothing to revoke.
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [fresh, setFresh] = useState<NewToken | null>(null);
  // The OAuth paste-the-URL path is primary; the manual flm_ token flow lives behind this.
  const [showManual, setShowManual] = useState(false);
  // Opt-in: also let the AI drive this account's FormLogic Desktop connectors (e.g. the Aokie phone).
  const [connectorAccess, setConnectorAccess] = useState(false);
  // Opt-in: also let the AI read submitted responses/data (`responses:read`).
  const [responsesAccess, setResponsesAccess] = useState(false);
  // Opt-in: also let the AI create/update/delete records (`responses:write` — implies read).
  // Writes run the SAME validated pipeline as the external API (incl. each form's onSubmit script).
  const [responsesWriteAccess, setResponsesWriteAccess] = useState(false);
  // The shared demo account only ever mints a READ-ONLY link (enforced server-side); reflect that here.
  const isDemo = useAuthStore((s) => s.user?.isDemo === true);

  // The MCP endpoint on THIS deployment — exactly what users paste into Claude/ChatGPT
  // (the server derives its OAuth issuer/resource from the same origin).
  const mcpUrl = `${window.location.origin}/api/mcp`;

  // Fetch only inside the async callback (no synchronous setState in the effect body).
  const load = useCallback(() => {
    api.listMcpTokens(appId)
      .then((r) => {
        if (r.error || !r.data) {
          setSessionsError(typeof r.error === 'string' ? r.error : 'Please try again.');
          return;
        }
        setSessions(r.data.sessions || []);
        setSessionsError(null);
      })
      .catch((e: unknown) => setSessionsError(e instanceof Error ? e.message : 'Please try again.'));
  }, [appId]);
  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  const handleClose = () => { setFresh(null); setShowManual(false); onClose(); };

  const generate = async () => {
    setGenerating(true);
    const extraScopes = [
      ...(responsesAccess || responsesWriteAccess ? ['responses:read'] : []),
      ...(responsesWriteAccess ? ['responses:write'] : []),
    ];
    const r = await api.createMcpToken(appId, creator, connectorAccess, extraScopes);
    setGenerating(false);
    if (r.error || !r.data) { toast.error('Could not create a connection.'); return; }
    setFresh(r.data);
    load();
  };

  const revoke = async (id: string) => {
    const r = await api.revokeMcpToken(id);
    if (r.error) { toast.error('Could not revoke.'); return; }
    toast.success('Connection revoked.');
    setSessions((s) => s.filter((x) => x.id !== id));
  };

  const copy = async (text: string, label: string) => {
    if (await copyToClipboard(text)) toast.success(`${label} copied`);
    else toast.error('Copy failed', 'Select the text and copy it manually.');
  };

  const configJson = fresh ? JSON.stringify({ mcpServers: { formlogic: { url: fresh.mcpUrl, headers: { Authorization: `Bearer ${fresh.token}` } } } }, null, 2) : '';

  // What the manual token still CANNOT do, given the current checkboxes — used by the access
  // summary below. Built as parts (joined with "or") rather than string-concatenated, since
  // whether "read submission data" applies now depends on the responsesAccess checkbox.
  const cannotParts = [
    !responsesAccess && !responsesWriteAccess && 'read submission data',
    !responsesWriteAccess && 'write records',
    creator && 'touch your existing apps',
  ].filter(Boolean) as string[];

  const title = (
    <span className="flex items-center gap-2">
      <Plug className="h-5 w-5 text-primary-600 dark:text-primary-400" /> Connect an AI
      <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-100 text-primary-700 dark:bg-primary-500/15 dark:text-primary-300">Beta</span>
    </span>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="lg">
      <div className="p-5 sm:p-6 space-y-5">
        {isDemo ? (
          <p className="text-sm text-gray-600 dark:text-slate-300">
            Give an external AI (Claude, Cursor, …) <span className="font-medium">read-only</span> access to explore {appName ? <span className="font-medium">{appName}</span> : 'this demo'} over MCP — it can view the forms, apps and submitted data, but <span className="font-medium">can&apos;t change anything</span> in this shared demo. The connection is <span className="font-medium">temporary</span>: it expires when idle and you can revoke it anytime.
          </p>
        ) : (
          <p className="text-sm text-gray-600 dark:text-slate-300">
            Give an external AI (Claude, Cursor, …) access to build and edit {appName ? <span className="font-medium">{appName}</span> : (creator ? <span className="font-medium">a brand-new app</span> : 'your apps')} over MCP — it can create forms, write custom screens, and wire up the app. The connection is <span className="font-medium">temporary</span>: it expires when idle and you can revoke it anytime.{creator ? ' The AI creates the app itself — nothing is added until it does.' : ''}
          </p>
        )}

        {/* PRIMARY: paste the MCP URL into a connector-capable client — OAuth handles the rest
            (the browser opens FormLogic's consent page; no token copying). */}
        <div className="space-y-3 rounded-xl border border-primary-200 dark:border-primary-500/30 bg-primary-50/50 dark:bg-primary-500/10 p-4">
          <p className="text-sm font-medium text-gray-900 dark:text-white">Add FormLogic to Claude or ChatGPT</p>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">MCP server URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded px-2 py-1.5 truncate">{mcpUrl}</code>
              <Button variant="outline" size="sm" onClick={() => copy(mcpUrl, 'URL')} leftIcon={<Copy className="h-3.5 w-3.5" />}>Copy</Button>
            </div>
          </div>
          <ol className="space-y-1.5 text-xs text-gray-600 dark:text-slate-300 list-decimal list-inside">
            <li><span className="font-medium">Claude:</span> Settings → Connectors → Add custom connector → paste the URL.</li>
            <li><span className="font-medium">ChatGPT:</span> Settings → Apps &amp; Connectors → Create → paste the URL.</li>
            <li>Approve access when your browser opens FormLogic{isDemo ? '' : ' — you can limit it to one app there'}.</li>
          </ol>
        </div>

        {/* Other MCP clients: the manual flm_ token flow (collapsible) */}
        <div>
          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            aria-expanded={showManual}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showManual ? '' : '-rotate-90'}`} />
            Other MCP clients (manual token)
          </button>

          {showManual && (
            <div className="mt-3 space-y-4">
              {fresh ? (
                <div className="space-y-3 rounded-xl border border-primary-200 dark:border-primary-500/30 bg-primary-50/50 dark:bg-primary-500/10 p-4">
                  <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                    <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>Copy this now — the token is shown once. {isDemo ? 'It is read-only, but still treat it like a password.' : 'It can create/edit your content, so treat it like a password.'} Idle-expires in {Math.round(fresh.idleTimeout / 60)} min.</span>
                  </div>
                  {isDemo ? (
                    <p className="text-[11px] text-gray-500 dark:text-slate-400">
                      Access: <span className="font-medium text-gray-700 dark:text-slate-300">read-only</span> · the AI can view apps, forms &amp; submitted data — <span className="font-medium">cannot make any changes</span> to this shared demo.
                    </p>
                  ) : (
                    <p className="text-[11px] text-gray-500 dark:text-slate-400">
                      Access: <span className="font-medium text-gray-700 dark:text-slate-300">{creator ? 'only the app it creates' : appId ? 'this app only' : 'all your apps'}</span> · can build forms, apps, screens &amp; flows{(responsesAccess || responsesWriteAccess) && (
                        <> and <span className="font-medium text-gray-700 dark:text-slate-300">{responsesWriteAccess ? 'read & write records' : 'read submitted response data'}</span></>
                      )}{cannotParts.length > 0 && (
                        <> — <span className="font-medium">cannot {cannotParts.join(' or ')}</span></>
                      )}.
                      {connectorAccess && (
                        <> Also lets it <span className="font-medium text-gray-700 dark:text-slate-300">control your linked FormLogic Desktop and its connectors</span> — that access covers your whole account, not just {creator ? 'the app it creates' : appId ? 'this app' : 'the apps you build'}.</>
                      )}
                    </p>
                  )}
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">MCP server URL</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded px-2 py-1.5 truncate">{fresh.mcpUrl}</code>
                      <Button variant="outline" size="sm" onClick={() => copy(fresh.mcpUrl, 'URL')} leftIcon={<Copy className="h-3.5 w-3.5" />}>Copy</Button>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Token (Bearer)</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded px-2 py-1.5 truncate">{fresh.token}</code>
                      <Button variant="outline" size="sm" onClick={() => copy(fresh.token, 'Token')} leftIcon={<Copy className="h-3.5 w-3.5" />}>Copy</Button>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Client config (add as a remote/HTTP MCP server)</p>
                    <pre className="text-[11px] leading-relaxed bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto"><code>{configJson}</code></pre>
                    <div className="flex justify-end mt-1.5">
                      <Button variant="outline" size="sm" onClick={() => copy(configJson, 'Config')} leftIcon={<Copy className="h-3.5 w-3.5" />}>Copy config</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {!isDemo && (
                    <>
                      <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                        <input type="checkbox" checked={connectorAccess} onChange={(e) => setConnectorAccess(e.target.checked)} className="mt-0.5 accent-primary-600" />
                        <span>Also let this AI <span className="font-medium">control your FormLogic Desktop</span> connectors — e.g. answer/hang up calls on the Aokie phone (<code>connector_command</code>). Needs a linked, running desktop.</span>
                      </label>
                      <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                        <input type="checkbox" checked={responsesAccess || responsesWriteAccess} disabled={responsesWriteAccess} onChange={(e) => setResponsesAccess(e.target.checked)} className="mt-0.5 accent-primary-600" />
                        <span>Also let this AI <span className="font-medium">read submitted responses/data</span> (<code>responses:read</code>).</span>
                      </label>
                      <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                        <input type="checkbox" checked={responsesWriteAccess} onChange={(e) => setResponsesWriteAccess(e.target.checked)} className="mt-0.5 accent-primary-600" />
                        <span>Also let this AI <span className="font-medium">create, update &amp; delete records</span> (<code>responses:write</code> — includes read). Writes run the same validated pipeline as the API, including each form&apos;s onSubmit script.</span>
                      </label>
                    </>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-gray-500 dark:text-slate-400">For clients without OAuth support (Cursor, custom scripts): generate a temporary Bearer token.</p>
                    <Button onClick={generate} disabled={generating} leftIcon={generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}>
                      {generating ? 'Generating…' : 'Generate connection'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">Active connections</p>
          {sessionsError ? (
            <LoadFailure
              compact
              title="We couldn't load your active connections"
              message={sessionsError}
              onRetry={() => { setSessionsError(null); load(); }}
            />
          ) : sessions.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-slate-500">No active connections.</p>
          ) : (
            <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 divide-y divide-gray-100 dark:divide-slate-800">
              {sessions.map((s) => (
                <div key={s.id} className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0 text-xs">
                    <p className="text-gray-700 dark:text-slate-200">
                      {s.creator ? 'New apps only' : s.appId ? 'One app' : 'All apps'}
                      {(s.scopes || []).includes('responses:write')
                        ? <span className="text-amber-600 dark:text-amber-400 font-medium"> · reads &amp; writes records</span>
                        : (s.scopes || []).includes('responses:read')
                          ? <span className="text-amber-600 dark:text-amber-400 font-medium"> · reads submissions</span>
                          : <span className="text-gray-400 dark:text-slate-500"> · no submission data</span>}
                      {(s.scopes || []).includes('connector:command')
                        ? <span className="text-primary-600 dark:text-primary-400 font-medium"> · controls desktop</span>
                        : null}
                    </p>
                    <p className="text-gray-400 dark:text-slate-500">Created {formatRelativeTime(s.createdAt)} · expires {formatTimeUntil(s.expiresAt)} · idle {Math.round(s.idleTimeout / 60)} min</p>
                  </div>
                  <button onClick={() => revoke(s.id)} className="text-gray-400 hover:text-red-500 cursor-pointer shrink-0" aria-label="Revoke connection"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
