import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { workspaceBridge } from "../../lib/softn/workspaceBridge";
import { NATIVE_PROTOCOL } from "../../lib/softn/protocol";
import { engineIdentity, engineNeedsBytes, getEngineBytes } from "../../lib/formlogic/zipp-bytes";
import { announcedIdentity, chooseFrameEngine, frameSource, sameIdentity } from "../../lib/formlogic/frameEngine";

import { nativeAppStorage, NativeStorageError } from "../../lib/nativeAppStorage";

const navigate = (path: string) => window.location.assign(path);

/** The server's decision for one mount: the engine to run, and the revision actions send back. */
type FrameEngine = { id: string; revision: string };
// The frame bootstraps once. Its DOM lifetime must match the effect's client
// identity, including replacing source without changing a deployment version.
const clientIdentities = new WeakMap<Record<string, string>, number>();
let nextClientIdentity = 0;
function clientIdentity(client: Record<string, string>): number {
  let identity = clientIdentities.get(client);
  if (identity === undefined) {
    identity = ++nextClientIdentity;
    clientIdentities.set(client, identity);
  }
  return identity;
}

export function HostedAppFrame({
  slug,
  client,
  version,
  native,
  engine,
}: {
  slug: string;
  client: Record<string, string>;
  version: number;
  native?: { assets: Record<string, string>; origins?: string[] };
  /**
   * The engine the SERVER decided this app runs on, from the runtime GET, with the revision every
   * action sends back in X-FormLogic-Client-Engine. Absent (a server from before the decision, or
   * a mount with no runtime GET) means the engine every hosted app has always run, claimed to
   * nobody: no revision, so no header.
   */
  engine?: FrameEngine;
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  const [error, setError] = useState("");
  // Audit FL-S07: damaged saved browser data stops the app before it starts,
  // with the owner's choices in front of them, rather than being filtered
  // into something that looks healthy. Reset boots a fresh frame.
  const [storageIssue, setStorageIssue] = useState<{ message: string; exportable: boolean } | null>(null);
  const [storageEpoch, setStorageEpoch] = useState(0);
  // A 409 engine_changed says this mount's decision is no longer the server's. The refetched one
  // stands in for the prop only while the parent keeps handing back the decision the server has
  // already refused; a parent that refetches for itself always wins.
  const [refetched, setRefetched] = useState<{ replaced: string; engine: FrameEngine } | null>(null);
  const decided = engine ? `${engine.id};${engine.revision}` : "";
  // Read when a refusal arrives, not when the frame was built: the parent may have refetched for
  // itself since, and an override belongs to the decision it actually replaced.
  const decidedRef = useRef(decided);
  useEffect(() => { decidedRef.current = decided; }, [decided]);
  const current = refetched?.replaced === decided ? refetched.engine : engine;
  const engineId = current?.id ?? "";
  const engineRevision = current?.revision ?? "";
  const frameKey = `${slug}/${version}/${clientIdentity(client)}/${storageEpoch}/${engineId}/${engineRevision}`;
  // The frame navigated itself (b3/b1: a sandboxed frame may replace its own document). Nothing
  // here can prevent that, so it is detected after the fact and the frame is taken away.
  const [tripped, setTripped] = useState("");
  const navigated = tripped === frameKey;
  const loads = useRef({ key: "", count: 0 });
  const port = useRef<MessagePort | null>(null);
  const booting = useRef(0);
  useEffect(() => {
    let channel: MessageChannel | undefined;
    let active = true;
    let initializing = false;
    let expired = false;
    let inFlight = 0;
    let remounting = false;
    const storage = native ? nativeAppStorage(slug) : undefined;
    const controller = new AbortController();
    // What this mount claims on every action. A revision this frame was not given by a runtime GET
    // (AokieWorkspace pins an id, not a decision) claims nothing, so it sends nothing — and an
    // absent header is not a mismatch to the server, which is how older pages keep working.
    const clientEngine = engineId && engineRevision ? `${engineId};${engineRevision}` : undefined;
    /** Only the typed code remounts: a bare 409 is an ordinary failure the app must hear. */
    const engineChanged = (result: { status?: number; code?: string }) =>
      result.status === 409 && result.code === "engine_changed";
    // The server decided differently while this page was open (a revocation, a policy edit). Take
    // its new decision and rebuild the frame on it, rather than telling the person about an
    // engine. One refetch at a time: four actions can be in flight and all of them can be refused.
    async function remountOnNewEngine() {
      if (remounting) return;
      remounting = true;
      const result = native ? await api.getNativeRuntime(slug) : await api.getHostedRuntime(slug);
      if (!active) return;
      const next = result.data?.engine;
      if (!next || (next.id === engineId && next.revision === engineRevision)) {
        // Remounting onto the same refused decision would only be refused again.
        setError("This app is now set to run on a different engine. Please reload to continue.");
        return;
      }
      setRefetched({ replaced: decidedRef.current, engine: next });
    }
    const timeout = window.setTimeout(
      () => {
        expired = true;
        setError(
          "The app runtime did not load in time. Please reload to try again.",
        );
      },
      90000,
    );
    booting.current = timeout;
    async function receive(event: MessageEvent) {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "formlogic:ready" ||
        channel || initializing || expired
      )
        return;
      if (native && event.data.nativeProtocol !== NATIVE_PROTOCOL) {
        clearTimeout(timeout);
        setError("This hosted runtime does not support native apps yet. Update the hosted app runtime and reload.");
        return;
      }
      // The shell answered: now the engine is decided, from what it serves and what this page holds.
      // `null` means the document that was mounted cannot serve what was asked for — the host
      // document, whose shell did not announce host-js — and there is nothing to fall back to on it.
      const chosen = chooseFrameEngine(engineId ? { id: engineId } : undefined, event.data.engines, engineIdentity);
      if (chosen === null || !sameIdentity(announcedIdentity(event.data, chosen), engineIdentity(chosen))) {
        clearTimeout(timeout);
        setError("This app runtime is out of date. Please update the hosted app runtime and reload.");
        return;
      }
      initializing = true;
      // Host JavaScript is the runtime document's own engine: nothing is fetched, nothing is
      // hashed and no bytes are put in `init`. The frame never asks for bytes it would then have
      // to decide what to do with.
      let zippWasm: ArrayBuffer | undefined;
      if (engineNeedsBytes(chosen)) {
        try {
          zippWasm = await getEngineBytes(chosen);
        } catch (reason) {
          clearTimeout(timeout);
          if (active) setError(reason instanceof Error ? reason.message : "The app engine could not be loaded.");
          initializing = false;
          return;
        }
      }
      if (!active || expired) return;
      let savedStorage: Record<string, string> | undefined;
      try { savedStorage = storage?.read(); } catch (reason) {
        clearTimeout(timeout);
        initializing = false;
        const failure = reason instanceof NativeStorageError ? reason : null;
        const exportable = (() => { try { return failure?.code !== "unavailable" && !!storage?.exportRaw(); } catch { return false; } })();
        setStorageIssue({ message: failure?.message ?? "This app’s saved browser session could not be read.", exportable });
        setError(failure?.code === "unavailable" ? "Browser storage is not available, so this app cannot keep a session here. Check browser privacy settings and reload." : "This app’s saved browser session could not be read, so the app was not started.");
        return;
      }
      setStorageIssue(null);
      setError("");
      channel = new MessageChannel();
      channel.port1.onmessage = async (event) => {
        if (event.data?.type === "error") {
          setError(
            "The app could not load. Check its interface and logic files.",
          );
          return;
        }
        const { id, action, input } = event.data ?? {};
        if (
          event.data?.type !== "call" ||
          !Number.isSafeInteger(id) ||
          typeof action !== "string" ||
          !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(action)
        )
          return;
        const reply = (result: unknown) => {
          if (active) channel?.port1.postMessage({ id, result });
        };
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          JSON.stringify(input).length > 32768
        ) {
          reply({ error: "Invalid action input." });
          return;
        }
        if (inFlight >= 4) {
          reply({ error: "Please wait for the current request." });
          return;
        }
        inFlight++;
        try {
          if (storage && action === "nativeStorage") {
            reply({ result: storage.mutate(input) });
            return;
          }
          if (native && action === "nativeRequest") {
            if (typeof input.url !== "string" || !input.options || typeof input.options !== "object" || Array.isArray(input.options)) throw new Error("Invalid app request");
            const url = new URL(input.url, window.location.origin);
            if (url.origin !== window.location.origin && !native.origins?.includes(url.origin)) throw new Error("This URL is not part of the app backend");
            const options = input.options as Record<string, unknown>;
            const result = await api.runNativeRequest(slug, { path: url.pathname, query: Object.fromEntries(url.searchParams), method: options.method || "GET", headers: options.headers || {}, body: options.body || {} }, controller.signal, clientEngine);
            if (engineChanged(result)) void remountOnNewEngine();
            reply(result.error ? { error: result.error } : result.data);
            return;
          }
          if (["workspaceInfo", "workspaceRecords", "workspaceOpen", "workspaceDashboard"].includes(action)) {
            reply({ result: await workspaceBridge(slug, action, input, navigate) });
            return;
          }
          const result = await api.runHostedAction(
            slug,
            action,
            input,
            controller.signal,
            clientEngine,
          );
          if (engineChanged(result)) void remountOnNewEngine();
          reply(result.error ? { error: result.error } : result.data);
        } catch (reason) {
          reply({ error: reason instanceof Error ? reason.message : "The request could not be completed." });
        } finally {
          inFlight--;
        }
      };
      frame.current?.contentWindow?.postMessage(
        {
          type: "formlogic:init",
          client,
          appId: native ? `native-${slug}` : `hosted-${slug}-${version}`,
          native: !!native,
          assets: native?.assets,
          storage: savedStorage,
          dark: document.documentElement.classList.contains("dark"),
          // The id alone: the shell serves engines by name and refuses one it does not, so an
          // object here would arrive as "[object Object]" and be refused. A shell from before the
          // handshake ignores the key and runs what it always ran.
          engine: chosen,
          // Clone the public bytes; never transfer/detach the page's cache. The key is ABSENT,
          // not undefined, for an engine that needs none: a structured clone carries an explicit
          // undefined across, and the host document must not be sent an engine field at all.
          ...(zippWasm ? { zippWasm } : {}),
        },
        "*",
        [channel.port2],
      );
      port.current = channel.port1;
      clearTimeout(timeout);
    }
    window.addEventListener("message", receive);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      port.current = null;
      channel?.port1.close();
    };
  }, [slug, client, version, native, storageEpoch, engineId, engineRevision]);
  // Every engine: the first load is the frame starting, a second is the document being replaced
  // under it. Counted per frame, so a remount (new source, reset data, a new engine) starts over.
  const countLoad = () => {
    if (loads.current.key !== frameKey) loads.current = { key: frameKey, count: 0 };
    if (++loads.current.count < 2) return;
    port.current?.close();
    port.current = null;
    // The frame is gone: a boot that never finished is not news on top of that.
    clearTimeout(booting.current);
    setTripped(frameKey);
  };
  const exportSavedData = () => {
    const raw = (() => { try { return nativeAppStorage(slug).exportRaw(); } catch { return null; } })();
    if (raw === null) return;
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug}-browser-data.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const resetSavedData = () => {
    if (!window.confirm("Reset this app’s saved browser data on this device? Export it first if you may need it.")) return;
    try { nativeAppStorage(slug).reset(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Browser storage is not available."); return; }
    setStorageIssue(null);
    setError("");
    setStorageEpoch((epoch) => epoch + 1);
  };
  return (
    <div className="flex h-full min-h-[420px] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950">
      {error && (
        <div
          role="alert"
          className="bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>{error}</p>
          {storageIssue && (
            <div className="mt-3 space-y-2">
              <p>{storageIssue.message}</p>
              <div className="flex flex-wrap gap-2">
                {storageIssue.exportable && (
                  <button type="button" className="min-h-11 rounded-lg border border-amber-300 px-3 font-medium dark:border-amber-700" onClick={exportSavedData}>
                    Export saved data
                  </button>
                )}
                <button type="button" className="min-h-11 rounded-lg border border-amber-300 px-3 font-medium dark:border-amber-700" onClick={resetSavedData}>
                  Reset saved data
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {navigated ? (
        <div role="alert" className="bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p>This app tried to navigate away and was stopped</p>
        </div>
      ) : (
        <iframe
          key={frameKey}
          ref={frame}
          title="Hosted app"
          // The document the SERVER's decision needs, chosen before the frame loads because it is
          // the document that decides the shell's policy. `frameKey` carries the engine id, so a
          // decision that changes builds a new frame on the right document rather than reusing one.
          src={frameSource(engineId)}
          // The containment, for EVERY engine and unchanged by any of them. Scripts and nothing
          // else: the frame keeps an opaque origin, so it has none of this origin's cookies,
          // storage or DOM, and no popups, top-level navigation, forms or downloads. Host
          // JavaScript relaxes the shell's own policy by one token; it does not touch this.
          // check-security-invariants.mjs pins this literal, and the token it must never contain.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="min-h-[420px] w-full flex-1 border-0"
          onLoad={countLoad}
        />
      )}
    </div>
  );
}
