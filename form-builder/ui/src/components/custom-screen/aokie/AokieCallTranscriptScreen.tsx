import { useEffect, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { api } from '../../../lib/api';
import type { RelatedRecordGroup } from '../../../lib/api';
import { describeSpeaker, turnBubble } from './callBubbles';
import type { SdkRecordContext } from '../sdkScreenRegistry';

/**
 * Record widget for a Calls row (customScreen.recordScreen, screenId 'aokie-call-transcript'):
 * renders the call's Transcript Turns as the same chat bubbles the live-call console uses,
 * instead of a raw related-records grid.
 *
 * Data comes from the record's related groups (match-based join turns.call_id = calls.call_id),
 * so it works for every record the flow wrote — no response_links required. The group it
 * consumes is `params.relatedFieldId` (default 'call_link'); the record view hides that group
 * from the generic related panel via recordScreen.consumesRelated.
 */

interface Turn {
  id: string;
  speaker: string;
  text: string;
  turnIndex: number | null;
  submittedAt?: string;
}

function toTurn(r: RelatedRecordGroup['records'][number]): Turn {
  const f = r.fields ?? {};
  const speaker = typeof f.speaker === 'string' && f.speaker ? f.speaker : 'system';
  const text = typeof f.text === 'string' ? f.text : String(f.text ?? '');
  const idx = f.turn_index;
  return {
    id: r.id,
    speaker,
    text,
    turnIndex: typeof idx === 'number' ? idx : (typeof idx === 'string' && idx !== '' && !Number.isNaN(Number(idx)) ? Number(idx) : null),
    submittedAt: r.submittedAt,
  };
}

// Turns rendered per "Load more" click. The full (server-capped) turn set is fetched once and
// kept in memory; rendering is chunked so a long call doesn't paint hundreds of bubbles up front.
const TURN_PAGE = 30;
// The related endpoint's match-join cap (RelatedRecords / answersEq limit). A group at exactly
// this size is almost certainly truncated to the newest turns.
const SERVER_TURN_CAP = 500;

export function AokieCallTranscriptScreen({ params, recordContext }: { params?: Record<string, unknown>; recordContext?: SdkRecordContext }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(TURN_PAGE);
  const relatedFieldId = typeof params?.relatedFieldId === 'string' && params.relatedFieldId ? params.relatedFieldId : 'call_link';

  const appSlug = recordContext?.appSlug;
  const formId = recordContext?.formId;
  const responseId = recordContext?.responseId;

  useEffect(() => {
    if (!appSlug || !formId || !responseId) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch effect: paging must reset synchronously when the record changes
    setTurns(null);
    setError(null);
    setVisibleCount(TURN_PAGE);
    api.getRelatedRecords(appSlug, formId, responseId).then((res) => {
      if (cancelled) return;
      if (res.error || !res.data) {
        setError(typeof res.error === 'string' ? res.error : 'Failed to load the transcript');
        return;
      }
      const groups = Object.values(res.data.related ?? {});
      // Several forms may link to Calls through a field named call_link (follow-up tasks do
      // too), so a fieldId match alone can pick the wrong group — require the group to
      // actually carry transcript turns (speaker + text).
      const looksLikeTurns = (g: RelatedRecordGroup): boolean => {
        const cols = g.columns ?? [];
        if (cols.some((c) => c.id === 'speaker') && cols.some((c) => c.id === 'text')) return true;
        const f = g.records?.[0]?.fields;
        return !!f && 'speaker' in f && 'text' in f;
      };
      const group = groups.find((g) => g.fieldId === relatedFieldId && looksLikeTurns(g));
      const rows = (group?.records ?? []).map(toTurn);
      // Chronological: the plugin numbers turns; timestamps break ties for flow-written rows.
      rows.sort((a, b) => {
        if (a.turnIndex !== null && b.turnIndex !== null && a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
        return String(a.submittedAt ?? '').localeCompare(String(b.submittedAt ?? ''));
      });
      setTurns(rows);
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load the transcript');
    });
    return () => { cancelled = true; };
  }, [appSlug, formId, responseId, relatedFieldId]);

  if (!recordContext) return null;

  const visible = turns?.slice(0, visibleCount) ?? [];
  const remaining = (turns?.length ?? 0) - visible.length;

  return (
    <div>
      {error ? (
        <p className="py-4 text-center text-sm text-red-500 dark:text-red-400">{error}</p>
      ) : turns === null ? (
        <div className="space-y-2 py-1" role="status" aria-label="Loading transcript">
          {[0, 1, 2].map((i) => (
            <div key={i} className={`h-9 w-2/3 animate-pulse rounded-xl bg-gray-100 dark:bg-slate-800 ${i % 2 ? 'ml-auto' : ''}`} />
          ))}
        </div>
      ) : turns.length === 0 ? (
        <div className="flex flex-col items-center py-6 text-center text-gray-400 dark:text-slate-500">
          <MessagesSquare className="mb-2 h-6 w-6 opacity-70" />
          <p className="text-sm">No transcript was recorded for this call.</p>
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs text-gray-400 dark:text-slate-500">
            {turns.length === 1 ? '1 turn' : `${turns.length} turns`}
            {turns.length >= SERVER_TURN_CAP && ' · showing the most recent turns'}
          </p>
          <div className="flex max-h-[28rem] flex-col gap-2.5 overflow-y-auto pr-1">
            {visible.map((t) => {
              const bubble = turnBubble(t.speaker);
              const who = describeSpeaker(t.speaker);
              return (
                <div key={t.id} className={bubble.row}>
                  <span className={`mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full text-[10px] font-semibold ${bubble.avatar}`} aria-hidden="true">
                    {bubble.initial}
                  </span>
                  <div className={`min-w-0 px-3 py-2 ${bubble.bubble}`}>
                    <span className={`block text-[11px] font-medium ${who.className}`}>{who.label}</span>
                    <p className="whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-slate-100">{t.text}</p>
                  </div>
                </div>
              );
            })}
            {remaining > 0 && (
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + TURN_PAGE)}
                className="mx-auto mb-1 mt-1 inline-flex shrink-0 cursor-pointer items-center rounded-full border border-gray-200/80 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 app-ring-primary dark:border-slate-700/60 dark:bg-slate-900/50 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800"
              >
                Load more ({remaining} more {remaining === 1 ? 'turn' : 'turns'})
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
