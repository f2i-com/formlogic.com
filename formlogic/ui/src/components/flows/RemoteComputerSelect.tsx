import { useEffect, useId, useState } from 'react';
import { api } from '../../lib/api';
import { CONNECTION_FRESH_MS, parseDbTimestamp } from '../custom-screen/connector/runtimePresence';

type Computer = { desktopInstanceId: string; deviceName: string; lastSeenAt: string | null };

/** Uses account presence only: opening this control never probes localhost. */
export function RemoteComputerSelect({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const id = useId();
  const [computers, setComputers] = useState<Computer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await api.getDesktopConnections();
        if (!alive) return;
        setError(Boolean(response.error));
        if (!response.error) setComputers(response.data?.connections ?? []);
      } catch { if (alive) setError(true); }
      finally { if (alive) { setLoading(false); setCheckedAt(Date.now()); } }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refresh]);
  const missing = value !== '' && !computers.some((computer) => computer.desktopInstanceId === value);
  return (
    <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-gray-700 dark:text-slate-200">Linked computer</label>
        <button type="button" disabled={disabled || loading} onClick={() => { setLoading(true); setRefresh((n) => n + 1); }}
          className="text-xs text-primary-600 underline underline-offset-2 disabled:opacity-50 dark:text-primary-400">Refresh computers</button>
      </div>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}
        className="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-900 dark:text-white">
        <option value="">Use account assignment</option>
        {missing && <option value={value}>Selected computer unavailable</option>}
        {computers.map((computer) => {
          const seen = parseDbTimestamp(computer.lastSeenAt);
          const online = seen !== null && checkedAt - seen < CONNECTION_FRESH_MS;
          return <option key={computer.desktopInstanceId} value={computer.desktopInstanceId}>
            {computer.deviceName || 'OAIY computer'} · {online ? 'Online' : 'Offline'} · {computer.desktopInstanceId.slice(-6)}
          </option>;
        })}
      </select>
      <p role="status" className="text-xs leading-relaxed text-gray-500 dark:text-slate-400">
        {loading ? 'Loading linked computers…' : error ? 'Could not refresh computers. Your selection is kept; try Refresh.'
          : computers.length === 0 ? 'Open OAIY → Connections and link this FormLogic account to make a computer available.'
            : 'OAIY can run on another computer. Keep it open and linked to this FormLogic account. With no assignment, a single online computer is selected automatically.'}
      </p>
    </div>
  );
}
