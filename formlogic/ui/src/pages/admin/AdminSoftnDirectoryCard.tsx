// Admin → Platform: "SoftN directory" card (GET/PUT /api/admin/softn-directory).
//
// Where this site's people (and their AI agents, over MCP) can publish hosted SoftN apps for anyone to play: softn.com's
// public directory or another. Off until named: nothing on the site reaches a directory before. An agent only drafts
// and asks; publishing takes the app's owner approving on the draft's page, and the directory's edit key is kept here
// encrypted, which needs DATA_ENCRYPTION_KEY on the server.
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Panel } from '../../components/ui/Panel';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import type { SoftnDirectorySettings } from '../../types/app';
import { AdminError, AdminSpinner } from './adminUi';

export function AdminSoftnDirectoryCard() {
  const [settings, setSettings] = useState<SoftnDirectorySettings | null>(null);
  const [url, setUrl] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.adminGetSoftnDirectory().then((r) => {
      if (cancelled) return;
      if (r.data && typeof r.data === 'object' && 'url' in r.data) {
        setSettings(r.data);
        setUrl(r.data.url ?? '');
      } else {
        setLoadError(r.error || 'Could not load the SoftN directory setting');
      }
    });
    return () => { cancelled = true; };
  }, [attempt]);

  const save = async (next: string | null) => {
    setSaving(true);
    const r = await api.adminPutSoftnDirectory(next);
    setSaving(false);
    if (r.error || !r.data) {
      toast.error('Not saved', r.error || 'The setting could not be saved.');
      return;
    }
    setSettings(r.data);
    setUrl(r.data.url ?? '');
    toast.success(r.data.url ? `Publishing to ${r.data.url}` : 'Publishing to a SoftN directory is off');
  };

  return (
    <Panel
      title="SoftN directory"
      icon={<Globe className="h-4 w-4" />}
      actions={settings && <Badge variant={settings.url ? 'success' : 'default'}>{settings.url ? 'On' : 'Off'}</Badge>}
    >
      <div className="space-y-3">
        <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">
          Lets this site’s people publish their hosted SoftN apps to a public SoftN directory, where anyone can play them and
          read their source. Their AI agents can prepare a draft over MCP, but only the app’s owner publishes it, by approving
          it on its own page. Leave it empty to keep it off.
        </p>
        {loadError ? <AdminError message={loadError} onRetry={() => { setLoadError(null); setAttempt((n) => n + 1); }} /> : !settings ? <AdminSpinner /> : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 basis-56">
                <Input label="Directory address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://softn.com" disabled={saving} />
              </div>
              <Button className="max-sm:min-h-11" onClick={() => void save(url.trim() || null)} isLoading={saving} disabled={(url.trim() || null) === settings.url}>Save</Button>
              {settings.url && <Button className="max-sm:min-h-11" variant="outline" onClick={() => void save(null)} disabled={saving}>Turn off</Button>}
            </div>
            <p className={settings.keysEncrypted ? 'text-xs leading-5 text-gray-500 dark:text-slate-400' : 'text-xs font-medium leading-5 text-amber-700 dark:text-amber-300'}>
              {settings.keysEncrypted
                ? 'Each app’s edit key, which the directory gives when it publishes, is kept encrypted for the account that published it.'
                : 'Publishing needs DATA_ENCRYPTION_KEY set on this server, so the apps’ edit keys are kept encrypted. Until then it is refused.'}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
