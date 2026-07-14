import { FilePlus2, LayoutTemplate, Sparkles, ArrowRight } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useAiAvailable } from '../../hooks/useAiAvailable';

interface WelcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBlank: () => void;
  onTemplate: () => void;
  onAI: () => void;
}

const PATHS = [
  { key: 'blank', icon: FilePlus2, title: 'Start from scratch', desc: 'A blank form — drag in fields and make it yours.' },
  { key: 'template', icon: LayoutTemplate, title: 'Use a template', desc: 'Begin from a ready-made form and tweak it.' },
  { key: 'ai', icon: Sparkles, title: 'Generate with AI', desc: 'Describe what you need in plain English.' },
] as const;

/**
 * First-run welcome shown to brand-new users (no forms yet). Orients them and routes to one of the
 * three ways to create their first form, so the dashboard isn't an intimidating blank slate.
 * Dismissal is persisted by the caller so returning users aren't nagged.
 */
export function WelcomeModal({ isOpen, onClose, onBlank, onTemplate, onAI }: WelcomeModalProps) {
  const handlers: Record<string, () => void> = { blank: onBlank, template: onTemplate, ai: onAI };
  // Hide the "Generate with AI" path when the in-app AI is off (AI_ENABLED=false) or unconfigured.
  const aiAvailable = useAiAvailable();
  const paths = PATHS.filter((p) => p.key !== 'ai' || aiAvailable);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title="Welcome to FormLogic 👋"
      description="Let's build your first form — it takes about a minute. Pick how you'd like to start:"
    >
      {/* Modal body has no padding of its own — give the content room to breathe. */}
      <div className="p-6 sm:p-8">
        <div className={`grid gap-4 ${paths.length >= 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          {paths.map(({ key, icon: Icon, title, desc }) => (
            <button
              key={key}
              type="button"
              onClick={handlers[key]}
              className="group min-w-0 text-left rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-5 hover:border-primary-400 dark:hover:border-primary-500/60 hover:bg-primary-50/40 dark:hover:bg-primary-500/[0.06] hover:shadow-sm hover:shadow-primary-500/5 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 focus-visible:border-primary-400 dark:focus-visible:border-primary-500/60 motion-safe:transition-all cursor-pointer flex flex-col"
            >
              <div className="h-11 w-11 shrink-0 rounded-xl bg-primary-50 dark:bg-primary-500/10 group-hover:bg-primary-100 dark:group-hover:bg-primary-500/20 flex items-center justify-center mb-4 motion-safe:transition-colors">
                <Icon className="h-5 w-5 text-primary-600 dark:text-primary-400" />
              </div>
              <h3 className="font-semibold text-gray-900 dark:text-white text-sm mb-1.5">{title}</h3>
              <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed flex-1">{desc}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-primary-600 dark:text-primary-400">
                Start <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 motion-safe:transition-transform" />
              </span>
            </button>
          ))}
        </div>
        <div className="mt-7 pt-5 border-t border-gray-100 dark:border-slate-800 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-400 dark:text-slate-500 min-w-0">You can publish and share your form the moment it's ready.</p>
          <button type="button" onClick={onClose} className="shrink-0 self-start sm:self-auto text-sm font-medium text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 motion-safe:transition-colors cursor-pointer">
            I'll explore on my own
          </button>
        </div>
      </div>
    </Modal>
  );
}
