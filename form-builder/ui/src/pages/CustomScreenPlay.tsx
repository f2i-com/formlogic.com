import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { CustomScreenRuntime, type CustomScreen } from '../components/custom-screen/CustomScreenRuntime';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/**
 * Renders a form's custom screen full-bleed (the sandboxed runtime). The screen talks to the form's
 * data through the FormLogic SDK. Authenticated — the screen acts as the signed-in user.
 */
export default function CustomScreenPlay() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<CustomScreen | null>(null);
  const [title, setTitle] = useState('');
  const [fields, setFields] = useState<Array<{ id: string; label: string; type: string }>>([]);
  useDocumentTitle(title || 'Custom screen');

  useEffect(() => {
    if (!formId) return;
    let cancelled = false;
    api.getForm(formId).then((res) => {
      if (cancelled) return;
      const form = res.data?.form as { title?: string; customScreen?: CustomScreen & { enabled?: boolean }; fields?: Array<{ id: string; label: string; type: string }> } | undefined;
      const cs = form?.customScreen;
      setTitle(form?.title || '');
      setFields((form?.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type })));
      setScreen(cs && (cs.html || cs.js || cs.ts) ? cs : null);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [formId]);

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-slate-950">
      <div className="flex items-center gap-3 px-4 h-12 shrink-0 border-b border-gray-200 dark:border-slate-800">
        <button onClick={() => navigate(-1)} className="text-gray-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white cursor-pointer" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{title}</span>
      </div>
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="h-full flex items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary-500" /></div>
        ) : screen ? (
          <CustomScreenRuntime screen={screen} formId={formId!} formTitle={title} fields={fields} className="w-full h-full border-0" />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-500 dark:text-slate-400">This form has no custom screen.</div>
        )}
      </div>
    </div>
  );
}
