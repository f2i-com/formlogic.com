import { FilePlus2, LayoutTemplate, Sparkles, ArrowRight } from 'lucide-react';
import { Modal } from '../ui/Modal';

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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title="Welcome to FormLogic 👋"
      description="Let's build your first form — it takes about a minute. Pick how you'd like to start:"
    >
      <div className="grid sm:grid-cols-3 gap-3">
        {PATHS.map(({ key, icon: Icon, title, desc }) => (
          <button
            key={key}
            type="button"
            onClick={handlers[key]}
            className="group text-left rounded-xl border border-gray-200/80 dark:border-slate-700/60 p-4 hover:border-primary-400 dark:hover:border-primary-500/60 hover:bg-primary-50/40 dark:hover:bg-primary-500/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 transition-all cursor-pointer flex flex-col"
          >
            <div className="h-10 w-10 rounded-lg bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center mb-3">
              <Icon className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-white text-sm mb-1">{title}</h3>
            <p className="text-xs text-gray-500 dark:text-slate-400 leading-relaxed flex-1">{desc}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary-600 dark:text-primary-400">
              Start <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
            </span>
          </button>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between">
        <p className="text-xs text-gray-400 dark:text-slate-500">You can publish and share your form the moment it's ready.</p>
        <button type="button" onClick={onClose} className="text-sm text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer">
          I'll explore on my own
        </button>
      </div>
    </Modal>
  );
}
