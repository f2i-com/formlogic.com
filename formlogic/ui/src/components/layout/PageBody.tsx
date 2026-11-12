// What stands under a workspace page's Header. Every signed-in page starts on the same line as
// its title (the header's own gutter) and takes the width it is given: lists and tables fill
// it, panels flow into more columns as it widens, and a form keeps a readable width of its own
// at the left. No page centres itself in a column.
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** The gutter the Header uses, for a page that lays its body out itself. */
export const PAGE_GUTTER = 'px-4 sm:px-6';
/** The body's whole frame as classes, for a page whose body is an element of its own already. */
export const PAGE_BODY = 'w-full px-4 pb-24 pt-4 sm:px-6';

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(PAGE_BODY, className)}>{children}</div>;
}
