import { useMemo, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { AppWidgetDashboard } from './AppWidgetDashboard';
import { AppDashboard } from './AppDashboard';
import { DashboardBuilder } from './DashboardBuilder';
import type { DashboardScreen } from '../../types/app';
import type { WidgetDataForm } from './WidgetDashboard';
import { allowsManualNewRecord } from './widgetData';

/**
 * The app home: renders the configurable widget dashboard (or the built-in pulse when there are no
 * widgets yet), and gives owners an inline "Edit dashboard" button that opens the drag-and-drop
 * builder full-screen. Sandboxed code home screens are handled separately (edited in the Studio).
 */
export function AppDashboardHome({ dashboard }: { dashboard?: DashboardScreen }) {
  const {
    config, permissions, runReport, runReportBatch, fetchRecentRows,
    canSubmit, canViewOwn, canViewAll, saveDashboard, isOwner: checkOwner,
  } = useAppRuntimeStore();
  const [editing, setEditing] = useState(false);

  const forms = useMemo(() => config?.forms ?? [], [config]);
  const submittableForms: WidgetDataForm[] = useMemo(
    () => forms.filter((f) => canSubmit(f.formId) && allowsManualNewRecord(f)).map((f) => ({ formId: f.formId, displayName: f.displayName, icon: f.icon, fields: f.fields ?? [] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canSubmit is a stable store action; permissions is the state it reads
    [forms, permissions]
  );

  if (!config) return null;
  const isOwner = checkOwner();

  return (
    <>
      {isOwner && (
        <div className="max-w-6xl mx-auto mb-2 flex justify-end">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit dashboard
          </button>
        </div>
      )}

      {dashboard?.widgets?.length ? <AppWidgetDashboard dashboard={dashboard} /> : <AppDashboard />}

      {editing && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-slate-950" data-app-runtime role="dialog" aria-label="Edit dashboard">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 dark:border-slate-800 px-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Edit dashboard</h2>
            <button type="button" onClick={() => setEditing(false)} aria-label="Close" className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-700 dark:hover:text-white cursor-pointer">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 p-4">
            <DashboardBuilder
              initial={dashboard}
              scope="app"
              builderForms={forms}
              submittableForms={submittableForms}
              runReport={runReport}
              runBatch={runReportBatch}
              fetchRecent={fetchRecentRows}
              forms={forms.map((f) => ({ formId: f.formId, displayName: f.displayName, icon: f.icon, fields: f.fields ?? [] }))}
              canViewForm={(id) => canViewOwn(id) || canViewAll(id)}
              accent={config.app.theme?.primaryColor}
              onSave={async (screen) => { const ok = await saveDashboard(screen); if (ok) setEditing(false); return ok; }}
              onCancel={() => setEditing(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
