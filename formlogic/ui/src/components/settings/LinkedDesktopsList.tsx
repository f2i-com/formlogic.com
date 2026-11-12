// The computers linked to the account (Settings, AI & devices), as rows: a table where the panel
// has room for one, and a short card per computer where it has not (a phone, a narrow column).
// The room is the panel's own width, not the screen's: the sidebar and the page's columns take
// their share first.
import { Trash2 } from 'lucide-react';
import type { DesktopConnection } from '../../lib/api';
import { cn, formatRelativeTime } from '../../lib/utils';

const unlinkButton = 'inline-flex flex-none cursor-pointer items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-500 dark:hover:bg-red-500/10 dark:hover:text-red-400';

function AiOnly() {
  return (
    <span className="inline-flex flex-none items-center rounded bg-primary-100 px-1.5 py-0.5 text-[10px] font-medium text-primary-700 dark:bg-primary-500/20 dark:text-primary-300"
      title="Linked for AI only: it answers AI requests and takes no commands, flows or backups">
      AI only
    </span>
  );
}

function Online() {
  return (
    <span className="inline-flex flex-none items-center gap-1.5 font-medium text-green-700 dark:text-green-400">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green-500" />
      Online now
    </span>
  );
}

export function LinkedDesktopsList({ connections, isOnline, onUnlink }: {
  connections: DesktopConnection[];
  /** Whether a computer was heard from just now; the page decides, and goes on deciding while it stays open. */
  isOnline: (connection: DesktopConnection) => boolean;
  onUnlink: (connection: DesktopConnection) => void;
}) {
  const lastSeen = (connection: DesktopConnection) => (connection.lastSeenAt ? `Last seen ${formatRelativeTime(connection.lastSeenAt)}` : 'Never connected');

  return (
    <div className="@container/list">
      {/* Narrow: a card per computer, its name on top and what is known of it under. */}
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 dark:divide-slate-800 dark:border-slate-700 @xl/list:hidden">
        {connections.map((connection) => {
          const online = isOnline(connection);
          return (
            <li key={connection.id} className="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-900 dark:text-white">
                  <span className="min-w-0 break-words">{connection.deviceName}</span>
                  {connection.aiOnly && <AiOnly />}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs leading-5 text-gray-500 dark:text-slate-400">
                  {online ? <Online /> : <span className="whitespace-nowrap">{lastSeen(connection)}</span>}
                  <span className="whitespace-nowrap">Linked {formatRelativeTime(connection.createdAt)}</span>
                </p>
              </div>
              <button type="button" onClick={() => onUnlink(connection)} aria-label={`Unlink ${connection.deviceName}`} title="Unlink desktop" className={cn(unlinkButton, 'h-11 w-11')}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      {/* With room for it: the table. The name takes the spare width. */}
      <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-slate-700 @xl/list:block">
        <table className="w-full table-fixed border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">Linked desktops</caption>
          <thead className="border-b border-gray-200 bg-gray-50 text-[11px] text-gray-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
            <tr>
              <th scope="col" className="h-8 py-0 pl-3 pr-2 font-semibold uppercase tracking-wider">Computer</th>
              <th scope="col" className="w-44 px-2 py-0 font-semibold uppercase tracking-wider">Last seen</th>
              <th scope="col" className="w-32 px-2 py-0 font-semibold uppercase tracking-wider">Linked</th>
              <th scope="col" className="w-12 px-2 py-0"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {connections.map((connection) => {
              const online = isOnline(connection);
              return (
                <tr key={connection.id} className="h-10 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 dark:border-slate-800 dark:hover:bg-white/[0.03]">
                  <th scope="row" className="py-1 pl-3 pr-2 font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-semibold text-gray-900 dark:text-white" title={connection.deviceName}>{connection.deviceName}</span>
                      {connection.aiOnly && <AiOnly />}
                    </span>
                  </th>
                  <td className="truncate px-2 text-gray-600 dark:text-slate-300">
                    {online ? <Online /> : connection.lastSeenAt ? formatRelativeTime(connection.lastSeenAt) : 'Never connected'}
                  </td>
                  <td className="truncate px-2 text-gray-500 dark:text-slate-400">{formatRelativeTime(connection.createdAt)}</td>
                  <td className="py-0.5 pl-2 pr-1.5 text-right">
                    <button type="button" onClick={() => onUnlink(connection)} aria-label={`Unlink ${connection.deviceName}`} title="Unlink desktop" className={cn(unlinkButton, 'h-8 w-8')}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
