import { CheckCircle2, AlertCircle, Layers, List } from 'lucide-react';
import type { FormSection } from '../../lib/formDraft';
import { cn } from '../../lib/utils';

interface FormSectionNavProps {
  sections: FormSection[];
  activeIndex: number;
  onSelectSection: (index: number) => void;
  totalInputs: number;
  answeredCount: number;
  /** 'paged' shows one section at a time; 'all' stacks every section vertically. */
  sectionViewMode: 'paged' | 'all';
  onToggleSectionViewMode: (mode: 'paged' | 'all') => void;
  /** Accent hex color (form theme primary color). */
  primaryColor?: string;
  /** Optional dark surface theme flag (for public forms with dark theme). */
  darkSurface?: boolean;
  /** Optional border-radius class matching the form theme (`rounded-none`, `rounded-lg`, `rounded-2xl`, `rounded-3xl`). */
  radiusClass?: string;
  /** Force the compact top selector bar (e.g. inside the 375px Mobile frame of FormPreview on a wide monitor). */
  forceCompact?: boolean;
  /** Tailwind sticky top offset class for the desktop sidebar (default `'lg:top-6'`). */
  stickyTopClass?: string;
  /** Optional extra footer actions rendered inside the desktop sidebar card (e.g. Save/Load .json). */
  sidebarFooter?: React.ReactNode;
}

/**
 * Responsive multi-section navigation for large forms (e.g. hospital patient intake):
 *  - Mobile / Tablet (< lg): compact sticky top progress bar + section selector dropdown.
 *  - Desktop (>= lg): sticky left outline showing per-section status, completion checks, and error badges.
 */
export function FormSectionNav({
  sections,
  activeIndex,
  onSelectSection,
  totalInputs,
  answeredCount,
  sectionViewMode,
  onToggleSectionViewMode,
  primaryColor,
  darkSurface = false,
  radiusClass = 'rounded-2xl',
  forceCompact = false,
  stickyTopClass = 'lg:top-6',
  sidebarFooter,
}: FormSectionNavProps) {
  const pct = totalInputs > 0 ? Math.min(100, Math.round((answeredCount / totalInputs) * 100)) : 0;
  const accent = primaryColor && primaryColor.startsWith('#') ? primaryColor : undefined;

  return (
    <>
      {/* Mobile & tablet compact section bar */}
      <div
        className={cn(
          'mb-5 border p-3.5 shadow-sm',
          !forceCompact && 'lg:hidden',
          radiusClass,
          darkSurface
            ? 'border-white/10 bg-white/[0.04] text-white'
            : 'border-gray-200/90 bg-white/95 text-gray-900 dark:border-slate-800 dark:bg-slate-900/90 dark:text-white',
        )}
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-semibold">
            {sectionViewMode === 'paged'
              ? `Section ${activeIndex + 1} of ${sections.length}`
              : `${sections.length} sections`}
          </span>
          <span className={cn('tabular-nums', darkSurface ? 'text-white/70' : 'text-gray-500 dark:text-slate-400')}>
            {answeredCount} / {totalInputs} answered ({pct}%)
          </span>
        </div>

        <div className={cn('mt-2 h-1.5 w-full overflow-hidden rounded-full', darkSurface ? 'bg-white/10' : 'bg-gray-100 dark:bg-slate-800')}>
          <div
            className="h-full rounded-full transition-[width] duration-200"
            style={{ width: `${pct}%`, backgroundColor: accent ?? 'rgb(var(--primary-600))' }}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            aria-label="Jump to form section"
            value={activeIndex}
            onChange={(e) => {
              const idx = Number(e.target.value);
              onSelectSection(idx);
            }}
            className={cn(
              'min-w-0 flex-1 cursor-pointer rounded-lg border px-2.5 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary-500',
              darkSurface
                ? 'border-white/15 bg-slate-900 text-white'
                : 'border-gray-300 bg-white text-gray-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            )}
          >
            {sections.map((sec) => {
              const statusMark = sec.errorCount > 0 ? '!' : sec.isComplete ? '✓' : '';
              return (
                <option key={sec.id} value={sec.index}>
                  {sec.index + 1}. {sec.title} ({sec.answeredCount}/{sec.totalInputs}){statusMark ? ` ${statusMark}` : ''}
                </option>
              );
            })}
          </select>

          <button
            type="button"
            onClick={() => onToggleSectionViewMode(sectionViewMode === 'paged' ? 'all' : 'paged')}
            className={cn(
              'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors',
              darkSurface
                ? 'border-white/15 bg-white/5 text-white/85 hover:bg-white/10'
                : 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
            )}
            title={sectionViewMode === 'paged' ? 'Show all sections on one page' : 'Show one section at a time'}
          >
            {sectionViewMode === 'paged' ? (
              <><List className="h-3.5 w-3.5" aria-hidden="true" /><span>All</span></>
            ) : (
              <><Layers className="h-3.5 w-3.5" aria-hidden="true" /><span>Paged</span></>
            )}
          </button>
        </div>
      </div>

      {/* Desktop sticky section outline sidebar */}
      {!forceCompact && (
      <aside
        aria-label="Form sections"
        className={cn('hidden w-64 shrink-0 lg:block lg:sticky lg:self-start', stickyTopClass)}
      >
        <div
          className={cn(
            'max-h-[calc(100vh-3rem)] overflow-y-auto border p-4 shadow-sm',
            radiusClass,
            darkSurface
              ? 'border-white/10 bg-white/[0.04] text-white'
              : 'border-gray-200/90 bg-white/95 text-gray-900 dark:border-slate-800 dark:bg-slate-900/90 dark:text-white',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={cn('text-xs font-semibold uppercase tracking-wider', darkSurface ? 'text-white/70' : 'text-gray-500 dark:text-slate-400')}>
              Sections ({sections.length})
            </span>
            <button
              type="button"
              onClick={() => onToggleSectionViewMode(sectionViewMode === 'paged' ? 'all' : 'paged')}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                darkSurface
                  ? 'text-white/75 hover:bg-white/10 hover:text-white'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white',
              )}
              title={sectionViewMode === 'paged' ? 'Switch to all sections on one page' : 'Switch to section-by-section view'}
            >
              {sectionViewMode === 'paged' ? (
                <><List className="h-3 w-3" aria-hidden="true" /><span>View all</span></>
              ) : (
                <><Layers className="h-3 w-3" aria-hidden="true" /><span>By section</span></>
              )}
            </button>
          </div>

          <div className="mt-2.5">
            <div className="flex items-center justify-between text-[11px] tabular-nums">
              <span className={darkSurface ? 'text-white/75' : 'text-gray-600 dark:text-slate-300'}>
                {answeredCount} of {totalInputs} answered
              </span>
              <span className="font-semibold">{pct}%</span>
            </div>
            <div className={cn('mt-1.5 h-1.5 w-full overflow-hidden rounded-full', darkSurface ? 'bg-white/10' : 'bg-gray-100 dark:bg-slate-800')}>
              <div
                className="h-full rounded-full transition-[width] duration-200"
                style={{ width: `${pct}%`, backgroundColor: accent ?? 'rgb(var(--primary-600))' }}
              />
            </div>
          </div>

          <ol className="mt-3.5 space-y-1 max-h-[55vh] overflow-y-auto scrollbar-thin pr-0.5">
            {sections.map((sec) => {
              const isActive = sectionViewMode === 'paged' && sec.index === activeIndex;
              return (
                <li key={sec.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSection(sec.index)}
                    aria-current={isActive ? 'step' : undefined}
                    className={cn(
                      'flex w-full cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs transition-colors',
                      isActive
                        ? darkSurface
                          ? 'bg-white/15 font-semibold text-white'
                          : 'bg-primary-50 font-semibold text-primary-800 dark:bg-primary-500/15 dark:text-primary-200'
                        : darkSurface
                          ? 'text-white/80 hover:bg-white/10'
                          : 'text-gray-700 hover:bg-gray-100/80 dark:text-slate-300 dark:hover:bg-slate-800/70',
                    )}
                    style={isActive && accent ? { backgroundColor: `${accent}18`, color: darkSurface ? '#ffffff' : accent } : undefined}
                  >
                    <span className="mt-0.5 shrink-0">
                      {sec.errorCount > 0 ? (
                        <AlertCircle className="h-4 w-4 text-red-500" aria-hidden="true" />
                      ) : sec.isComplete ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                      ) : (
                        <span
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-bold',
                            isActive
                              ? 'border-current'
                              : darkSurface
                                ? 'border-white/30 text-white/70'
                                : 'border-gray-300 text-gray-500 dark:border-slate-600 dark:text-slate-400',
                          )}
                        >
                          {sec.index + 1}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate leading-snug">{sec.title}</span>
                      <span
                        className={cn(
                          'mt-0.5 block text-[10px] tabular-nums',
                          sec.errorCount > 0
                            ? 'font-medium text-red-600 dark:text-red-400'
                            : darkSurface
                              ? 'text-white/55'
                              : 'text-gray-500 dark:text-slate-400',
                        )}
                      >
                        {sec.errorCount > 0
                          ? `${sec.errorCount} ${sec.errorCount === 1 ? 'item needs' : 'items need'} attention`
                          : `${sec.answeredCount}/${sec.totalInputs} answered${sec.requiredCount > 0 ? ` · ${sec.requiredAnsweredCount}/${sec.requiredCount} req` : ''}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {sidebarFooter && (
            <div className={cn('mt-3.5 border-t pt-3', darkSurface ? 'border-white/10' : 'border-gray-100 dark:border-slate-800')}>
              {sidebarFooter}
            </div>
          )}
        </div>
      </aside>
      )}
    </>
  );
}
