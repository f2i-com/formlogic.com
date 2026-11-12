// The app's database inside the "Native app hosting" dialog (a forms app with a connected
// backend opens it from "Database records", and from a table in its App Studio).
// It is the data manager the SoftN app page has (components/data): the list of tables with
// their counts, Browse, Structure and Export, sorting, searching and filtering, editing in
// place. The one-table browser that stood here paged fifty rows at a time and searched only
// the page in view.
// A dialog has no address of its own, so the table, its view and what is being looked at in it
// (search, filters, sort, page, the open row) are held here, where the page keeps them in its
// address.
import { useState } from 'react';
import { DataManager, type DataView } from '../data';

/** `readOnly` (the shared demo): rows and their details can be browsed; adding and editing are not offered. */
export function NativeRecordsBrowser({ appId, appSlug, version, initialTable = '', readOnly = false }: { appId: string; appSlug?: string; version: number; initialTable?: string; readOnly?: boolean }) {
  const [at, setAt] = useState<{ table: string | undefined; view: DataView; query: string }>({ table: initialTable || undefined, view: 'browse', query: '' });
  return (
    // On a wide screen, what is left of the dialog (90dvh tall at most) under its heading, its
    // buttons and its tabs: the table list and the rows scroll inside it and the pager stays in
    // view. Narrower, it flows with the dialog, which scrolls.
    <section aria-label="Database records browser" className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900 lg:h-[calc(90dvh-26rem)] lg:min-h-[20rem]">
      <DataManager appId={appId} appSlug={appSlug} version={version} readOnly={readOnly} table={at.table} view={at.view} query={at.query}
        onNavigate={(table, view, query) => setAt({ table, view, query: query ?? '' })} className="h-full" />
    </section>
  );
}
