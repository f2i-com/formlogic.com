// Device connector check — a small surface that exercises the `device` connector
// (phone abilities) through the SAME getConnectorClient() path apps use. Handy for
// verifying the connector in a browser, the PWA, and the FormLogic Native Runtime.
// Reachable at /device-check (append ?flDeviceMock for deterministic values).
import { useEffect, useState } from 'react';
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
  const client = getConnectorClient();
  const [status, setStatus] = useState<ConnectorStatusInfo | null>(null);
  const [native] = useState(() => getConnectorClient().isNativeAvailable());
  const [rows, setRows] = useState<Row[]>([]);

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
        if (alive) setRows((dev?.commands ?? []).map((command) => ({ command })));
      })
      .catch(() => {});
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
    <div style={S.page}>
      <div style={S.wrap}>
        <header style={S.head}>
          <h1 style={S.h1}>Device connector</h1>
          <span style={{ ...S.badge, ...(native ? S.badgeOk : {}) }}>
            {native ? 'native runtime' : 'browser'}
          </span>
        </header>
        {status && (
          <p style={S.detail}>
            <code style={S.code}>device</code> · {status.available ? 'available' : 'unavailable'} ·{' '}
            {status.detail}
          </p>
        )}
        <p style={S.hint}>
          The phone's abilities as an abstract connector — the same <code style={S.code}>connector.request('device', …)</code>{' '}
          apps use. Tap a capability to read it.
        </p>

        <div style={S.grid}>
          {rows.map((row) => (
            <button key={row.command} type="button" style={S.card} onClick={() => run(row.command)}>
              <div style={S.cardHead}>
                <span style={S.cmd}>{row.command}</span>
                <span style={S.run}>{row.running ? '…' : 'run ▸'}</span>
              </div>
              {row.error && <div style={S.err}>{row.error}</div>}
              {row.result !== undefined && (
                <pre style={S.pre}>{JSON.stringify(row.result, null, 2)}</pre>
              )}
            </button>
          ))}
          {rows.length === 0 && <p style={S.hint}>No device capabilities detected.</p>}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { minHeight: '100dvh', background: '#080b16', color: '#eaeefb', fontFamily: 'system-ui, sans-serif' },
  wrap: { maxWidth: 760, margin: '0 auto', padding: '28px 18px 48px' },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  h1: { fontSize: 22, fontWeight: 700, margin: 0 },
  badge: { fontSize: 12, padding: '5px 11px', borderRadius: 999, border: '1px solid #212c48', color: '#8a97ba' },
  badgeOk: { color: '#34d399', borderColor: 'rgba(52,211,153,0.35)' },
  detail: { color: '#8a97ba', fontSize: 13, margin: '10px 0 0' },
  hint: { color: '#8a97ba', fontSize: 13, lineHeight: 1.5, margin: '8px 0 18px' },
  code: { fontFamily: 'ui-monospace, monospace', color: '#fbbf24', fontSize: 12 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  card: { textAlign: 'left', background: 'linear-gradient(180deg,#111830,#0e1428)', border: '1px solid #1a2338', borderRadius: 14, padding: 14, color: '#eaeefb', cursor: 'pointer' },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cmd: { fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600 },
  run: { fontSize: 11, color: '#fbbf24' },
  err: { marginTop: 8, color: '#f87171', fontSize: 12 },
  pre: { marginTop: 8, background: 'rgba(4,8,18,0.7)', border: '1px solid #1a2338', borderRadius: 10, padding: 10, fontSize: 11, lineHeight: 1.5, color: '#cbd5e1', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
};
