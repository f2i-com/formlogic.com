// The look of a list on a workspace page (the admin pages and the recycle bin use it; see
// docs/WORKSPACE_PAGES.md): a table of dense rows while its box is wide enough, and the same rows
// as cards below that. The box's own width decides, not the screen's, since the sidebar takes its
// share.
//
// One set of rows serves both, so nothing is drawn twice and nothing is hidden from a reader:
// below the width a row is a block that lays its cells out itself (the page adds `grid …` to
// the row), each value under its column's name.
//
//   <div className="@container/list"><div className={LIST_BOX}>
//     <table className={LIST_TABLE}>
//       <thead className={LIST_HEAD}><tr><th scope="col" className={cn(LIST_TH, 'w-24')}>…</th></tr></thead>
//       <tbody className={LIST_BODY}>
//         <tr className={cn(LIST_ROW, 'grid grid-cols-3 gap-x-3 gap-y-1.5')}>
//           <td className={LIST_CELL}><span className={LIST_LABEL}>Apps</span>3</td>
//         </tr>
//       </tbody>
//     </table>
//   </div></div>

/** The bordered box a list stands in. */
export const LIST_BOX = 'overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900/60';
/** On the <table>. */
export const LIST_TABLE = 'block w-full border-collapse text-left text-[13px] leading-5 @xl/list:table @xl/list:table-fixed';
/** On the <thead>: the column names stand only where there are columns. */
export const LIST_HEAD = 'hidden border-b border-gray-200 bg-gray-50 text-[11px] text-gray-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400 @xl/list:table-header-group';
/** On each <th> of the head; add the column's width, and `text-right` over numbers. */
export const LIST_TH = 'h-8 px-2 font-semibold uppercase tracking-wider';
/** On the <tbody>. */
export const LIST_BODY = 'block @xl/list:table-row-group';
/** On each row; add the card's own layout, which the table ignores. */
export const LIST_ROW = 'border-b border-gray-100 px-3 py-2.5 last:border-b-0 hover:bg-gray-50 dark:border-slate-800 dark:hover:bg-white/[0.03] @xl/list:table-row';
/** On each cell. */
export const LIST_CELL = 'block min-w-0 @xl/list:table-cell @xl/list:px-2 @xl/list:py-1 @xl/list:align-middle';
/** A cell's column name: above its value on a card, left out of the table (its head says it). */
export const LIST_LABEL = 'block text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 @xl/list:hidden';

// Inside a panel there is no room for columns: a short list there is a box of rows with
// hairlines between them.

/** A box of rows inside a panel. */
export const ROW_BOX = 'divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 dark:divide-slate-800 dark:border-slate-700';
/** A row that says what a tool does, with its button at the right (under, when there is no room). */
export const TOOL_ROW = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5';
/** A row that is a link to the thing it names. */
export const LINK_ROW = 'block px-3 py-1.5 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50 dark:hover:bg-white/[0.03] max-sm:py-2.5';
/** A line of help, or the line that says a list is empty. */
export const HELP = 'text-xs leading-5 text-gray-500 dark:text-slate-400';
