import { LayoutTemplate } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CustomScreenRuntime } from '../custom-screen/CustomScreenRuntime';
import { SdkScreenRuntime } from '../custom-screen/SdkScreenRuntime';
import { getSdkScreen } from '../custom-screen/sdkScreenRegistry';
import { useScreenBridge, resolveScreenTarget } from '../custom-screen/screenBridge';
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
  trust,
  appSlug,
  formId,
  responseId,
  record,
  fields,
  accentColor,
}: {
  screen: RecordScreen;
  /** Server-derived custom_screen_trust of the PARENT customScreen blob (the recordScreen is
   *  part of the same owner-saved blob, so it shares the form's trust level). Gates the code
   *  screen's TRUSTED_ONLY bridge actions — record()/related() need owner/verified. */
  trust?: 'owner' | 'verified' | 'untrusted';
  appSlug: string;
  formId: string;
  responseId: string;
  record: { id: string; answers: Record<string, unknown>; submittedAt?: string; status?: string };
  fields: Array<{ id: string; label: string; type: string; properties?: Record<string, unknown> }>;
  accentColor?: string;
}) {
  // Bridge v1 for code record screens: connector()/updateRecord()/presence().
  // Resolves undefined when the app-runtime store isn't initialized for THIS
  // app (e.g. the builder's record view) — the actions then reject honestly.
  const bridge = useScreenBridge(formId, appSlug);
  const navigate = useNavigate();
  let body: React.ReactNode = null;
  if (screen.kind === 'sdk') {
    // An unregistered id renders nothing rather than a broken card (old client, renamed screen).
    // Existence-checked here as a plain value; SdkScreenRuntime does the actual (error-bounded)
    // registry render so no component is created during THIS render.
    if (!screen.screenId || !getSdkScreen(screen.screenId)) return null;
    body = (
      <div className="p-5">
        <SdkScreenRuntime screenId={screen.screenId} params={screen.params} recordContext={{ appSlug, formId, responseId, record }} />
      </div>
    );
  } else if (screen.kind === 'code') {
    const height = Math.max(160, Math.min(1200, Number(screen.height) || 420));
    body = (
      <div style={{ height }}>
        <CustomScreenRuntime
          screen={{ html: screen.html, css: screen.css, js: screen.js, ts: screen.ts, files: screen.files, entry: screen.entry, _trust: trust }}
          formId={formId}
          appSlug={appSlug}
          fields={fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.properties?.options as Array<{ label: string; value: string }> | undefined }))}
          accentColor={accentColor}
          record={record}
          bridge={bridge}
          onOpenScreen={(target) => {
            // resolveScreenTarget reads the live app store — null outside a
            // matching app context (builder record views), so the SDK call
            // rejects honestly there.
            const resolved = resolveScreenTarget(target);
            if (!resolved) return false;
            navigate(`/app/${appSlug}/form/${resolved}`);
            return true;
          }}
          onOpenRecord={(target, recordId) => {
            const resolved = resolveScreenTarget(target);
            if (!resolved || !recordId) return false;
            navigate(`/app/${appSlug}/form/${resolved}/responses/${recordId}`);
            return true;
          }}
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
