import { useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE,
  aiSources,
  aokieCompanionPairing,
  plugins,
  type PluginSnapshot,
} from './api';
import {
  composeScreenSrcDoc,
  journalledRequestIdFor,
  parseScreenRpcMessage,
  resolveEventSubscriptionNames,
  screenAssetPath,
  screenAssets,
  type PluginScreenAssets,
  type PluginScreenDecl,
} from './pluginScreens';
import { useToast, type ToastKind } from './Toasts';
import type { ThemeMode } from './theme';

/**
 * Host for a plugin-shipped SANDBOXED screen (manifest v2 `ui.screens`,
 * opened by a `ui.nav` entry that declares `screen`). Loads the bundle from
 * the authenticated serving route, inlines it into a srcDoc, and renders it
 * in a sandboxed iframe with a typed postMessage RPC bridge.
 *
 * SECURITY INVARIANTS (keep these true):
 *  - the iframe uses sandbox="allow-scripts" WITHOUT allow-same-origin — the
 *    screen runs in an OPAQUE origin: it cannot read this window's DOM,
 *    cookies, or localStorage, and cannot reach the desktop API directly;
 *  - the document's CSP forbids ALL network (default-src/connect-src 'none');
 *    every asset is inlined at compose time, so the only effects a screen can
 *    have flow through the typed bridge below;
 *  - the bridge CLOSES OVER this page's plugin id: every command, consent,
 *    snapshot, and event subscription is scoped to THIS plugin — screen code
 *    can structurally never name another plugin;
 *  - companion pairing ops are EXTRA-gated on the plugin id being 'aokie'
 *    (the only pairing broker today). TODO: replace with capability-based
 *    gating (a manifest capability the host checks) when a second broker
 *    plugin exists;
 *  - each composed document carries a generation stamp; messages from a stale
 *    generation (the dying predecessor after a srcdoc reload) are refused
 *    with an honest error, and its event feeds are stopped.
 */

/** Raw text GET against the desktop API (same base/timeout/error surfacing as
 *  api.ts `request`, but text — screen assets are not JSON). The webview
 *  origin passes the /api/plugins* auth guard, same as every api.ts call. */
async function fetchScreenAsset(
  pluginId: string,
  screenId: string,
  relPath: string,
): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const resp = await fetch(`${API_BASE}${screenAssetPath(pluginId, screenId, relPath)}`, {
      signal: ac.signal,
    });
    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        const body = await resp.json();
        if (typeof body?.error === 'string') detail = body.error;
        else if (body?.error?.message) detail = body.error.message;
      } catch {
        /* not JSON — keep the status text */
      }
      throw new Error(`${relPath}: ${resp.status} ${detail}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

const TOAST_KINDS: readonly ToastKind[] = ['success', 'error', 'info'];

/** One live event subscription: the SSE listeners registered for it. */
interface ScreenEventSub {
  listeners: Array<readonly [string, (e: MessageEvent) => void]>;
}

export default function PluginScreenPage({
  plugin,
  screen,
  theme,
}: {
  plugin: PluginSnapshot;
  screen: PluginScreenDecl;
  theme: ThemeMode;
}) {
  const toast = useToast();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Snapshot ref: the overview poll replaces the plugin object every few
  // seconds — the bridge reads the LATEST snapshot without resubscribing
  // the message handler each poll.
  const pluginRef = useRef(plugin);
  pluginRef.current = plugin;
  // Document generation (see pluginScreens.parseScreenRpcMessage): bumped on
  // every srcDoc rebuild; stale-generation messages are refused.
  const genRef = useRef(0);
  // Theme ref so the srcDoc keeps its identity across theme flips (flips go
  // via postMessage — rebuilding the srcDoc would reload the screen AND add a
  // browser history entry, the web runtime's "press Back twice" lesson).
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const [assets, setAssets] = useState<PluginScreenAssets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // ---- asset loading (keyed on CONTENT-stable strings — the snapshot object
  // identity changes every poll and must not refetch the bundle) ----
  const filesKey = screen.files.join('\n');
  useEffect(() => {
    let alive = true;
    setAssets(null);
    setLoadError(null);
    const decl = { entry: screen.entry, files: filesKey.split('\n').filter(Boolean) };
    screenAssets(decl, (rel) => fetchScreenAsset(plugin.id, screen.id, rel))
      .then((a) => {
        if (alive) setAssets(a);
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, screen.id, screen.entry, filesKey, reloadNonce]);

  const srcDoc = useMemo(() => {
    if (!assets) return null;
    genRef.current += 1;
    return composeScreenSrcDoc({
      html: assets.html,
      css: assets.css,
      js: assets.js,
      dark: themeRef.current === 'dark',
      gen: genRef.current,
    });
    // Content strings only — an equal-valued assets object must not rebuild
    // (a srcdoc mutation on the live iframe adds a history entry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets?.html, assets?.css, assets?.js]);

  // Push theme flips into the loaded document (instant, no reload).
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ __pluginScreenTheme: theme }, '*');
  }, [theme]);

  // ---- live event feeds: ONE parent EventSource on /api/events, filtered to
  // the names THIS plugin's manifest declares, pushed into the iframe as
  // { __pluginScreenPush, gen, subId, frame } (same transport as
  // aokie/useAokieEvents — the webview origin passes the auth guard). ----
  const eventSourceRef = useRef<EventSource | null>(null);
  const subsRef = useRef(new Map<number, ScreenEventSub>());
  const subSeqRef = useRef(0);

  const removeSub = (subId: number): boolean => {
    const sub = subsRef.current.get(subId);
    if (!sub) return false;
    for (const [name, fn] of sub.listeners) {
      eventSourceRef.current?.removeEventListener(name, fn);
    }
    subsRef.current.delete(subId);
    if (subsRef.current.size === 0) {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    }
    return true;
  };

  const clearSubs = () => {
    for (const subId of [...subsRef.current.keys()]) removeSub(subId);
  };

  const addSub = (names: string[]): number => {
    if (!eventSourceRef.current) {
      eventSourceRef.current = new EventSource(`${API_BASE}/api/events`);
    }
    const source = eventSourceRef.current;
    const subId = ++subSeqRef.current;
    const listeners = names.map((name) => {
      const fn = (ev: MessageEvent) => {
        let data: unknown = ev.data;
        try {
          data = JSON.parse(String(ev.data));
        } catch {
          /* non-JSON payload — deliver the raw string */
        }
        iframeRef.current?.contentWindow?.postMessage(
          { __pluginScreenPush: true, gen: genRef.current, subId, frame: { name, data } },
          '*',
        );
      };
      source.addEventListener(name, fn);
      return [name, fn] as const;
    });
    subsRef.current.set(subId, { listeners });
    return subId;
  };

  // A reloaded iframe boots a fresh shim with no known subIds — stop the old
  // feeds rather than pushing frames nobody hears. Also covers unmount.
  useEffect(() => () => clearSubs(), [srcDoc]);

  // ---- the RPC bridge ----
  useEffect(() => {
    const pluginId = plugin.id;
    const handler = async (e: MessageEvent) => {
      // Only OUR sandboxed iframe may speak to this bridge.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const parsed = parseScreenRpcMessage(e.data, genRef.current);
      if (parsed.kind === 'ignore') return;
      const reply = (callId: number, result: unknown, error?: string) => {
        iframeRef.current?.contentWindow?.postMessage(
          { __pluginScreenReply: true, callId, result, error },
          '*',
        );
      };
      if (parsed.kind === 'stale') {
        reply(parsed.callId, undefined, 'This screen was reloaded — request ignored.');
        return;
      }
      const { callId, op, args } = parsed;
      let result: unknown;
      let error: string | undefined;
      try {
        switch (op) {
          case 'command': {
            const command = String(args.command ?? '');
            if (!command) throw new Error('command() needs a command name.');
            // Journalled commands (the plugin MANIFEST's list, generalized
            // from the hardcoded aokie set) get a durable requestId minted
            // here — the plugin refuses journalled commands without one.
            const requestId =
              journalledRequestIdFor(pluginRef.current.journalledCommands, command) ?? undefined;
            const res = await plugins.command(pluginId, command, args.payload, requestId);
            result = res?.data;
            break;
          }
          case 'consentGet': {
            const res = await plugins.command(pluginId, 'consent.get');
            result = res?.data;
            break;
          }
          case 'consentIssue': {
            const grant =
              args.grant && typeof args.grant === 'object' && !Array.isArray(args.grant)
                ? (args.grant as Record<string, unknown>)
                : null;
            if (!grant || !grant.scopes || typeof grant.scopes !== 'object') {
              throw new Error('consent.issue() needs a grant with a scopes object.');
            }
            const res = await plugins.issueConsent(pluginId, {
              scopes: grant.scopes as Record<string, unknown>,
              version: typeof grant.version === 'number' ? grant.version : undefined,
              acceptedBy: typeof grant.acceptedBy === 'string' ? grant.acceptedBy : undefined,
              expiresDays: typeof grant.expiresDays === 'number' ? grant.expiresDays : undefined,
            });
            result = res?.data ?? true;
            break;
          }
          case 'companionPairing': {
            // The pairing broker endpoints are aokie-specific today. The
            // bridge already scopes to THIS plugin; this extra gate keeps a
            // non-broker plugin's screen from driving the broker. TODO:
            // capability-based gating when a second broker plugin exists.
            if (pluginId !== 'aokie') {
              throw new Error('Companion pairing is not available to this plugin.');
            }
            const pairingOp = String(args.op ?? '');
            const opArgs = Array.isArray(args.args) ? (args.args as unknown[]) : [];
            switch (pairingOp) {
              case 'status':
                result = await aokieCompanionPairing.status();
                break;
              case 'createOffer':
                result = await aokieCompanionPairing.createOffer(
                  opArgs[0] && typeof opArgs[0] === 'object'
                    ? (opArgs[0] as { appId?: string; workspaceId?: string; desktopConnectionId?: string })
                    : {},
                );
                break;
              case 'receiveResponse':
                result = await aokieCompanionPairing.receiveResponse(opArgs[0]);
                break;
              case 'approve':
                result = await aokieCompanionPairing.approve(String(opArgs[0] ?? ''));
                break;
              case 'deny':
                result = await aokieCompanionPairing.deny(String(opArgs[0] ?? ''));
                break;
              case 'revoke':
                result = await aokieCompanionPairing.revoke(String(opArgs[0] ?? ''));
                break;
              case 'rotateDesktopKey':
                result = await aokieCompanionPairing.rotateDesktopKey();
                break;
              default:
                throw new Error(`Unknown companion pairing op: ${pairingOp}`);
            }
            break;
          }
          case 'aiSources': {
            result = (await aiSources.list()).sources;
            break;
          }
          case 'snapshot': {
            const list = await plugins.list();
            result = list.plugins.find((p) => p.id === pluginId) ?? null;
            break;
          }
          case 'eventsSubscribe': {
            const resolved = resolveEventSubscriptionNames(
              pluginRef.current.events ?? [],
              args.names,
            );
            if (!resolved.ok) throw new Error(resolved.error);
            result = { subId: addSub(resolved.names) };
            break;
          }
          case 'eventsUnsubscribe': {
            result = removeSub(Number(args.subId));
            break;
          }
          case 'toast': {
            const kind = TOAST_KINDS.includes(args.kind as ToastKind)
              ? (args.kind as ToastKind)
              : 'info';
            const msg = String(args.msg ?? '').slice(0, 200);
            if (msg) toast.push({ kind, title: msg });
            result = true;
            break;
          }
          default:
            error = `Unknown op: ${op}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : 'Request failed';
      }
      reply(callId, result, error);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
    // pluginRef carries the live snapshot; only an actual plugin change needs
    // a fresh closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, toast]);

  return (
    <div className="panel plugin-screen-host">
      {loadError && (
        <div className="empty-state">
          <p style={{ margin: '0 0 10px' }}>
            Couldn&apos;t load the <strong>{screen.title}</strong> screen from the{' '}
            <strong>{plugin.name}</strong> plugin.
          </p>
          <p className="service-error" style={{ margin: '0 0 14px' }}>{loadError}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {!loadError && !assets && (
        <div className="section-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Loading {screen.title}…
        </div>
      )}
      {!loadError && srcDoc != null && (
        <iframe
          ref={iframeRef}
          title={screen.title}
          // Opaque origin: scripts only, never allow-same-origin (see the
          // security invariants at the top of this file).
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="plugin-screen-frame"
        />
      )}
    </div>
  );
}
