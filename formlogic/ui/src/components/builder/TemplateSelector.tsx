import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, Plus, Clock, LayoutGrid, Building, MessageCircle, CalendarDays, Users, GraduationCap, Mail, Briefcase, Newspaper, Bug, PartyPopper, FileText } from 'lucide-react';
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

const categoryColors: Record<string, string> = {
  business: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  feedback: 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
  events: 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400',
  hr: 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400',
  education: 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400',
  other: 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-400',
};

export function TemplateSelector({ isOpen, onClose, onSelectTemplate, canMakePrivate = false, isCreating = false }: TemplateSelectorProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [hoveredTemplate, setHoveredTemplate] = useState<string | null>(null);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-2 sm:p-4">
      <div className="absolute inset-0" onClick={() => { if (!isCreating) onClose(); }} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="template-selector-title" aria-busy={isCreating} className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-4xl h-[calc(100dvh-1rem)] sm:h-[85dvh] max-h-[calc(100dvh-1rem)] overflow-hidden flex flex-col border border-gray-200 dark:border-slate-800 focus:outline-none">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 border-b border-gray-200 dark:border-slate-800 bg-gradient-to-r from-gray-50 to-white dark:from-slate-900 dark:to-slate-800/50">
          <div>
            <h2 id="template-selector-title" className="text-xl font-semibold text-gray-900 dark:text-white">Create new form</h2>
            <p className="text-sm text-gray-500 dark:text-slate-400">Start from scratch or choose a template</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isCreating}
            className="p-2 min-h-11 min-w-11 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg motion-safe:transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Content — stack on mobile (category tabs on top), side-by-side on desktop */}
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row min-h-0">
          {/* Sidebar - Categories */}
          <div className="w-48 shrink-0 overflow-y-auto border-r border-gray-200 dark:border-slate-800 p-4 hidden md:block bg-gray-50/50 dark:bg-slate-900/50">
            <nav className="space-y-1">
              {templateCategories.map((category) => (
                <button
                  key={category.id}
                  onClick={() => setSelectedCategory(category.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg motion-safe:transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                    (templateCategories.some(item => item.id === selectedCategory) ? selectedCategory : 'all') === category.id
                      ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400 font-medium'
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
                🔒 Private form (end-to-end encrypted, beta)
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
            {/* Blank form option */}
            <div className="mb-6">
              <button
                onClick={() => setSelected(null)}
                disabled={isCreating}
                aria-pressed={currentTemplate === null}
                className="w-full flex items-center gap-4 p-4 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl hover:border-primary-500 dark:hover:border-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/10 motion-safe:transition-all group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
              >
                <div className="p-3 bg-gray-100 dark:bg-slate-800 rounded-lg group-hover:bg-primary-100 dark:group-hover:bg-primary-900/30 motion-safe:transition-colors">
                  <Plus className="h-6 w-6 text-gray-600 dark:text-slate-400 group-hover:text-primary-600 dark:group-hover:text-primary-400" />
                </div>
                <div className="text-left min-w-0">
                  <h3 className="font-medium text-gray-900 dark:text-white">Blank form {currentTemplate === null ? '✓' : ''}</h3>
                  <p className="text-sm text-gray-500 dark:text-slate-400">Start from scratch with an empty form</p>
                </div>
              </button>
            </div>

            {/* Templates */}
            <div>
              <h3 className="text-sm font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-4">
                Templates
              </h3>
              {loading && <p role="status" className="mb-4 text-sm text-gray-500 dark:text-slate-400">Loading templates…</p>}
              {error && <div role="alert" className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{error} You can still start with a blank form. <button type="button" onClick={refresh} className="min-h-11 px-2 underline">Try again</button></div>}
              {skipped > 0 && <p role="status" className="mb-4 text-sm text-amber-700 dark:text-amber-300">Some templates could not be loaded. The administrator can check the template files and server log.</p>}
              {!loading && !error && filteredTemplates.length === 0 ? (
                <EmptyState
                  icon={LayoutGrid}
                  title="No matching templates"
                  description="Try another search or category, or start from a blank form."
                />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {filteredTemplates.map((template) => (
                    <button
                      key={template.id}
                      onClick={() => { setSelected(template); if (!name.trim() || name === selected?.name) setName(template.name); }}
                      disabled={isCreating}
                      aria-pressed={currentTemplate?.id === template.id}
                      onMouseEnter={() => setHoveredTemplate(template.id)}
                      onMouseLeave={() => setHoveredTemplate(null)}
                      className={cn(
                        'text-left p-4 border rounded-xl motion-safe:transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
                        hoveredTemplate === template.id || currentTemplate?.id === template.id
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/10 shadow-sm motion-safe:-translate-y-0.5'
                          : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-800/50 hover:border-gray-300 dark:hover:border-slate-700'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className={cn('p-2 rounded-lg flex-shrink-0', categoryColors[template.category] || categoryColors.other)}>
                          {iconMap[template.icon] || <FileText className="h-6 w-6" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-gray-900 dark:text-white break-words">{template.name} {currentTemplate?.id === template.id ? '✓' : ''}</h4>
                          <p className="text-sm text-gray-500 dark:text-slate-400 line-clamp-2 mt-0.5">
                            {template.description}
                          </p>
                          <div className="flex items-center gap-3 mt-2 text-xs text-gray-400 dark:text-slate-500 tabular-nums">
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
        <div className="shrink-0 px-4 py-3 sm:px-6 sm:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
          <div className="grid grid-cols-2 gap-3 sm:flex sm:justify-end">
            <Button variant="outline" onClick={onClose} disabled={isCreating}>
              Cancel
            </Button>
            <Button onClick={() => onSelectTemplate(currentTemplate, makePrivate, name.trim())} disabled={isCreating || (loading && selected !== null)} isLoading={isCreating}>Create form</Button>
          </div>

        </div>
      </div>
    </div>,
    document.body
  );
}
