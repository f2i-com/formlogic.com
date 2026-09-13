import { useEffect, useRef, useState } from 'react';
import { Code2, Download, ExternalLink } from 'lucide-react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { api } from '../../lib/api';
import { mapConcurrent } from '../../lib/mapConcurrent';
import { createFormlogicProject, type FormlogicProject, type FormlogicSchema } from '../../lib/softn/project';
import type { App, AppForm } from '../../types/app';

interface SoftnExportProps {
  app: Pick<App, 'id' | 'name' | 'description'>;
  appForms?: Pick<AppForm, 'formId' | 'displayName'>[];
  forms?: FormlogicSchema[];
  sourceKind?: 'app' | 'form';
  isOpen?: boolean;
  onClose?: () => void;
}

export function SoftnExportPanel({ app, appForms = [], forms: suppliedForms, sourceKind = 'app', isOpen, onClose }: SoftnExportProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [project, setProject] = useState<FormlogicProject | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const generation = useRef(0);
  const downloadLock = useRef(false);
  const selectedForms = appForms.filter(form => !excluded.has(form.formId));
  useEffect(() => () => { generation.current++; }, []);
  const close = () => { generation.current++; setOpen(false); setBusy(false); setDownloading(false); onClose?.(); };
  const prepare = async () => {
    const run = ++generation.current;
    setBusy(true); setError(''); setProject(null);
    try {
      if (!suppliedForms && appForms.length > 0 && selectedForms.length === 0) throw new Error('Choose at least one form to include.');
      if (selectedForms.length > 30) throw new Error('Choose up to 30 forms for this project.');
      const forms = suppliedForms ?? await mapConcurrent(selectedForms, async attachment => {
        const result = await api.getForm(attachment.formId);
        if (!result.data?.form) throw new Error(`Couldn't read ${attachment.displayName || 'a selected form'}. Try again before exporting.`);
        return result.data.form;
      }, () => generation.current !== run);
      if (generation.current !== run) return;
      setProject(createFormlogicProject({ app, origin: window.location.origin, forms, sourceKind }));
    } catch (reason) {
      if (generation.current === run) { generation.current++; setBusy(false); setError(reason instanceof Error ? reason.message : 'Could not prepare the project.'); }
    } finally { if (generation.current === run) setBusy(false); }
  };
  const download = async () => {
    if (!project || downloadLock.current) return;
    const run = generation.current;
    downloadLock.current = true;
    setDownloading(true); setError('');
    try {
      const { zipSync, strToU8 } = await import('fflate');
      if (generation.current !== run) return;
      const bytes = zipSync(Object.fromEntries(Object.entries(project.files).map(([path, source]) => [path, strToU8(source)])));
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${app.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'app'}.softn`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { if (generation.current === run) setError('Could not create the download. Please try again.'); }
    finally { downloadLock.current = false; if (generation.current === run) setDownloading(false); }
  };
  const reset = () => { setProject(null); setError(''); };
  return <>
    {isOpen === undefined && <section className="min-w-0 rounded-xl border border-primary-200 dark:border-primary-500/25 bg-primary-50/60 dark:bg-primary-500/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white"><Code2 className="h-4 w-4 shrink-0" />App project</div>
      <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-slate-300">Bring your forms together in a portable app you can download and customise.</p>
      <Button className="mt-3 w-full min-h-11" variant="outline" size="sm" onClick={() => { reset(); setOpen(true); }}>Create app project</Button>
    </section>}
    <Modal isOpen={isOpen ?? open} onClose={close} title="Create app project" description="An editable copy of your forms, ready to customise." size="lg" footer={
      <div className="grid grid-cols-2 gap-3 sm:flex sm:justify-end [&>button]:min-h-11 [&>button]:min-w-0">
        {project ? <Button variant="outline" onClick={reset} disabled={downloading}>Change selection</Button> : <Button variant="outline" onClick={close}>Cancel</Button>}
        {project ? <Button onClick={() => void download()} isLoading={downloading} disabled={downloading} leftIcon={<Download className="h-4 w-4" />}>Download project</Button> : <Button onClick={() => void prepare()} isLoading={busy} disabled={busy || (!suppliedForms && appForms.length > 0 && selectedForms.length === 0)}>Prepare project</Button>}
      </div>
    }>
      <div className="space-y-5 p-4 sm:p-6">
        <div className="rounded-xl bg-gray-50 dark:bg-slate-800 p-4 text-sm leading-6 text-gray-600 dark:text-slate-300">
          <p>Each form becomes an editable screen with its own logic file. Select several forms to combine them in one app with navigation. A blank form stays blank; an app without forms starts with a notes screen.</p>
          <p className="mt-2">Records entered in this copy stay on the device. Existing responses, private forms, automations and account access are not included. It does not sync with your workspace.</p>
        </div>
        {!project && !suppliedForms && appForms.length > 0 && <fieldset disabled={busy}>
          <legend className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Forms to include <span className="font-normal text-gray-500">({selectedForms.length} selected)</span></legend>
          <div className="max-h-52 overflow-y-auto overscroll-contain rounded-xl border border-gray-200 dark:border-slate-700 divide-y divide-gray-100 dark:divide-slate-800">
            {appForms.map((form, index) => <label key={form.formId} className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-sm text-gray-700 dark:text-slate-200">
              <input type="checkbox" checked={!excluded.has(form.formId)} onChange={event => setExcluded(previous => { const next = new Set(previous); if (event.target.checked) next.delete(form.formId); else next.add(form.formId); return next; })} className="h-4 w-4 shrink-0 accent-primary-600" />
              <span className="min-w-0 break-words">{form.displayName || `Form ${index + 1}`}</span>
            </label>)}
          </div>
        </fieldset>}
        {error && <p role="alert" className="break-words text-sm text-red-600 dark:text-red-400">{error}</p>}
        {project && <div role="status" className="space-y-3">
          <p className="font-semibold text-gray-900 dark:text-white">Ready: {project.formCount} screen{project.formCount === 1 ? '' : 's'} · {project.fieldCount} field{project.fieldCount === 1 ? '' : 's'}</p>
          {project.warnings.length > 0 && <details className="rounded-xl border border-amber-300 dark:border-amber-700 p-3 text-sm text-amber-800 dark:text-amber-200">
            <summary className="cursor-pointer font-medium">Review {project.warnings.length} conversion note{project.warnings.length === 1 ? '' : 's'}</summary>
            <ul className="mt-3 list-disc space-y-2 break-words pl-5">{project.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </details>}
          <p className="text-sm leading-6 text-gray-600 dark:text-slate-300">Download your project, then use Open in the app editor to customise it. The .softn download includes separate screen and logic files for each form, plus instructions for reusing them in another app.</p>
          <a className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary-600 dark:text-primary-400" href="https://softn.com/builder/" target="_blank" rel="noopener noreferrer">Open app editor <ExternalLink className="h-4 w-4" /></a>
        </div>}
      </div>
    </Modal>
  </>;
}
