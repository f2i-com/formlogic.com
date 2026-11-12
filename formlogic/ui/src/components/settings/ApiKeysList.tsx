// The account's API keys (Settings, Security), as rows: a table where the panel has room for its
// seven columns (more room than most lists need, so it changes to cards sooner than they do),
// and a short card per key where it has not. Every fact a key carries is on both, so nothing
// is lost on a phone. The room is the panel's own width, not the screen's.
import { Trash2 } from 'lucide-react';
import type { ApiKey } from '../../lib/api';
import { cn, parseServerDate } from '../../lib/utils';

const day = (at: string) => parseServerDate(at).toLocaleDateString();
const forms = (key: ApiKey) => (key.formIds && key.formIds.length > 0 ? `${key.formIds.length} ${key.formIds.length === 1 ? 'form' : 'forms'}` : 'All forms');

const revokeButton = 'inline-flex flex-none cursor-pointer items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-500 dark:hover:bg-red-500/10 dark:hover:text-red-400';
const heading = 'px-2 py-0 font-semibold uppercase tracking-wider';

function Prefix({ value }: { value: string }) {
  return <code className="flex-none rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-600 dark:bg-slate-700 dark:text-slate-300">{value}...</code>;
}

function Scopes({ scopes }: { scopes: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <span key={scope} className="rounded bg-primary-100 px-1.5 py-0.5 text-[10px] font-medium text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">{scope}</span>
      ))}
    </span>
  );
}

export function ApiKeysList({ keys, onRevoke }: { keys: ApiKey[]; onRevoke: (key: ApiKey) => void }) {
  return (
    <div className="@container/list">
      {/* Narrow: a card per key, its name on top and everything known of it under. */}
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 dark:divide-slate-800 dark:border-slate-700 @5xl/list:hidden">
        {keys.map((key) => (
          <li key={key.id} className="flex items-start gap-2 py-2 pl-3 pr-1.5">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 break-words text-sm font-medium text-gray-900 dark:text-white">{key.name}</span>
                <Prefix value={key.keyPrefix} />
              </p>
              <p className="mt-1.5"><Scopes scopes={key.scopes} /></p>
              <p className="mt-1 flex flex-wrap gap-x-2 text-xs leading-5 text-gray-500 dark:text-slate-400">
                <span className="min-w-0 break-words">{key.lastUsedAt ? `Last used ${day(key.lastUsedAt)}${key.lastUsedIp ? ` from ${key.lastUsedIp}` : ''}` : 'Never used'}</span>
                <span className="whitespace-nowrap">Created {day(key.createdAt)}</span>
                <span className="whitespace-nowrap">{key.expiresAt ? `Expires ${day(key.expiresAt)}` : 'Never expires'}</span>
                <span className="whitespace-nowrap">{forms(key)}</span>
              </p>
            </div>
            <button type="button" onClick={() => onRevoke(key)} aria-label={`Revoke ${key.name}`} title="Revoke key" className={cn(revokeButton, 'h-11 w-11')}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      {/* With room for it: the table. The name takes the spare width; the scopes column holds
          the three most keys have on one line, and more of them once the table is wide. */}
      <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-slate-700 @5xl/list:block">
        <table className="w-full table-fixed border-collapse text-left text-[13px] leading-5">
          <caption className="sr-only">API keys</caption>
          <thead className="border-b border-gray-200 bg-gray-50 text-[11px] text-gray-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
            <tr>
              <th scope="col" className={cn(heading, 'h-8 pl-3')}>Key</th>
              <th scope="col" className={cn(heading, 'w-[17.5rem] @7xl/list:w-[30rem]')}>Scopes</th>
              <th scope="col" className={cn(heading, 'w-48')}>Last used</th>
              <th scope="col" className={cn(heading, 'w-[5.5rem]')}>Created</th>
              <th scope="col" className={cn(heading, 'w-[5.5rem]')}>Expires</th>
              <th scope="col" className={cn(heading, 'w-20')}>Forms</th>
              <th scope="col" className="w-11 px-2 py-0"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              // A long address (IPv6) is cut at the column's edge: the tooltip has all of it.
              const lastUsed = key.lastUsedAt ? `${day(key.lastUsedAt)}${key.lastUsedIp ? ` from ${key.lastUsedIp}` : ''}` : 'Never';
              return (
                <tr key={key.id} className="h-10 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 dark:border-slate-800 dark:hover:bg-white/[0.03]">
                  <th scope="row" className="py-1 pl-3 pr-2 font-normal">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-semibold text-gray-900 dark:text-white" title={key.name}>{key.name}</span>
                      <Prefix value={key.keyPrefix} />
                    </span>
                  </th>
                  <td className="px-2 py-1"><Scopes scopes={key.scopes} /></td>
                  <td className="truncate px-2 tabular-nums text-gray-600 dark:text-slate-300" title={key.lastUsedIp ? lastUsed : undefined}>{lastUsed}</td>
                  <td className="truncate px-2 tabular-nums text-gray-500 dark:text-slate-400">{day(key.createdAt)}</td>
                  <td className="truncate px-2 tabular-nums text-gray-500 dark:text-slate-400">{key.expiresAt ? day(key.expiresAt) : 'Never'}</td>
                  <td className="truncate px-2 text-gray-500 dark:text-slate-400">{forms(key)}</td>
                  <td className="py-0.5 pl-2 pr-1.5 text-right">
                    <button type="button" onClick={() => onRevoke(key)} aria-label={`Revoke ${key.name}`} title="Revoke key" className={cn(revokeButton, 'h-8 w-8')}>
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
