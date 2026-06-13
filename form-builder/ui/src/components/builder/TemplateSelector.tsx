import { useState, useEffect, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, Plus, Clock, LayoutGrid, Building, MessageCircle, CalendarDays, Users, GraduationCap, Mail, Briefcase, Newspaper, Bug, PartyPopper, FileText } from 'lucide-react';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { formTemplates, templateCategories, type FormTemplate } from '../../data/formTemplates';

interface TemplateSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (template: FormTemplate | null) => void;
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

export function TemplateSelector({ isOpen, onClose, onSelectTemplate }: TemplateSelectorProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [hoveredTemplate, setHoveredTemplate] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const filteredTemplates = selectedCategory === 'all'
    ? formTemplates
    : formTemplates.filter(t => t.category === selectedCategory);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="template-selector-title" className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-slate-800 focus:outline-none">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800 bg-gradient-to-r from-gray-50 to-white dark:from-slate-900 dark:to-slate-800/50">
          <div>
            <h2 id="template-selector-title" className="text-xl font-semibold text-gray-900 dark:text-white">Create New Form</h2>
            <p className="text-sm text-gray-500 dark:text-slate-400">Start from scratch or choose a template</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex">
          {/* Sidebar - Categories */}
          <div className="w-48 border-r border-gray-200 dark:border-slate-800 p-4 hidden md:block bg-gray-50/50 dark:bg-slate-900/50">
            <nav className="space-y-1">
              {templateCategories.map((category) => (
                <button
                  key={category.id}
                  onClick={() => setSelectedCategory(category.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors cursor-pointer',
                    selectedCategory === category.id
                      ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400 font-medium'
                      : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800'
                  )}
                >
                  {categoryIconMap[category.icon]}
                  {category.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Mobile Category Tabs */}
          <div className="md:hidden px-4 py-2 border-b border-gray-200 dark:border-slate-800 overflow-x-auto flex gap-2">
            {templateCategories.map((category) => (
              <button
                key={category.id}
                onClick={() => setSelectedCategory(category.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full whitespace-nowrap transition-colors cursor-pointer',
                  selectedCategory === category.id
                    ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400 font-medium'
                    : 'bg-gray-100 text-gray-600 dark:bg-slate-800 dark:text-slate-400'
                )}
              >
                {categoryIconMap[category.icon]}
                {category.label}
              </button>
            ))}
          </div>

          {/* Templates Grid */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* Blank Form Option */}
            {/* Blank Form Option */}
            <div className="mb-6">
              <button
                onClick={() => onSelectTemplate(null)}
                className="w-full flex items-center gap-4 p-4 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl hover:border-primary-500 dark:hover:border-primary-500 hover:bg-primary-50 dark:hover:bg-primary-900/10 transition-all group cursor-pointer"
              >
                <div className="p-3 bg-gray-100 dark:bg-slate-800 rounded-lg group-hover:bg-primary-100 dark:group-hover:bg-primary-900/30 transition-colors">
                  <Plus className="h-6 w-6 text-gray-600 dark:text-slate-400 group-hover:text-primary-600 dark:group-hover:text-primary-400" />
                </div>
                <div className="text-left">
                  <h3 className="font-medium text-gray-900 dark:text-white">Blank Form</h3>
                  <p className="text-sm text-gray-500 dark:text-slate-400">Start from scratch with an empty form</p>
                </div>
              </button>
            </div>

            {/* Templates */}
            <div>
              <h3 className="text-sm font-medium text-gray-500 dark:text-slate-500 uppercase tracking-wider mb-4">
                Templates
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {filteredTemplates.map((template) => (
                  <button
                    key={template.id}
                    onClick={() => onSelectTemplate(template)}
                    onMouseEnter={() => setHoveredTemplate(template.id)}
                    onMouseLeave={() => setHoveredTemplate(null)}
                    className={cn(
                      'text-left p-4 border rounded-xl transition-all cursor-pointer',
                      hoveredTemplate === template.id
                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/10 shadow-md'
                        : 'border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-800/50 hover:border-gray-300 dark:hover:border-slate-700'
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className={cn('p-2 rounded-lg', categoryColors[template.category])}>
                        {iconMap[template.icon] || <FileText className="h-6 w-6" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-medium text-gray-900 dark:text-white truncate">{template.name}</h4>
                        <p className="text-sm text-gray-500 dark:text-slate-400 line-clamp-2 mt-0.5">
                          {template.description}
                        </p>
                        <div className="flex items-center gap-3 mt-2 text-xs text-gray-400 dark:text-slate-500">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {template.estimatedTime}
                          </span>
                          <span>{template.fields.length} fields</span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
