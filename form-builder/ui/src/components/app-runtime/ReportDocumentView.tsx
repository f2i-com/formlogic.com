import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppReportItem, AppReportResult, AppReportDocument } from '../../types/app';
import { isReportDocument } from '../../types/app';
import { ReportResultView } from './ReportResultView';

interface Props {
  doc: AppReportDocument;
  reports: AppReportItem[];
  resultsById: Record<string, AppReportResult | undefined>;
  /** Print mode: light-on-white styling + fixed-size charts, for the detached PDF root. */
  print?: boolean;
  loading?: boolean;
  appName?: string;
  primaryColor?: string;
}

/** Renders a composed report document (title + description + ordered text/chart blocks). */
export function ReportDocumentView({ doc, reports, resultsById, print = false, loading = false, appName, primaryColor }: Props) {
  const reportsById = useMemo(() => {
    const m: Record<string, AppReportItem> = {};
    for (const r of reports) m[r.id] = r;
    return m;
  }, [reports]);

  const heading = print ? 'text-gray-900' : 'text-gray-900 dark:text-white';
  const muted = print ? 'text-gray-500' : 'text-gray-500 dark:text-slate-400';
  const cardCls = print
    ? 'fl-print-block border border-gray-200 rounded-xl p-4'
    : 'rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4';

  return (
    <div className={print ? 'text-gray-900' : ''} style={print ? { width: 700 } : undefined}>
      <header className="mb-6">
        {appName && <p className={`text-xs font-medium uppercase tracking-wide ${muted}`}>{appName}</p>}
        <h1 className={`text-2xl font-bold tracking-tight ${heading}`}>{doc.name || 'Untitled document'}</h1>
        {doc.description && <p className={`mt-1 text-sm ${muted}`}>{doc.description}</p>}
      </header>

      {doc.blocks.length === 0 ? (
        <p className={`py-12 text-center text-sm ${muted}`}>Add text and charts to build your document.</p>
      ) : (
        <div className="space-y-5">
          {doc.blocks.map((block) => {
            if (block.kind === 'text') {
              return (
                <div key={block.id} className={print ? 'fl-print-block' : ''}>
                  {block.title && <h2 className={`text-lg font-semibold mb-1 ${heading}`}>{block.title}</h2>}
                  {block.body && <p className={`text-sm leading-relaxed whitespace-pre-wrap ${print ? 'text-gray-700' : 'text-gray-700 dark:text-slate-300'}`}>{block.body}</p>}
                </div>
              );
            }
            const rep = reportsById[block.reportId];
            const res = resultsById[block.reportId];
            const missing = !rep || isReportDocument(rep);
            return (
              <div key={block.id} className={cardCls}>
                <h3 className={`text-base font-semibold ${heading}`}>{missing ? 'Report unavailable' : rep.name}</h3>
                {block.caption && <p className={`text-sm mt-0.5 mb-2 ${muted}`}>{block.caption}</p>}
                {missing ? (
                  <p className={`py-6 text-center text-sm ${muted}`}>This report was removed.</p>
                ) : res ? (
                  <ReportResultView result={res} spec={rep.spec} print={print} primaryColor={primaryColor} />
                ) : loading ? (
                  <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-gray-400" /></div>
                ) : (
                  <p className={`py-6 text-center text-sm ${muted}`}>No data.</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {print && (
        <p className="mt-8 pt-3 border-t border-gray-200 text-[11px] text-gray-400">
          {appName ? `${appName} · ` : ''}Generated {new Date().toLocaleString()}
        </p>
      )}
    </div>
  );
}
