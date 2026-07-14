import { useEffect, useMemo, useState } from 'react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import type { AppReportItem, AppReportResult, AppReportDocument } from '../../types/app';
import { isReportDocument } from '../../types/app';

/**
 * Runs every chart report referenced by a document's blocks and returns the results keyed by report id.
 * Re-runs whenever the referenced reports (ids or their specs) change. Used by the document preview
 * and before printing a PDF.
 */
export function useDocumentResults(doc: AppReportDocument | null, allReports: AppReportItem[]) {
  const { runReport } = useAppRuntimeStore();
  const [resultsById, setResultsById] = useState<Record<string, AppReportResult | undefined>>({});
  const [loading, setLoading] = useState(false);

  const reportsById = useMemo(() => {
    const m: Record<string, AppReportItem> = {};
    for (const r of allReports) m[r.id] = r;
    return m;
  }, [allReports]);

  const referenced = useMemo(() => {
    if (!doc) return [];
    const ids = doc.blocks.filter((b) => b.kind === 'report').map((b) => (b as { reportId: string }).reportId);
    return [...new Set(ids)].filter((id) => reportsById[id] && !isReportDocument(reportsById[id]));
  }, [doc, reportsById]);

  // Key changes when the set of referenced reports — or any of their specs — changes.
  const key = useMemo(
    () => JSON.stringify(referenced.map((id) => [id, (reportsById[id] as { spec?: unknown }).spec])),
    [referenced, reportsById]
  );

  useEffect(() => {
    let cancelled = false;
    if (referenced.length === 0) { setResultsById({}); setLoading(false); return; }
    setLoading(true);
    (async () => {
      const map: Record<string, AppReportResult | undefined> = {};
      await Promise.all(referenced.map(async (id) => {
        const rep = reportsById[id];
        if (!rep || isReportDocument(rep)) return;
        try { map[id] = (await runReport(rep.spec)) ?? undefined; } catch { map[id] = undefined; }
      }));
      if (!cancelled) { setResultsById(map); setLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { resultsById, loading };
}
