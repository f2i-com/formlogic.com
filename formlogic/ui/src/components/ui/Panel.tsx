// One group of settings or facts on a management page: a bordered box with a small title.
// Panels are laid out by the page (`PANEL_COLUMNS`, or a grid), never centred one by one.
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Panel({ id, title, icon, description, actions, children, className }: {
  /** A panel a link can land on (…/settings#settings-look); it stops below the sticky header. */
  id?: string;
  title: ReactNode;
  icon?: ReactNode;
  /** One line under the title saying what the panel is for. */
  description?: ReactNode;
  /** What stands at the title's right: a link to the full page, a small button. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // scroll-mt: below the sticky header, and below the demo or acting-as bar when one stands over it.
    <section id={id} className={cn('min-w-0 scroll-mt-[calc(6rem+var(--fl-demo-banner-h,0px))] rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900', className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            {icon && <span className="text-primary-600 dark:text-primary-400" aria-hidden="true">{icon}</span>}
            {title}
          </h2>
          {description && <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">{description}</p>}
        </div>
        {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Panels in as many columns as fit, each as tall as what it holds: one column on a phone, two
    on a laptop, three on a wide screen. Put on the element that holds the panels. */
export const PANEL_COLUMNS = 'columns-1 gap-4 lg:columns-2 2xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid';
