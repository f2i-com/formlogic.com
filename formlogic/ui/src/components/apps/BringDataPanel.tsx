// An app's data from where it ran before (SoftN's PHP or Rust host, or another FormLogic): its
// SQLite database, and optionally that host's private configuration, for the key the data was kept
// under and, where it holds them, the Twilio Verify details the app signed people in with. The
// server checks the database before anything changes, installs it as the app's next version, and
// puts the app's earlier data back if the app does not start on it (NativeAppService::importData).
import { useRef, useState } from 'react';
import { Database, KeyRound } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { api, type NativeDataImport } from '../../lib/api';
import { readKeyFile } from '../../lib/appKeyFile';

export function BringDataPanel({ appId, disabled = false, waiting, onImported }: {
  appId: string;
  disabled?: boolean;
  /** Why it cannot be done just now (an unpublished draft open, say), shown instead of the button. */
  waiting?: string | null;
  onImported: (result: NativeDataImport) => void;
}) {
  const [database, setDatabase] = useState<File | null>(null);
  const [config, setConfig] = useState<File | null>(null);
  const [configInfo, setConfigInfo] = useState<{ twilio: boolean; appId: string | null } | null>(null);
  const [useTwilio, setUseTwilio] = useState(true);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const databaseInput = useRef<HTMLInputElement>(null);
  const configInput = useRef<HTMLInputElement>(null);

  const chooseConfig = async (file: File | null) => {
    setConfig(file); setConfigInfo(null); setError('');
    if (!file) return;
    const info = await readKeyFile(file);
    if ('error' in info) { setConfig(null); setError(info.error); return; }
    setConfigInfo(info);
  };

  const bring = async () => {
    if (!database) return;
    setConfirming(false); setWorking(true); setError('');
    const result = await api.importNativeData(appId, database, config, !!configInfo?.twilio && useTwilio);
    setWorking(false);
    if (result.error || !result.data) { setError(result.error || 'The data could not be brought in.'); return; }
    setDatabase(null); setConfig(null); setConfigInfo(null);
    onImported(result.data);
  };

  return <div className="space-y-3 text-sm">
    <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
      Moving an app here from SoftN&apos;s own hosting? Bring its database (<code>private/data/application.sqlite</code>) and, so what it sealed or keyed still reads, the key file it was kept under (<code>private/config.json</code>). Stop the old site first, so the copy is complete.
    </p>
    <input ref={databaseInput} type="file" accept=".sqlite,.db,.sqlite3,application/vnd.sqlite3,application/x-sqlite3" className="hidden" aria-label="Choose the app database" onChange={event => { setDatabase(event.target.files?.[0] ?? null); setError(''); event.target.value = ''; }} />
    <input ref={configInput} type="file" accept=".json,application/json" className="hidden" aria-label="Choose the key file" onChange={event => { void chooseConfig(event.target.files?.[0] ?? null); event.target.value = ''; }} />
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" leftIcon={<Database className="h-4 w-4" />} disabled={disabled || working} onClick={() => databaseInput.current?.click()}>{database ? 'Another database' : 'Choose the database'}</Button>
      {database && <span className="break-all text-xs text-slate-600 dark:text-slate-300">{database.name} · {(database.size / 1024).toFixed(0)} KB</span>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="ghost" leftIcon={<KeyRound className="h-4 w-4" />} disabled={disabled || working} onClick={() => configInput.current?.click()}>{config ? 'Another key file' : 'Add its key file (optional)'}</Button>
      {config && <span className="break-all text-xs text-slate-600 dark:text-slate-300">{config.name}</span>}
    </div>
    {configInfo?.twilio && <label className="flex items-start gap-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
      <input type="checkbox" className="mt-0.5" checked={useTwilio} onChange={event => setUseTwilio(event.target.checked)} disabled={disabled || working} />
      <span>It also holds Twilio Verify details: use them to send this app&apos;s sign-in codes.</span>
    </label>}
    {!config && database && <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">Without its key file the app keeps the key it has here: codes being sent at the move, and anything else the old site sealed, will not read. Accounts, profiles and messages are not sealed.</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    {waiting ? <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">{waiting}</p>
      : <Button size="sm" onClick={() => setConfirming(true)} disabled={disabled || !database} isLoading={working}>Bring this data</Button>}
    <ConfirmDialog
      isOpen={confirming}
      onClose={() => setConfirming(false)}
      onConfirm={() => void bring()}
      title="Replace this app's data?"
      message="Everything this app has stored here is replaced by the database you chose. If the app does not start on it, what it had is put back."
      confirmLabel="Replace its data"
      variant="danger"
    />
  </div>;
}
