import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Atom, Check, CodeXml, PanelsTopLeft, SquareTerminal } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { createSoftnApp, softnWorkspacePath, type WebStarterTemplate } from '../../lib/softnApps';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { useUIStore } from '../../stores/uiStore';

const frameworks = [
  { value: 'javascript', name: 'Vanilla JS', file: 'app.js', color: 'bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-300' },
  { value: 'react', name: 'React', file: 'App.jsx', color: 'bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-300' },
  { value: 'vue', name: 'Vue', file: 'App.vue', color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300' },
] as const;

export function WebAppStarter({ disabled }: { disabled: boolean }) {
  const navigate = useNavigate();
  const [framework, setFramework] = useState<WebStarterTemplate>('javascript');
  const [name, setName] = useState('');
  const [opening, setOpening] = useState<'studio' | 'builder' | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const selected = frameworks.find(item => item.value === framework)!;
  const defaultName = `My ${selected.name} app`;

  async function open(editor: 'studio' | 'builder') {
    if (lock.current || disabled) return;
    lock.current = true;
    setOpening(editor);
    setError('');
    try {
      const created = await createSoftnApp({ name: name.trim() || defaultName, start: { kind: 'starter', template: framework } });
      useUIStore.getState().setSoftnOpen({ appId: created.app.id, editor, preview: true, template: framework });
      if (created.error) toast.info('Your app was created', created.error);
      navigate(softnWorkspacePath(created.app.id, 'edit'), {
        state: created.project ? null : { starter: { template: framework, editor } },
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create your starter. Please try again.');
    } finally {
      lock.current = false;
      setOpening(null);
    }
  }

  return <form onSubmit={event => { event.preventDefault(); void open('studio'); }} className="space-y-6">
    <fieldset disabled={disabled || !!opening}>
      <legend className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Framework</legend>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {frameworks.map(item => {
          const active = framework === item.value;
          return <label key={item.value} className={cn('relative flex min-w-0 cursor-pointer flex-col items-start rounded-xl border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary-500 sm:p-4',
            active ? 'border-primary-500 bg-primary-50/65 ring-1 ring-primary-500 dark:bg-primary-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800')}>
            <input type="radio" name="framework" aria-label={item.name} value={item.value} checked={active} onChange={() => setFramework(item.value)} className="absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0" />
            <span aria-hidden="true" className={cn('mb-3 grid size-9 place-items-center rounded-lg font-mono text-base font-bold', item.color)}>
              {item.value === 'react' ? <Atom className="size-5" /> : item.value === 'vue' ? 'V' : 'JS'}
            </span>
            <span className="text-sm font-semibold text-slate-900 dark:text-white">{item.name}</span>
            <code className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{item.file}</code>
            {active && <Check aria-hidden="true" className="absolute right-2 top-2 size-4 text-primary-700 dark:text-primary-300" />}
          </label>;
        })}
      </div>
    </fieldset>
    <div>
      <label htmlFor="softn-app-name" className="mb-2 block text-sm font-semibold text-slate-800 dark:text-slate-200">App name <span aria-hidden="true" className="font-normal text-slate-500">· optional</span></label>
      <Input id="softn-app-name" aria-label="App name" autoComplete="off" maxLength={120} value={name} placeholder={defaultName} onChange={event => setName(event.target.value)} disabled={disabled || !!opening} />
    </div>
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    <div className="border-t border-slate-200 pt-5 dark:border-slate-700">
      <div className="mb-4 flex items-start gap-2 text-sm text-slate-600 dark:text-slate-400">
        <CodeXml aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>Edit the source in Studio or arrange your app in Builder. Both have a live preview.</p>
      </div>
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <Button type="submit" disabled={disabled || !!opening} isLoading={opening === 'studio'} leftIcon={<SquareTerminal className="size-4" />}>Open in Studio</Button>
        <Button type="button" variant="secondary" disabled={disabled || !!opening} isLoading={opening === 'builder'} leftIcon={<PanelsTopLeft className="size-4" />} onClick={() => void open('builder')}>Open in Builder</Button>
      </div>
    </div>
  </form>;
}
