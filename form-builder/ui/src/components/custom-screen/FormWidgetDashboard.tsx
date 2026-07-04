import { useMemo } from 'react';
import { api } from '../../lib/api';
import { WidgetDashboard } from '../app-runtime/WidgetDashboard';
import type { WidgetDataForm, WidgetRecord } from '../app-runtime/widgetData';
import type { AppReportResult, AppReportSpec, DashboardScreen } from '../../types/app';

/**
 * Renders a form section-screen widget dashboard OUTSIDE the app runtime: the public form link
 * (publicMode → anonymous, whitelisted endpoint) and the owner's builder preview / play route.
 * (Inside the app runtime, AppFormView renders WidgetDashboard with the app-scoped store instead.)
 */
export function FormWidgetDashboard({
  dashboard, formId, fields, formTitle, publicMode, accent, onOpenForm, onOpenRecord, className,
}: {
  dashboard: DashboardScreen;
  formId: string;
  fields: unknown[];
  formTitle: string;
  publicMode: boolean;
  accent?: string;
  onOpenForm?: () => void;
  onOpenRecord?: (formId: string, recordId: string) => void;
  className?: string;
}) {
  const forms: WidgetDataForm[] = useMemo(
    () => [{ formId, displayName: formTitle, fields: fields ?? [] }],
    [formId, formTitle, fields]
  );

  const runReport = async (spec: AppReportSpec): Promise<AppReportResult | null> => {
    const r = await (publicMode ? api.runPublicFormReport(formId, spec as unknown as Record<string, unknown>) : api.runFormReport(formId, spec as unknown as Record<string, unknown>));
    return r.error ? null : (r.data ?? null);
  };
  const runBatch = async (specs: AppReportSpec[]): Promise<(AppReportResult | null)[]> => {
    const call = publicMode ? api.runPublicFormReportBatch : api.runFormReportBatch;
    const r = await call.call(api, formId, specs as unknown as Record<string, unknown>[]);
    if (r.error || !r.data) return specs.map(() => null);
    const arr = r.data.results ?? [];
    return specs.map((_, i) => { const x = arr[i]; return x && !x.error ? x : null; });
  };
  const fetchRecent = async (fid: string, limit: number): Promise<WidgetRecord[]> => {
    const map = (x: Record<string, unknown>): WidgetRecord => ({ id: String(x.id ?? ''), answers: (x.answers as Record<string, unknown>) ?? {}, submittedAt: String(x.submittedAt ?? '') });
    if (publicMode) {
      const r = await api.getScreenRecords(fid, { limit });
      return (r.data?.records ?? []).map(map);
    }
    const r = await api.getResponses(fid, { limit });
    return ((r.data?.responses ?? []) as unknown as Record<string, unknown>[]).map(map);
  };

  return (
    <WidgetDashboard
      dashboard={dashboard}
      forms={forms}
      scope={publicMode ? 'public' : 'form'}
      accent={accent}
      runReport={runReport}
      runBatch={runBatch}
      fetchRecent={fetchRecent}
      onOpenForm={onOpenForm ? () => onOpenForm() : undefined}
      onOpenRecord={onOpenRecord}
      className={className}
    />
  );
}
