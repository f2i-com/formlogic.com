import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, Plus, Clock, LayoutGrid, Building, MessageCircle, CalendarDays, Users, GraduationCap, Mail, Briefcase, Newspaper, Bug, PartyPopper, FileText, Check, Lock } from 'lucide-react';
import { DIALOG_CLOSE, DIALOG_DESCRIPTION, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_PANEL, DIALOG_TITLE, GROUP_TITLE } from './builderDialog';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { cn } from '../../lib/utils';
import type { FormTemplate } from '../../data/formTemplates';
import { useFormTemplates } from '../../hooks/useFormTemplates';

interface TemplateSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (template: FormTemplate | null, makePrivate?: boolean, name?: string) => void;
  isCreating?: boolean;
  /** Offer the "Private (end-to-end encrypted)" opt-in (requires an unlocked vault). */
  canMakePrivate?: boolean;
}

const iconMap: Record<string, React.ReactNode> = {
  Mail: <Mail className="h-6 w-6" />,
  MessageCircle: <MessageCircle className="h-6 w-6" />,
  CalendarDays: <CalendarDays className="h-6 w-6" />,
  Briefcase: <Briefcase className="h-6 w-6" />,
  Newspaper: <Newspaper className="h-6 w-6" />,
  Bug: <Bug className="h-6 w-6" />,
  GraduationCap: <GraduationCap className="h-6 w-6" />,
  PartyPopper: <PartyPopper className="h-6 w-6" />,
  FileText: <FileText className="h-6 w-6" />,
};

const categoryIconMap: Record<string, React.ReactNode> = {
  LayoutGrid: <LayoutGrid className="h-4 w-4" />,
  Building: <Building className="h-4 w-4" />,
  MessageCircle: <MessageCircle className="h-4 w-4" />,
  CalendarDays: <CalendarDays className="h-4 w-4" />,
  Users: <Users className="h-4 w-4" />,
  GraduationCap: <GraduationCap className="h-4 w-4" />,
};

// A template's picture: plain, and the accent when it is the one chosen. A colour for each
// category (blue, purple, orange, green, yellow) said nothing the category list beside it does
// not, and none of them is one of the product's colours.
const PLAIN_TILE = 'bg-gray-100 text-gray-600 dark:bg-slate-700/70 dark:text-slate-300';
const SELECTED_TILE = 'bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300';

export function TemplateSelector({ isOpen, onClose, onSelectTemplate, canMakePrivate = false, isCreating = false }: TemplateSelectorProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [makePrivate, setMakePrivate] = useState(false);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<FormTemplate | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isCreating) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, isCreating]);

  const { templates: formTemplates, categories: templateCategories, loading, error, skipped, refresh } = useFormTemplates(isOpen);
  const currentTemplate = formTemplates.find(template => template.id === selected?.id) ?? null;
  const category = templateCategories.some(category => category.id === selectedCategory) ? selectedCategory : 'all';

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const filteredTemplates = formTemplates.filter(t =>
    (category === 'all' || t.category === category) &&
    `${t.name} ${t.description}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  // Portal to <body> so the overlay covers the whole window — when rendered inside a
  // sidebar/nav that has backdrop-filter (which creates a containing block), a bare
  // `position: fixed` overlay would otherwise be trapped inside that element.
  return createPortal(
    <div className={DIALOG_OVERLAY}>
      <div className="absolute inset-0" onClick={() => { if (!isCreating) onClose(); }} aria-hidden="true" />
      {/* A chooser: it keeps one height whatever the category holds, and on a phone most of the screen. */}
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="template-selector-title" aria-busy={isCreating} className={cn(DIALOG_PANEL, 'h-[88dvh] max-w-5xl max-sm:h-[92dvh] max-sm:max-h-[92dvh]')}>
        {/* Header */}
        <div className={DIALOG_HEADER}>
          <div className="min-w-0 flex-1 pr-2">
            <h2 id="template-selector-title" className={DIALOG_TITLE}>Create new form</h2>
            <p className={DIALOG_DESCRIPTION}>Start with a blank form or with a template.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className={cn(DIALOG_CLOSE, 'disabled:cursor-not-allowed disabled:opacity-50')}
            aria-label="Close"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content — stack on mobile (category tabs on top), side-by-side on desktop */}
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row min-h-0">
          {/* Sidebar - Categories */}
          <div className="w-48 shrink-0 overflow-y-auto border-r border-gray-200 dark:border-slate-800 p-3 hidden md:block bg-gray-50/50 dark:bg-slate-900/50">
            <nav aria-label="Template categories" className="space-y-0.5">
              {templateCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setSelectedCategory(category.id)}
                  aria-current={(templateCategories.some(item => item.id === selectedCategory) ? selectedCategory : 'all') === category.id ? 'true' : undefined}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg motion-safe:transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                    (templateCategories.some(item => item.id === selectedCategory) ? selectedCategory : 'all') === category.id
                      ? 'bg-primary-50 text-primary-700 dark:bg-primary-500/10 dark:text-primary-400 font-medium'
                      : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800'
                  )}
                >
                  {categoryIconMap[category.icon] || <LayoutGrid className="h-4 w-4" />}
                  {category.label}
                </button>
              ))}
            </nav>
          </div>

          <label className="md:hidden flex items-center gap-3 flex-shrink-0 px-4 py-2 text-sm text-gray-600 dark:text-slate-300 border-b border-gray-200 dark:border-slate-800">
            Category
            <select value={category} onChange={event => setSelectedCategory(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 min-h-11 text-base">
              {templateCategories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
            </select>
          </label>

          {/* Templates Grid */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
            <div className="mb-5 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-gray-700 dark:text-slate-200">Form name <span className="font-normal text-gray-500 dark:text-slate-400">(optional)</span>
                <input value={name} onChange={e => setName(e.target.value)} maxLength={120} disabled={isCreating} placeholder={selected?.name || "Untitled Form"} className="mt-1 block w-full min-h-11 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-base" />
                <span className="mt-1.5 block text-xs font-normal text-gray-500 dark:text-slate-400">Leave blank to start now. Rename it in the builder or your forms list.</span>
              </label>
              <label className="text-sm font-medium text-gray-700 dark:text-slate-200">Find a template
                <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search templates" className="mt-1 block w-full min-h-11 rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-base" />
              </label>
            </div>
            {canMakePrivate && <div className="mb-5 rounded-xl bg-gray-50 dark:bg-slate-800/50 p-3">
            {canMakePrivate && (
              <label className="flex min-h-11 items-center gap-2 text-sm text-gray-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={makePrivate}
                  disabled={isCreating}
                  onChange={(e) => setMakePrivate(e.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-gray-300 dark:border-slate-600 text-primary-600 focus:ring-primary-500"
                />
                <Lock className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-slate-500" aria-hidden="true" />
                Private form (end-to-end encrypted, beta)
              </label>
             )}
          {/* Explainer + irreversibility (plan D1/D8): shown BEFORE the point of no return. */}
          {canMakePrivate && makePrivate && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Responses are encrypted in each submitter's browser — FormLogic stores only ciphertext and
              cannot read the answers; you decrypt them with your vault passphrase. This is
              <strong> permanent</strong>: it cannot be turned off, and webhooks, flows, reports, file
              uploads and linked records stay unavailable on this form.
            </p>
          )}
            </div>}
            {/* Blank form option. What is chosen is drawn the same way here and on a template:
                the accent on the border and a tick, so it is plain which one Create form makes. */}
            <div className="mb-5">
              <button
                type="button"
                onClick={() => setSelected(null)}
                disabled={isCreating}
                aria-pressed={currentTemplate === null}
                className={cn(
                  'w-full flex items-center gap-3 p-3 border rounded-xl motion-safe:transition-colors group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
                  currentTemplate === null
                    ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10'
                    : 'border-dashed border-gray-300 dark:border-slate-700 hover:border-primary-400 dark:hover:border-primary-500/60 hover:bg-primary-50/60 dark:hover:bg-primary-500/5',
                )}
              >
                <div className={cn('p-2 rounded-lg flex-shrink-0', currentTemplate === null ? SELECTED_TILE : PLAIN_TILE)}>
                  <Plus className="h-6 w-6" />
                </div>
                <div className="text-left min-w-0 flex-1">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white">Blank form</h3>
                  <p className="text-sm text-gray-500 dark:text-slate-400">Start from scratch with an empty form</p>
                </div>
                {currentTemplate === null && <Check className="h-4 w-4 flex-none text-primary-600 dark:text-primary-400" aria-hidden="true" />}
              </button>
            </div>

            {/* Templates */}
            <div>
              <h3 className={cn(GROUP_TITLE, 'mb-3')}>
                Templates
              </h3>
              {loading && <p role="status" className="mb-4 text-sm text-gray-500 dark:text-slate-400">Loading templates…</p>}
              {error && <div role="alert" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{error} You can still start with a blank form. <button type="button" onClick={refresh} className="min-h-11 cursor-pointer px-2 underline">Try again</button></div>}
              {skipped > 0 && <p role="status" className="mb-4 text-sm text-amber-700 dark:text-amber-300">Some templates could not be loaded. The administrator can check the template files and server log.</p>}
              {!loading && !error && filteredTemplates.length === 0 ? (
                <EmptyState
                  icon={LayoutGrid}
                  title="No matching templates"
                  description="Try another search or category, or start from a blank form."
                />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  {filteredTemplates.map((template) => (
                    // A card under the pointer shows it with its border; the one chosen keeps the
                    // accent and a tick. Drawn alike, as they were, hovering looked like choosing.
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => { setSelected(template); if (!name.trim() || name === selected?.name) setName(template.name); }}
                      disabled={isCreating}
                      aria-pressed={currentTemplate?.id === template.id}
                      className={cn(
                        'text-left p-3 border rounded-xl motion-safe:transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
                        currentTemplate?.id === template.id
                          ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10'
                          : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 hover:border-primary-400 dark:hover:border-primary-500/60'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className={cn('p-2 rounded-lg flex-shrink-0', currentTemplate?.id === template.id ? SELECTED_TILE : PLAIN_TILE)}>
                          {iconMap[template.icon] || <FileText className="h-6 w-6" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="flex items-start gap-1.5 text-sm font-medium text-gray-900 dark:text-white">
                            <span className="min-w-0 flex-1 break-words">{template.name}</span>
                            {currentTemplate?.id === template.id && <Check className="mt-0.5 h-4 w-4 flex-none text-primary-600 dark:text-primary-400" aria-hidden="true" />}
                          </h4>
                          <p className="text-sm text-gray-500 dark:text-slate-400 line-clamp-2 mt-0.5">
                            {template.description}
                          </p>
                          <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 dark:text-slate-400 tabular-nums">
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {template.estimatedTime}
                            </span>
                            <span>{template.fields.length} field{template.fields.length === 1 ? '' : 's'}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={DIALOG_FOOTER}>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button variant="outline" onClick={onClose} disabled={isCreating} className="max-sm:min-h-11">
              Cancel
            </Button>
            <Button onClick={() => onSelectTemplate(currentTemplate, makePrivate, name.trim())} disabled={isCreating || (loading && selected !== null)} isLoading={isCreating} className="max-sm:min-h-11">Create form</Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
