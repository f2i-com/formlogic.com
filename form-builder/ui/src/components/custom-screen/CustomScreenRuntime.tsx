import { useEffect, useMemo, useRef } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { useAuthStore } from '../../stores/authStore';

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
  var pending = {}, seq = 0;
  function call(action, payload){
    return new Promise(function(resolve, reject){
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      parent.postMessage({ __fl: true, id: id, action: action, payload: payload || {} }, '*');
    });
  }
  window.addEventListener('message', function(e){
    var m = e.data;
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
    /** This screen's context: { formId, title, fields }. */
    context: function(){ return call('context'); },
    toast: {
      success: function(msg){ return call('toast', { type: 'success', msg: String(msg) }); },
      error: function(msg){ return call('toast', { type: 'error', msg: String(msg) }); },
    },
  };
})();
`;

export interface CustomScreen { html?: string; css?: string; js?: string }

export function CustomScreenRuntime({
  screen,
  formId,
  formTitle,
  fields,
  className,
}: {
  screen: CustomScreen;
  formId: string;
  formTitle?: string;
  fields?: Array<{ id: string; label: string; type: string }>;
  className?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const user = useAuthStore((s) => s.user);

  const srcDoc = useMemo(() => {
    const css = screen.css || '';
    const html = screen.html || '';
    // Neutralize an early </script> in user code so it can't break out of its <script> block.
    const js = (screen.js || '').replace(/<\/script>/gi, '<\\/script>');
    return `<!doctype html><html><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width, initial-scale=1">`
      + `<style>html,body{margin:0;font-family:system-ui,sans-serif}${css}</style></head>`
      + `<body>${html}<script>${SDK_SHIM}</script><script>${js}</script></body></html>`;
  }, [screen.html, screen.css, screen.js]);

  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const m = e.data;
      // Only accept SDK messages from OUR sandboxed iframe.
      if (!m || !m.__fl || !iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      let result: unknown;
      let error: string | undefined;
      try {
        switch (m.action) {
          case 'submit': {
            const res = await api.submitResponse(formId, { answers: (m.payload?.answers as Record<string, unknown>) || {} });
            if (res.error || !res.data) throw new Error(typeof res.error === 'string' ? res.error : 'Submit failed');
            result = res.data.response;
            break;
          }
          case 'records': {
            const limit = Math.min(500, Math.max(1, Number(m.payload?.opts?.limit) || 100));
            const res = await api.getResponses(formId, { limit });
            const rows = (res.data?.responses || []) as unknown as Array<Record<string, unknown>>;
            result = rows.map((r) => ({ id: r.id, answers: r.answers, submittedAt: r.submittedAt, status: r.status, tags: r.tags }));
            break;
          }
          case 'currentUser':
            result = user ? { id: user.id, name: user.name, email: user.email } : null;
            break;
          case 'context':
            result = { formId, title: formTitle || '', fields: fields || [] };
            break;
          case 'toast':
            if (m.payload?.type === 'error') toast.error(String(m.payload?.msg || '')); else toast.success(String(m.payload?.msg || ''));
            result = true;
            break;
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
  }, [formId, formTitle, fields, user]);

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
