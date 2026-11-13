import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * One tool in a list of tools, the same shape for every tool: its icon in a quiet tile, a title,
 * one plain sentence saying what the owner gets, and its button or buttons at the right. Anything
 * more a tool needs (a choice, a few links, what just happened) goes under the sentence as children.
 *
 * The row measures itself, not the page: where it is narrow (a phone, a narrow column) the buttons
 * drop under the text. The studio's own width is no guide to that, since its content column is
 * narrower just above the width where the screen list moves beside it than just below.
 *
 * A list of these is any element marked `data-tool-list` that draws one rounded border and a
 * hairline between its children (`divide-y`): a row inside one draws no frame. Standing alone on a
 * page, a row draws its own.
 */
export function ToolRow({ icon: Icon, title, description, actions, children }: {
  icon: LucideIcon;
  title: ReactNode;
  /** One plain sentence: what the owner gets. */
  description: ReactNode;
  /** The tool's button or buttons. */
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="@container/tool min-w-0">
      <div className="flex flex-col gap-3 rounded-xl border border-gray-200/80 p-4 in-data-tool-list:rounded-none in-data-tool-list:border-0 @2xl/tool:flex-row @2xl/tool:flex-wrap @2xl/tool:items-start @2xl/tool:gap-x-4 dark:border-white/[0.06]">
        {/* The text keeps a width worth reading: buttons that would squeeze it go under it, still at the right. */}
        <div className="flex min-w-0 gap-3 @2xl/tool:flex-[1_1_20rem]">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-white/[0.05] dark:text-slate-400">
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-gray-500 dark:text-slate-400">{description}</p>
            {children}
          </div>
        </div>
        {/* In a narrow row the buttons start where the title does, and are a full finger tall. */}
        <div className="flex flex-wrap gap-2 pl-12 *:min-h-11 @2xl/tool:ml-auto @2xl/tool:justify-end @2xl/tool:pl-0 @2xl/tool:*:min-h-10">{actions}</div>
      </div>
    </section>
  );
}
