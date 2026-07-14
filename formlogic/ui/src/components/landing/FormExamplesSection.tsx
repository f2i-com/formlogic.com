import { useEffect, useRef, useState } from 'react';
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
  const [loaded, setLoaded] = useState(false);
  const revealRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getDemoForms();
        if (!cancelled) setForms(r.data?.forms ?? []);
      } catch {
        /* demo unavailable — section hides itself */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Reveal-on-scroll, self-registered (this section mounts after Landing's initial
  // useReveal() scan — same pattern as LiveDemoSection).
  useEffect(() => {
    const el = revealRef.current;
    if (!el) return;
    if (
      !('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      el.classList.add('fl-in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('fl-in');
            io.disconnect();
          }
        });
      },
      { threshold: 0.05, rootMargin: '0px 0px -48px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loaded, forms.length]);

  if (!loaded || forms.length === 0) return null;

  return (
    <section id="form-examples" className="relative px-4 sm:px-6 lg:px-8 py-20 sm:py-28">
      <div ref={revealRef} className="fl-reveal max-w-6xl mx-auto">
        <div className="fl-mono inline-flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary-600 dark:text-primary-400">
          <span className="fl-dot inline-block h-1.5 w-1.5 rounded-full bg-primary-500" />
          Just a form · scan &amp; fill
        </div>
        <h2 className="fl-display mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
          Sometimes all you need is <span className="fl-grad">a form</span>
        </h2>
        <p className="mt-3 max-w-2xl text-gray-500 dark:text-slate-400 leading-relaxed">
          No app, no dashboard — just a shareable form with real backend logic running
          server-side: validation, scoring, rejections, webhooks. Every form gets a link
          and a QR code. Scan one below with your phone (or click it) and submit — no
          account needed.
        </p>

        <div className="mt-9 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">{form.title}</div>
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
                    className="group inline-flex items-center gap-1 rounded-md text-sm font-semibold text-primary-600 transition hover:text-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-primary-400"
                  >
                    Try this form
                    <ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </a>
                  <ShareQrCode url={url} size={96} />
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-6 text-xs text-gray-400 dark:text-slate-500">
          These are live shared demo forms — your submission lands in the Demo workspace.
          Build your own and it's private to your account, with the same link + QR sharing.
        </p>
      </div>
    </section>
  );
}
