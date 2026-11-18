// Device connector check for the same commands available to installed apps.
// (phone abilities) through the SAME getConnectorClient() path apps use. Handy for
// verifying the connector in a browser, the PWA, and the FormLogic Native Runtime.
// Reachable at /device-check (append ?flDeviceMock for deterministic values).
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Play } from 'lucide-react';
import { getConnectorClient } from '../client-runtime/connectors/nativeConnectorClient';
import type { ConnectorStatusInfo } from '../client-runtime/connectors/connectorTypes';

interface Row {
  command: string;
  result?: unknown;
  error?: string;
  running?: boolean;
}

const PAYLOADS: Record<string, unknown> = {
  'clipboard.write': { text: 'Hello from FormLogic' },
  vibrate: { pattern: [120, 60, 120] },
};

export function DeviceCheck() {
  useDocumentTitle('Device connector');
  const client = getConnectorClient();
  const [status, setStatus] = useState<ConnectorStatusInfo | null>(null);
  const [native] = useState(() => getConnectorClient().isNativeAvailable());
  const [rows, setRows] = useState<Row[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    client
      .status('device')
      .then((st) => alive && setStatus(st))
      .catch(() => {});
    client
      .list()
      .then((list) => {
        const dev = list.find((c) => c.id === 'device');
        if (alive) {
          setRows((dev?.commands ?? []).map((command) => ({ command })));
          setListState('ready');
        }
      })
      .catch(() => { if (alive) setListState('error'); });
    return () => {
      alive = false;
    };
  }, [client]);

  async function run(command: string) {
    setRows((r) => r.map((x) => (x.command === command ? { ...x, running: true, error: undefined } : x)));
    try {
      const result = await client.request('device', command, PAYLOADS[command]);
      setRows((r) => r.map((x) => (x.command === command ? { command, result, running: false } : x)));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setRows((r) => r.map((x) => (x.command === command ? { command, error, running: false } : x)));
    }
  }

  return (
    <main className="min-h-dvh bg-gray-50 px-4 py-6 text-gray-900 dark:bg-slate-950 dark:text-white sm:py-12">
      <div className="mx-auto max-w-3xl">
        <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-700 hover:underline dark:text-primary-300"><ArrowLeft size={16} aria-hidden="true" />FormLogic home</Link>
        <header className="mb-6 mt-5">
          <h1 className="text-3xl font-bold tracking-tight">Device connector</h1>
          <p className="mt-2 text-gray-600 dark:text-slate-300">Run a command to check the capabilities available to apps in {native ? 'this native runtime' : 'this browser'}.</p>
          {status && (
            <p className="mt-4 rounded-xl border border-gray-200 bg-white p-3 text-sm leading-6 dark:border-slate-700 dark:bg-slate-900">
              <strong>Connector {status.available ? 'available' : 'unavailable'}</strong>
              {status.detail && <span className="block text-gray-600 dark:text-slate-300">{status.detail}</span>}
            </p>
          )}
        </header>

        {rows.length === 0 && <p role="status" className="text-sm text-gray-600 dark:text-slate-300">
          {listState === 'loading' ? 'Checking available commands…' : listState === 'error' ? 'Could not load the device commands. Reload this page to try again.' : 'This device has no available commands.'}
        </p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.command} className="min-w-0 rounded-xl border border-gray-200 bg-white px-4 dark:border-slate-700 dark:bg-slate-900">
              <button
                type="button" disabled={row.running} onClick={() => run(row.command)}
                aria-label={`Run ${row.command}`}
                className="flex min-h-14 w-full items-center justify-between gap-3 text-left disabled:opacity-60"
              >
                <code className="break-all text-sm font-semibold">{row.command}</code>
                <span className="inline-flex items-center gap-1.5 text-sm text-primary-700 dark:text-primary-300"><Play size={13} aria-hidden="true" />{row.running ? 'Running…' : 'Run'}</span>
              </button>
              <div aria-live="polite">
                {row.error && <p className="mb-4 break-words text-sm text-red-700 dark:text-red-300">{row.error}</p>}
                {row.result !== undefined && <pre className="mb-4 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-100 p-3 text-xs leading-relaxed dark:bg-slate-950">{JSON.stringify(row.result, null, 2)}</pre>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
