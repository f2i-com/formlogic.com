import { useCallback, useEffect, useState } from 'react';
import { api, type ConnectorAssignments } from '../../lib/api';
import { parseServerDate } from '../../lib/utils';
import { toast } from '../../stores/toastStore';

/**
 * Connector routing (ROUTE-001): which linked desktop services a connector's
 * relay commands (e.g. which machine's Aokie dongle answers the phone).
 *
 * Renders one row per connector→app assignment with a machine picker. "Auto"
 * (no pin) works while exactly ONE desktop is online; with two or more online
 * and no pin, remote commands are refused as ambiguous — this picker is how
 * the owner resolves that. Hidden entirely when the owner has no assignments
 * (nothing routable) — routing only matters once a connector is set up.
 */
export function ConnectorRoutingPanel() {
  const [data, setData] = useState<ConnectorAssignments | null>(null);
  const [savingConnector, setSavingConnector] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getConnectorAssignments();
      if (res.data) setData(res.data);
    } catch {
      // Silent: this panel is supplementary — the desktops list above already
      // surfaces connectivity problems.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data || data.assignments.length === 0) return null;

  const fresh = (lastSeenAt: string | null) =>
    lastSeenAt !== null && Date.now() - parseServerDate(lastSeenAt).getTime() < 90_000;

  const pick = async (connectorId: string, appId: string, desktopConnectionId: string | null) => {
    setSavingConnector(connectorId);
    try {
      const res = await api.putConnectorAssignment({ connectorId, appId, desktopConnectionId });
      if (res.data) {
        setData(res.data);
        toast.success(
          'Connector routing updated',
          desktopConnectionId === null
            ? `${connectorId} commands route automatically while one desktop is online.`
            : `${connectorId} commands now go to the selected machine only.`,
        );
      } else {
        toast.error('Could not update routing', res.error || 'Unknown error');
      }
    } catch {
      toast.error('Could not update routing', 'An unexpected error occurred');
    } finally {
      setSavingConnector(null);
    }
  };

  const onlineCount = data.desktops.filter((d) => fresh(d.lastSeenAt)).length;

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700">
      <p className="text-sm font-medium text-gray-900 dark:text-white">Connector routing</p>
      <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
        Which machine runs each connector's remote commands (calls, SMS).
        {onlineCount > 1 && (
          <span className="text-amber-600 dark:text-amber-400">
            {' '}
            {onlineCount} desktops are online — unpinned connectors will refuse remote commands as
            ambiguous until you pick one.
          </span>
        )}
      </p>
      <div className="mt-3 space-y-2">
        {data.assignments.map((a) => (
          <div
            key={a.connectorId}
            className="flex flex-wrap items-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/50"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{a.connectorId}</p>
              <p className="text-xs text-gray-400 dark:text-slate-500">app: {a.appName}</p>
            </div>
            <select
              className="text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-white px-2 py-1.5"
              value={a.desktopConnectionId ?? ''}
              disabled={savingConnector === a.connectorId}
              onChange={(e) => pick(a.connectorId, a.appId, e.target.value === '' ? null : e.target.value)}
            >
              <option value="">Auto (single online desktop)</option>
              {data.desktops.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deviceName}
                  {fresh(d.lastSeenAt) ? ' — online' : ' — offline'}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
