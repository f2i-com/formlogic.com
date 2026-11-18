import { useEffect, useState } from 'react';
import { ArrowUpRight, Braces, QrCode } from 'lucide-react';
import { api } from '../../lib/api';
import { ShareQrCode } from '../ui/ShareQrCode';
import { DynamicIcon } from '../ui/DynamicIcon';

type DemoForm = {
  id: string;
  title: string;
  description: string;
  icon?: string | null;
  hasLogic: boolean;
};

/**
 * Landing "just a form" band: standalone example forms owned by the shared Demo
 * account, each with its live QR code. The pitch — a form with server-side logic
 * is shareable on its own (link or QR), no business app required, and filling one
 * needs no account at all (the /form/{id} runtime is public for published forms).
 * Renders nothing when the demo is disabled or no example forms exist.
 */
export function FormExamplesSection() {
  const [forms, setForms] = useState<DemoForm[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getDemoForms();
        if (!cancelled) setForms(r.data?.forms ?? []);
      } catch {
        /* demo unavailable — section hides itself */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (forms.length === 0) return null;

  return (
    <section id="form-examples" className="lv2-examples" aria-labelledby="form-examples-title">
      <div className="lv2-container">
        <div className="lv2-guide-head">
          <div>
            <h2 id="form-examples-title" className="lv2-guide-title">Try a public form.</h2>
            <p>Open a form or scan its QR code with your phone. Submissions appear in the shared demo workspace.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {forms.map((form) => {
            const url = `${window.location.origin}/form/${form.id}`;
            return (
              <div
                key={form.id}
                className="flex flex-col rounded-2xl border border-gray-200 bg-white p-5 transition duration-200 hover:border-primary-400 hover:shadow-md hover:shadow-primary-500/5 dark:border-slate-800 dark:bg-slate-900/50 dark:hover:border-primary-500/50"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
                    <DynamicIcon
                      name={form.icon ?? undefined}
                      className="h-[18px] w-[18px]"
                      fallback={<QrCode className="h-[18px] w-[18px]" />}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{form.title}</h3>
                    {form.hasLogic && (
                      <span className="fl-mono mt-1 inline-flex items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-2 py-0.5 text-[10px] text-primary-700 dark:border-primary-500/25 dark:bg-primary-500/10 dark:text-primary-300">
                        <Braces className="h-2.5 w-2.5" /> backend logic
                      </span>
                    )}
                  </div>
                </div>
                {form.description && (
                  <p className="mt-3 text-xs leading-relaxed text-gray-500 dark:text-slate-400">{form.description}</p>
                )}
                <div className="mt-4 flex items-end justify-between gap-3 pt-1">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-semibold text-primary-600 transition hover:text-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-400"
                  >
                    Try this form<span className="sr-only">, {form.title} (opens in a new tab)</span>
                    <ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </a>
                  <ShareQrCode url={url} size={96} />
                </div>
              </div>
            );
          })}
        </div>

      </div>
    </section>
  );
}
