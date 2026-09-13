import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { FormTemplateCatalog } from '../data/formTemplates';

const empty: FormTemplateCatalog = { templates: [], categories: [{ id: 'all', label: 'All templates', icon: 'LayoutGrid' }], skipped: 0 };

export function useFormTemplates(open: boolean) {
  const [catalog, setCatalog] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    // Each open reads the folder again; a previous result is not a current catalogue.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(''); setCatalog(empty);
    void api.getFormTemplates(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.error || !Array.isArray(result.data?.templates) || !Array.isArray(result.data?.categories)) setError(result.error || 'Templates are unavailable.');
      else setCatalog(result.data);
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load templates.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, revision]);
  return { ...catalog, loading, error, refresh: () => setRevision(value => value + 1) };
}
