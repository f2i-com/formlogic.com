import { useCallback, useEffect, useState } from 'react';
import { Plug, Copy, Loader2, Trash2, ShieldAlert, Sparkles } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { formatRelativeTime, formatTimeUntil, copyToClipboard } from '../../lib/utils';

type Session = { id: string; appId: string | null; creator?: boolean; scopes?: string[]; expiresAt: string; idleTimeout: number; lastUsedAt: string | null; createdAt: string };
type NewToken = { token: string; mcpUrl: string; expiresAt: string; idleTimeout: number };

export function ConnectAiModal({ isOpen, onClose, appId, appName, creator = false }: { isOpen: boolean; onClose: () => void; appId?: string; appName?: string; creator?: boolean }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [generating, setGenerating] = useState(false);
  const [fresh, setFresh] = useState<NewToken | null>(null);
  // The shared demo account only ever mints a READ-ONLY link (enforced server-side); reflect that here.
  const isDemo = useAuthStore((s) => s.user?.isDemo === true);

  // Fetch only inside the async callback (no synchronous setState in the effect body).
  const load = useCallback(() => {
    api.listMcpTokens(appId).then((r) => { setSessions(r.data?.sessions || []); }).catch(() => {});
  }, [appId]);
  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  const handleClose = () => { setFresh(null); onClose(); };

  const generate = async () => {
    setGenerating(true);
    const r = await api.createMcpToken(appId, creator);
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
                Access: <span className="font-medium text-gray-700 dark:text-slate-300">{creator ? 'only the app it creates' : appId ? 'this app only' : 'all your apps'}</span> · can build forms, apps &amp; screens — <span className="font-medium">cannot read submission data</span>{creator ? ' or touch your existing apps' : ''}.
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
          <div className="flex justify-end">
            <Button onClick={generate} disabled={generating} leftIcon={generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}>
              {generating ? 'Generating…' : 'Generate connection'}
            </Button>
          </div>
        )}

        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">Active connections</p>
          {sessions.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-slate-500">No active connections.</p>
          ) : (
            <div className="rounded-xl border border-gray-200/80 dark:border-slate-700/60 divide-y divide-gray-100 dark:divide-slate-800">
              {sessions.map((s) => (
                <div key={s.id} className="p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0 text-xs">
                    <p className="text-gray-700 dark:text-slate-200">
                      {s.creator ? 'New apps only' : s.appId ? 'One app' : 'All apps'}
                      {(s.scopes || []).includes('responses:read')
                        ? <span className="text-amber-600 dark:text-amber-400 font-medium"> · reads submissions</span>
                        : <span className="text-gray-400 dark:text-slate-500"> · no submission data</span>}
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
