import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { WidgetDashboard, type WidgetDataForm } from './WidgetDashboard';
import { allowsManualNewRecord } from './widgetData';
import { AppDashboard } from './AppDashboard';
import type { DashboardScreen } from '../../types/app';

/**
 * App-scope adapter: wires the runtime store (report runner, forms, permissions, navigation) into the
 * generic WidgetDashboard. Falls back to the built-in pulse dashboard when the config has no widgets.
 */
export function AppWidgetDashboard({ dashboard }: { dashboard: DashboardScreen }) {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const {
    config, permissions, runReport, runReportBatch, fetchRecentRows, fetchResponsePage,
    canViewOwn, canViewAll, canSubmit,
  } = useAppRuntimeStore();

  const forms: WidgetDataForm[] = useMemo(
    () => (config?.forms ?? []).map((f) => ({ formId: f.formId, displayName: f.displayName, icon: f.icon, fields: f.fields ?? [] })),
    [config]
  );
  const submittableForms = useMemo(
    () => (config?.forms ?? [])
      .filter((f) => canSubmit(f.formId) && allowsManualNewRecord(f))
      .map((f) => ({ formId: f.formId, displayName: f.displayName, icon: f.icon, fields: f.fields ?? [] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canSubmit is a stable store action; permissions is the state it reads
    [config, permissions]
  );

  if (!config) return null;
  // Empty dashboards degrade gracefully to the built-in pulse.
  if (!dashboard.widgets?.length) return <AppDashboard />;

  return (
    <div className="max-w-6xl mx-auto">
      <WidgetDashboard
        dashboard={dashboard}
        forms={forms}
        scope="app"
        runReport={runReport}
        runBatch={runReportBatch}
        fetchRecent={fetchRecentRows}
        canViewForm={(id) => canViewOwn(id) || canViewAll(id)}
        submittableForms={submittableForms}
        onOpenForm={(id) => navigate(`/app/${appSlug}/form/${id}?new=1`)}
        onOpenRecords={(id) => navigate(`/app/${appSlug}/form/${id}/responses`)}
        onOpenRecord={(id, rid) => navigate(`/app/${appSlug}/form/${id}/responses/${rid}`)}
        fetchPage={(id, opts) => fetchResponsePage(id, opts)}
      />
    </div>
  );
}
