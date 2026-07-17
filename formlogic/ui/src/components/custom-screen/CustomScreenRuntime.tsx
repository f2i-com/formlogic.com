import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { SCREEN_CSP, createSdkRateLimiter, isScreenSdkActionAllowed } from './sdkRuntime';
import type { ScreenBridge } from './screenBridge';
import { subscribeDesktopEvents } from '../../client-runtime/desktop/desktopEvents';
import { startRealtimeCaptions } from './aokie/realtimeCaptions';
import {
  CAPTIONS_PUSH_BUDGET,
  EVENTS_PUSH_BUDGET,
  createScreenSubscriptions,
  envelopeMatchesFilter,
  sanitizeEventFilter,
  type ScreenSubscriptions,
} from './screenSubscriptions';
import { screenPaletteCss, SCREEN_THEME_SHIM } from './screenTheme';
import { readableForegroundColor } from '../../lib/color';
import { resolveScreenAssets } from '../../lib/screenCompile';

/**
 * Renders a custom screen ({ html, css, js }) inside a SANDBOXED iframe and bridges the FormLogic
 * SDK to the real backend.
 *
 * SECURITY MODEL: the iframe uses sandbox="allow-scripts" WITHOUT allow-same-origin, so its scripts
 * run in an opaque origin — they cannot read this app's cookies/DOM/localStorage, and cannot call
 * the API directly (cross-origin, no credentials). The ONLY way out is window.FormLogic, which
 * postMessages the trusted parent here; the parent authorizes the request (this user, THIS form) and
 * makes the real API call. So a custom screen can only do what the SDK exposes — nothing more.
 */

// Injected into the iframe — exposes window.FormLogic as a postMessage RPC bridge to the parent.
const SDK_SHIM = `
(function(){
  var pending = {}, seq = 0, pushSubs = {};
  function call(action, payload){
    return new Promise(function(resolve, reject){
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      // gen identifies THIS document instance (stamped by the host into the
      // srcDoc) — a reloaded screen's stale predecessor must not act.
      parent.postMessage({ __fl: true, gen: window.__flGen, id: id, action: action, payload: payload || {} }, '*');
    });
  }
  window.addEventListener('message', function(e){
    var m = e.data;
    if (m && m.__flPush) {
      var h = pushSubs[m.subId];
      if (h) { try { h({ kind: m.kind, seq: m.seq, data: m.data }); } catch (err) {} }
      return;
    }
    if (!m || !m.__flReply || !pending[m.id]) return;
    var p = pending[m.id]; delete pending[m.id];
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
  });
  window.FormLogic = {
    /** Save a response to this form (runs the form's onSubmit script + validation). */
    submit: function(answers){ return call('submit', { answers: answers }); },
    /** List this form's records (newest first). opts: { limit }. */
    records: function(opts){ return call('records', { opts: opts }); },
    /** The signed-in user, or null. */
    currentUser: function(){ return call('currentUser'); },
    /** This screen's context: { formId, title, fields } — choice fields include options [{label, value}]. */
    context: function(){ return call('context'); },
    toast: {
      success: function(msg){ return call('toast', { type: 'success', msg: String(msg) }); },
      error: function(msg){ return call('toast', { type: 'error', msg: String(msg) }); },
    },
    /** Open the real form for a new record (only when the owner enabled "allow new records"). */
    openForm: function(){ return call('openForm'); },
    /** Open this form's records view (app runtime only — rejects on public links). */
    openRecords: function(){ return call('openRecords'); },
    /** Record screens only: the record this screen is rendered for ({ id, answers, submittedAt, status }). */
    record: function(){ return call('record'); },
    /** Record screens only: this record's related-record groups (same shape as the related API). */
    related: function(){ return call('related'); },
    /** Invoke a GRANTED connector command (e.g. 'aokie', 'settings.get'). Routes to the local
     *  desktop or the owner's command relay automatically and resolves an OUTCOME object
     *  { status: 'done'|'failed'|'expired'|'uncertain', result, error, via, handledBy? } —
     *  command failures RESOLVE (check status), only bridge misuse rejects. 'uncertain' means a
     *  desktop claimed the command but hasn't reported back: the hardware may have acted. */
    connector: function(connectorId, command, payload){ return call('connector', { connectorId: connectorId, command: command, payload: payload || {} }); },
    /** Update one of this form's records: updateRecord(responseId, answers). Record screens may
     *  pass null to update the record being viewed. Server-side edit permission applies. */
    updateRecord: function(responseId, answers){ return call('updateRecord', { responseId: responseId, answers: answers || {} }); },
    /** Delete SPECIFIC records of this form by id (max 25 per call; there is deliberately no
     *  clear-all). Resolves { deleted: [ids], failed: [{id, error}] } — a refused row never
     *  aborts the rest. Server-side delete permission applies per row. */
    deleteRecords: function(responseIds){ return call('deleteRecords', { responseIds: responseIds || [] }); },
    /** Read records of ANOTHER form in this app: queryRecords(formTarget, { limit }). The
     *  target is a pack form key, form id, or display name; the server enforces YOUR view
     *  permission on that form (same as navigating to it). Resolves projected rows, or [] for
     *  an unknown/forbidden form. */
    queryRecords: function(formTarget, opts){ return call('queryRecords', { formTarget: String(formTarget == null ? '' : formTarget), opts: opts || {} }); },
    /** Where the app's connector hardware runtime is right now:
     *  { kind: 'local'|'remote'|'none', deviceName?, lastSeenAt? }. */
    presence: function(){ return call('presence'); },
    /** Live connector events (LOCAL desktop bridge only — nothing flows in remote mode; poll
     *  records instead, presence() tells you which). filter: { connectorId, names? }. The
     *  handler receives { kind, seq, data }: kind 'event' carries the event envelope in data;
     *  kind 'dropped' means pushes were rate-shed — re-read records (there is no replay).
     *  Resolves { unsubscribe }. */
    events: {
      subscribe: function(filter, handler){
        return call('eventsSubscribe', { filter: filter || {} }).then(function(r){
          pushSubs[r.subId] = handler;
          return { unsubscribe: function(){ delete pushSubs[r.subId]; return call('eventsUnsubscribe', { subId: r.subId }); } };
        });
      },
    },
    /** Live caption state for the active call (LOCAL bridge only; volatile lane — droppable by
     *  design). handler({ kind: 'captions'|'dropped', seq, data: captionState }). Resolves
     *  { unsubscribe, tombstone } — call tombstone() when a durable caller turn lands so late
     *  partials stay dead (final wins). One captions subscription per screen. */
    captions: {
      subscribe: function(handler){
        return call('captionsSubscribe', {}).then(function(r){
          pushSubs[r.subId] = handler;
          return {
            unsubscribe: function(){ delete pushSubs[r.subId]; return call('eventsUnsubscribe', { subId: r.subId }); },
            tombstone: function(){ return call('captionsTombstone', { subId: r.subId }); },
          };
        });
      },
    },
    /** Run a SERVER-REGISTERED typed service operation (plan §8.3). Resolves an OUTCOME
     *  { status: 'done'|'failed', result?, error? } — operation refusals (unknown op, no
     *  permission) resolve as failed; only misuse (bad id, oversized input) rejects. */
    service: function(operationId, input){ return call('service', { operationId: operationId, input: input || {} }); },
    /** ADVISORY permission check: true when this app declares the permission for this
     *  screen's scope (the same gate connector() applies) — use it to grey out buttons.
     *  The native bridge and the server stay the real trust boundary. */
    can: function(permission){ return call('can', { permission: String(permission == null ? '' : permission) }); },
    /** Host-mediated surfaces (ceremonies stay HOST-owned — a pack screen can only ask the
     *  host to open one of its own screens or run a NAMED ceremony with the host's own
     *  consent UI; the pack never runs a ceremony itself). */
    host: {
      /** Navigate the surrounding app to another of its screens. target = a real form id or
       *  the pack's stable form key (settings.packFormId). Rejects for unknown targets. */
      openScreen: function(target){ return call('openScreen', { target: String(target == null ? '' : target) }); },
      /** Ask the host to run a NAMED ceremony ('connect-desktop' = the desktop pairing
       *  flow, approved on the desktop; 'start-fresh' = whole-app record reset behind the
       *  host's own confirm dialog). Resolves { status: 'done'|'failed'|'denied'|
       *  'unavailable', message?, deleted? } — only an unknown name rejects. */
      ceremony: function(name){ return call('ceremony', { name: String(name == null ? '' : name) }); },
    },
    /** Escape a value for safe interpolation into innerHTML (prevents stored-XSS from record data). */
    escapeHtml: function(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); },
  };
})();
`;

export interface CustomScreen { html?: string; css?: string; js?: string; ts?: string; files?: Array<{ path: string; content: string }>; entry?: string; allowNewResponses?: boolean; _trust?: 'owner' | 'verified' | 'untrusted' }

export function CustomScreenRuntime({
  screen,
  formId,
  formTitle,
  fields,
  className,
  publicMode = false,
  appSlug,
  accentColor,
  onOpenForm,
  onOpenRecords,
  record,
  fetchRelated,
  bridge,
  onOpenScreen,
  onCeremony,
}: {
  screen: CustomScreen;
  formId: string;
  formTitle?: string;
  fields?: Array<{ id: string; label: string; type: string; options?: Array<{ label: string; value: string }> }>;
  className?: string;
  /** Public link/embed context (anonymous): records() uses the gated public endpoint, not the owner API. */
  publicMode?: boolean;
  /** App-runtime context: route submit/records through the app API (membership + permission checks). */
  appSlug?: string;
  /** Accent for the injected --fl-* palette: the app accent in-app, else the form theme's primary. */
  accentColor?: string;
  /** Wired when "allow new records" is on — the SDK's openForm() reveals the real form. */
  onOpenForm?: () => void;
  /** Wired in the app runtime — the SDK's openRecords() opens this form's records table. */
  onOpenRecords?: () => void;
  /** Record screens: the record this screen renders for — exposed via FormLogic.record(). */
  record?: { id: string; answers: Record<string, unknown>; submittedAt?: string; status?: string };
  /** Record screens: fetch this record's related groups — exposed via FormLogic.related(). */
  fetchRelated?: () => Promise<unknown>;
  /** Bridge v1 (app runtime only): connector()/updateRecord()/presence(). Absent on builder
   *  previews and public links — those actions then reject with an honest message. */
  bridge?: ScreenBridge;
  /** Host navigation for FormLogic.host.openScreen (app runtime only): resolve the target
   *  (form id or pack form key) and switch the app shell to it. Return false for an unknown
   *  target — the SDK call then rejects honestly. */
  onOpenScreen?: (target: string) => boolean | Promise<boolean>;
  /** Named host ceremonies for FormLogic.host.ceremony (app runtime only): run the host's
   *  own flow (with its own consent UI) and resolve the outcome. Return null for an
   *  unknown ceremony name — the SDK call then rejects honestly. */
  onCeremony?: (name: string) => Promise<{ status: string; message?: string; deleted?: number } | null>;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const rateRef = useRef(createSdkRateLimiter());
  // Document generation: bumped whenever the srcDoc rebuilds and stamped
  // into the shim (window.__flGen). The iframe element — and so its
  // WindowProxy — survives a srcdoc update, and the OLD document keeps
  // draining its task queue briefly after React commits the new one; its
  // messages must be refused or a stale subscribe could start an ownerless
  // feed AFTER the reload cleanup ran (review 2026-07-17).
  const genRef = useRef(0);
  // Live subscription relay (events/captions): host-owned feeds pushed into
  // the iframe as __flPush frames. A ref so re-renders never drop active
  // subscriptions; cleared when the iframe reloads and on unmount.
  const subsRef = useRef<ScreenSubscriptions | null>(null);
  const subscriptions = () => {
    if (!subsRef.current) {
      subsRef.current = createScreenSubscriptions((frame) => {
        iframeRef.current?.contentWindow?.postMessage(frame, '*');
      });
    }
    return subsRef.current;
  };
  const user = useAuthStore((s) => s.user);
  // Drive the screen's light/dark from the viewer's theme (same contract as the app-home runtime).
  const colorScheme = useUIStore((s) => s.theme);
  const schemeRef = useRef(colorScheme);
  schemeRef.current = colorScheme;

  // Resolve the screen to { html, css, js }: a single precompiled `js` (fast, public pages), or compile
  // `ts` / bundle a multi-file `files` project on the fly (lazy esbuild — never weighs on `js` screens).
  const [assets, setAssets] = useState<{ html: string; css: string; js: string }>({ html: screen.html || '', css: screen.css || '', js: screen.js || '' });
  useEffect(() => {
    let cancelled = false;
    resolveScreenAssets({ html: screen.html, css: screen.css, js: screen.js, ts: screen.ts, files: screen.files, entry: screen.entry })
      .then((a) => { if (!cancelled) setAssets({ html: a.html, css: a.css, js: a.js }); });
    return () => { cancelled = true; };
  }, [screen.html, screen.css, screen.js, screen.ts, screen.files, screen.entry]);

  const srcDoc = useMemo(() => {
    const css = assets.css || '';
    const html = assets.html || '';
    // Neutralize an early </script> in user code so it can't break out of its <script> block.
    const js = (assets.js || '').replace(/<\/script>/gi, '<\\/script>');
    // Initial mode from a ref so theme toggles update via postMessage without rebuilding the iframe.
    const dark = schemeRef.current === 'dark';
    const accent = accentColor || '#6366f1';
    const palette = screenPaletteCss(accent, readableForegroundColor(accent));
    // Each rebuilt document gets a fresh generation stamp (see genRef).
    genRef.current += 1;
    // SDK shim goes in <head> so window.FormLogic exists before any user script (inline or block) runs.
    return `<!doctype html><html class="${dark ? 'fl-dark' : ''}"><head><meta charset="utf-8">`
      + `<meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<meta name="color-scheme" content="light dark">`
      + `<script>var __flGen=${genRef.current};${SDK_SHIM}${SCREEN_THEME_SHIM}</script>`
      + `<style>html,body{margin:0;font-family:system-ui,sans-serif}${palette}${css}</style></head>`
      + `<body>${html}<script>${js}</script></body></html>`;
  }, [assets, accentColor]);

  // Push theme changes into the already-loaded iframe (instant, no reload).
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ __flTheme: colorScheme }, '*');
  }, [colorScheme]);

  // A reloaded iframe (srcDoc change) boots a fresh shim with no known
  // subIds — stop the old feeds rather than pushing frames nobody hears.
  // The same cleanup covers unmount.
  useEffect(() => () => subsRef.current?.clear(), [srcDoc]);

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const m = e.data;
      // Only accept SDK messages from OUR sandboxed iframe.
      if (!m || !m.__fl || !iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      // …and only from the CURRENT document generation: the WindowProxy
      // survives a srcdoc reload, so the dying predecessor can still post —
      // acting on it could start an ownerless subscription after the reload
      // cleanup already ran. Refuse with an honest error instead.
      if (typeof m.gen === 'number' && m.gen !== genRef.current) {
        iframeRef.current.contentWindow?.postMessage(
          { __flReply: true, id: m.id, error: 'This screen was reloaded — request ignored.' },
          '*'
        );
        return;
      }
      let result: unknown;
      let error: string | undefined;
      if (!rateRef.current(String(m.action))) {
        iframeRef.current.contentWindow?.postMessage({ __flReply: true, id: m.id, error: 'Too many requests — slow down.' }, '*');
        return;
      }
      try {
        if (!isScreenSdkActionAllowed(screen._trust, String(m.action))) {
          throw new Error('This SDK action is disabled for an unverified custom screen.');
        }
        switch (m.action) {
          case 'submit': {
            const answers = (m.payload?.answers as Record<string, unknown>) || {};
            if (JSON.stringify(answers).length > 262144) throw new Error('Submission is too large');
            const res = appSlug
              ? await api.createAppResponse(appSlug, formId, { answers })
              : await api.submitResponse(formId, { answers });
            if (res.error || !res.data) throw new Error(typeof res.error === 'string' ? res.error : 'Submit failed');
            result = (res.data as { response: unknown }).response;
            break;
          }
          case 'records': {
            const limit = Math.min(500, Math.max(1, Number(m.payload?.opts?.limit) || 100));
            if (appSlug) {
              const res = await api.getAppResponses(appSlug, formId, { limit });
              const rows = (res.data?.responses || []) as Array<Record<string, unknown>>;
              result = rows.map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt, status: r.status, tags: r.tags }));
            } else if (publicMode) {
              const res = await api.getScreenRecords(formId, { limit });
              result = (res.data?.records || []).map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt }));
            } else {
              const res = await api.getResponses(formId, { limit });
              const rows = (res.data?.responses || []) as unknown as Array<Record<string, unknown>>;
              result = rows.map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt, status: r.status, tags: r.tags }));
            }
            break;
          }
          case 'currentUser':
            result = user ? { id: user.id, name: user.name, email: user.email } : null;
            break;
          case 'context':
            result = { formId, title: formTitle || '', fields: fields || [] };
            break;
          case 'toast': {
            const msg = String(m.payload?.msg || '').slice(0, 200);
            if (m.payload?.type === 'error') toast.error(msg); else toast.success(msg);
            result = true;
            break;
          }
          case 'openForm': {
            if (onOpenForm) { onOpenForm(); result = true; }
            else throw new Error('New records are not enabled for this screen.');
            break;
          }
          case 'openRecords': {
            if (onOpenRecords) { onOpenRecords(); result = true; }
            else throw new Error('Records are not available here.');
            break;
          }
          case 'record': {
            if (!record) throw new Error('record() is only available on record screens.');
            result = { id: record.id, answers: record.answers, submittedAt: record.submittedAt, status: record.status };
            break;
          }
          case 'related': {
            if (!fetchRelated) throw new Error('related() is only available on record screens.');
            result = await fetchRelated();
            break;
          }
          case 'connector': {
            if (!bridge) throw new Error('connector() is not available on this screen.');
            result = await bridge.connectorInvoke(
              String(m.payload?.connectorId || ''),
              String(m.payload?.command || ''),
              (m.payload?.payload && typeof m.payload.payload === 'object'
                ? m.payload.payload
                : {}) as Record<string, unknown>
            );
            break;
          }
          case 'updateRecord': {
            if (!bridge) throw new Error('updateRecord() is not available on this screen.');
            // Record screens may omit the id to update the record being viewed.
            const responseId = String(m.payload?.responseId || '') || record?.id || '';
            const answers = (m.payload?.answers && typeof m.payload.answers === 'object'
              ? m.payload.answers
              : {}) as Record<string, unknown>;
            result = await bridge.updateRecord(responseId, answers);
            break;
          }
          case 'deleteRecords': {
            if (!bridge) throw new Error('deleteRecords() is not available on this screen.');
            const responseIds = Array.isArray(m.payload?.responseIds)
              ? (m.payload.responseIds as unknown[]).map((v) => String(v ?? ''))
              : [];
            result = await bridge.deleteRecords(responseIds);
            break;
          }
          case 'queryRecords': {
            if (!bridge) throw new Error('queryRecords() is not available on this screen.');
            result = await bridge.queryRecords(
              String(m.payload?.formTarget || ''),
              m.payload?.opts && typeof m.payload.opts === 'object' ? m.payload.opts : {}
            );
            break;
          }
          case 'presence': {
            if (!bridge) throw new Error('presence() is not available on this screen.');
            result = await bridge.presence();
            break;
          }
          case 'service': {
            if (!bridge) throw new Error('service() is not available on this screen.');
            result = await bridge.serviceInvoke(
              String(m.payload?.operationId || ''),
              (m.payload?.input && typeof m.payload.input === 'object'
                ? m.payload.input
                : {}) as Record<string, unknown>
            );
            break;
          }
          case 'openScreen': {
            if (!onOpenScreen) throw new Error('host.openScreen() is not available on this screen.');
            const target = String(m.payload?.target || '');
            if (!target) throw new Error('host.openScreen() needs a target screen.');
            const ok = await onOpenScreen(target);
            if (!ok) throw new Error(`Unknown screen: ${target}`);
            result = true;
            break;
          }
          case 'can': {
            if (!bridge) throw new Error('can() is not available on this screen.');
            result = bridge.can(String(m.payload?.permission || ''));
            break;
          }
          case 'ceremony': {
            if (!onCeremony) throw new Error('host.ceremony() is not available on this screen.');
            const name = String(m.payload?.name || '');
            if (!name) throw new Error('host.ceremony() needs a ceremony name.');
            const outcome = await onCeremony(name);
            if (outcome === null) throw new Error(`Unknown ceremony: ${name}`);
            result = outcome;
            break;
          }
          case 'eventsSubscribe': {
            if (!bridge) throw new Error('events.subscribe() is not available on this screen.');
            // The live feed comes from the OPERATOR's real desktop — the
            // shared demo must never attach to it (a demo tab can hold a
            // pairing token when the operator used the real app first).
            if (!bridge.liveFeedsAllowed()) {
              throw new Error('Live subscriptions are not available in the shared demo.');
            }
            const filter = sanitizeEventFilter(m.payload?.filter);
            if (!filter) throw new Error('events.subscribe() needs a filter with a connectorId.');
            if (!bridge.canObserveConnector(filter.connectorId)) {
              throw new Error(
                `This app has no "connector.${filter.connectorId}.*" grants to observe events for.`
              );
            }
            const subId = subscriptions().add(
              'events',
              (emit) => ({
                stop: subscribeDesktopEvents((envelope) => {
                  if (envelopeMatchesFilter(envelope, filter)) emit('event', envelope);
                }),
              }),
              EVENTS_PUSH_BUDGET
            );
            if (subId == null) throw new Error('Too many live subscriptions on this screen.');
            result = { subId };
            break;
          }
          case 'captionsSubscribe': {
            if (!bridge) throw new Error('captions.subscribe() is not available on this screen.');
            if (!bridge.liveFeedsAllowed()) {
              throw new Error('Live subscriptions are not available in the shared demo.');
            }
            // Enforce the documented LOCAL-only contract at subscribe time:
            // the captions reader retries its loopback fetch forever, so
            // starting it with no local bridge would just burn a failing
            // request every ≤15s for the subscription's life (the events
            // hub self-gates on detection+pairing, so events may late-bind).
            if (!bridge.localBridgeAvailable()) {
              throw new Error(
                'captions.subscribe() needs the local desktop bridge — check presence(); remote mode polls records instead.'
              );
            }
            // The volatile lane is the aokie realtime feed — same observe
            // gate as its events.
            if (!bridge.canObserveConnector('aokie')) {
              throw new Error('This app has no "connector.aokie.*" grants to observe captions for.');
            }
            if (subscriptions().hasKind('captions')) {
              throw new Error('This screen already subscribes to captions.');
            }
            const subId = subscriptions().add(
              'captions',
              (emit) => {
                const handle = startRealtimeCaptions((state) => emit('captions', state));
                return { stop: handle.stop, tombstone: handle.tombstone };
              },
              CAPTIONS_PUSH_BUDGET
            );
            if (subId == null) throw new Error('Too many live subscriptions on this screen.');
            result = { subId };
            break;
          }
          case 'eventsUnsubscribe': {
            result = subsRef.current?.remove(Number(m.payload?.subId)) ?? false;
            break;
          }
          case 'captionsTombstone': {
            result = subsRef.current?.tombstone(Number(m.payload?.subId)) ?? false;
            break;
          }
          default:
            error = `Unknown action: ${m.action}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Request failed';
      }
      iframeRef.current?.contentWindow?.postMessage({ __flReply: true, id: m.id, result, error }, '*');
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [formId, formTitle, fields, user, publicMode, appSlug, onOpenForm, onOpenRecords, record, fetchRelated, bridge, onOpenScreen, onCeremony, screen._trust]);

  return (
    <iframe
      ref={iframeRef}
      title="Custom screen"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={className || 'w-full h-full border-0'}
    />
  );
}
