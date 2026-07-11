import { LayoutTemplate } from 'lucide-react';
import { CustomScreenRuntime } from '../custom-screen/CustomScreenRuntime';
import { getSdkScreen } from '../custom-screen/sdkScreenRegistry';
import { api } from '../../lib/api';
import type { RecordScreen } from '../../types/form';

/**
 * Per-record widget on the record detail view (customScreen.recordScreen).
 *
 * 'sdk' renders a trusted first-party screen from the registry with the record context
 * (host-rendered — same trust model as section SDK screens). 'code' renders sandboxed
 * HTML/CSS/JS in the CustomScreenRuntime iframe, whose SDK additionally exposes
 * FormLogic.record() and FormLogic.related() for this record.
 */
export function RecordScreenPanel({
  screen,
  appSlug,
  formId,
  responseId,
  record,
  fields,
  accentColor,
}: {
  screen: RecordScreen;
  appSlug: string;
  formId: string;
  responseId: string;
  record: { id: string; answers: Record<string, unknown>; submittedAt?: string; status?: string };
  fields: Array<{ id: string; label: string; type: string; properties?: Record<string, unknown> }>;
  accentColor?: string;
}) {
  let body: React.ReactNode = null;
  if (screen.kind === 'sdk') {
    const Comp = screen.screenId ? getSdkScreen(screen.screenId) : undefined;
    // An unregistered id renders nothing rather than a broken card (old client, renamed screen).
    if (!Comp) return null;
    body = (
      <div className="p-5">
        <Comp params={screen.params} recordContext={{ appSlug, formId, responseId, record }} />
      </div>
    );
  } else if (screen.kind === 'code') {
    const height = Math.max(160, Math.min(1200, Number(screen.height) || 420));
    body = (
      <div style={{ height }}>
        <CustomScreenRuntime
          screen={{ html: screen.html, css: screen.css, js: screen.js, ts: screen.ts, files: screen.files, entry: screen.entry }}
          formId={formId}
          appSlug={appSlug}
          fields={fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.properties?.options as Array<{ label: string; value: string }> | undefined }))}
          accentColor={accentColor}
          record={record}
          fetchRelated={async () => {
            const res = await api.getRelatedRecords(appSlug, formId, responseId);
            if (res.error || !res.data) throw new Error(typeof res.error === 'string' ? res.error : 'Failed to load related records');
            return res.data.related ?? {};
          }}
        />
      </div>
    );
  } else {
    return null;
  }

  return (
    <div className="mt-4 bg-white dark:bg-slate-900/50 rounded-2xl border border-gray-200/80 dark:border-slate-700/60 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 dark:border-slate-700/40 flex items-center gap-2">
        <LayoutTemplate className="h-4 w-4 app-text-primary" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white tracking-tight">{screen.title || 'Details'}</h3>
      </div>
      {body}
    </div>
  );
}
