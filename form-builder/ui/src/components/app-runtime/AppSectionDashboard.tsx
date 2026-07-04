import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Pencil, X, Plus } from 'lucide-react';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { WidgetDashboard, type WidgetDataForm } from './WidgetDashboard';
import { DashboardBuilder } from './DashboardBuilder';
import type { DashboardScreen } from '../../types/app';

/**
 * A form's section-screen widget dashboard inside the app runtime: renders the grid (app-scoped data)
 * and gives owners an inline "Edit dashboard" button that opens the drag-and-drop builder full-screen.
 * Mirrors AppDashboardHome, but scoped to a single form (saved on that form's customScreen).
 */
export function AppSectionDashboard({ formId, dashboard, allowNew, onNew }: {
  formId: string;
  dashboard: DashboardScreen;
  allowNew: boolean;
  onNew: () => void;
}) {
  const { appSlug } = useParams();
  const navigate = useNavigate();
  const {
    config, runReport, runReportBatch, fetchRecentRows, canViewOwn, canViewAll, saveFormDashboard,
  } = useAppRuntimeStore();
  const [editing, setEditing] = useState(false);

  const forms: WidgetDataForm[] = useMemo(
    () => (config?.forms ?? []).map((f) => ({ formId: f.formId, displayName: f.displayName, icon: f.icon, fields: f.fields ?? [] })),
    [config]
  );
  const thisForm = useMemo(() => (config?.forms ?? []).filter((f) => f.formId === formId), [config, formId]);

  if (!config) return null;
  const isOwner = !!config.app.ownerId;

  return (
    <div className="relative h-full min-h-[60vh]">
      {(allowNew || isOwner) && (
        <div className="max-w-6xl mx-auto mb-3 flex items-center justify-end gap-2">
          {allowNew && (
            <button
              type="button"
              onClick={onNew}
              className="app-btn-primary inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
            >
              <Plus className="h-4 w-4" /> New record
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 app-ring-primary"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit dashboard
            </button>
          )}
        </div>
      )}

      <div className="max-w-6xl mx-auto">
        <WidgetDashboard
          dashboard={dashboard}
          forms={forms}
          scope="app"
          runReport={runReport}
          runBatch={runReportBatch}
          fetchRecent={fetchRecentRows}
          canViewForm={(id) => canViewOwn(id) || canViewAll(id)}
          onOpenRecords={(fid) => navigate(`/app/${appSlug}/form/${fid}/responses`)}
          onOpenRecord={(fid, rid) => navigate(`/app/${appSlug}/form/${fid}/responses/${rid}`)}
        />
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white dark:bg-slate-950" data-app-runtime role="dialog" aria-label="Edit section dashboard">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 dark:border-slate-800 px-4">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Edit section dashboard</h2>
            <button type="button" onClick={() => setEditing(false)} aria-label="Close" className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-700 dark:hover:text-white cursor-pointer">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 p-4">
            <DashboardBuilder
              initial={dashboard}
              scope="form"
              builderForms={thisForm}
              runReport={runReport}
              runBatch={runReportBatch}
              fetchRecent={fetchRecentRows}
              forms={forms}
              canViewForm={(id) => canViewOwn(id) || canViewAll(id)}
              accent={config.app.theme?.primaryColor}
              onSave={async (screen) => { const ok = await saveFormDashboard(formId, screen); if (ok) setEditing(false); return ok; }}
              onCancel={() => setEditing(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
