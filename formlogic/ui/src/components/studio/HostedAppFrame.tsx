import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { workspaceBridge } from "../../lib/softn/workspaceBridge";
import { NATIVE_PROTOCOL } from "../../lib/softn/protocol";
import { getZippWasmBytes, matchesZippRuntime } from "../../lib/formlogic/zipp-bytes";

import { nativeAppStorage, NativeStorageError } from "../../lib/nativeAppStorage";

const navigate = (path: string) => window.location.assign(path);
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
}: {
  slug: string;
  client: Record<string, string>;
  version: number;
  native?: { assets: Record<string, string>; origins?: string[] };
  /**
   * The engine the SERVER decided this app runs on, from the runtime GET, with the revision the
   * action-time X-FormLogic-Client-Engine check compares against. Threaded in now so the callers
   * already carry it; this frame still runs every id on the ZIPP web-python path, because that is
   * the only engine the installed runtime serves. The seam that acts on it is E1-FL.
   */
  engine?: { id: string; revision: string };
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  const [error, setError] = useState("");
  // Audit FL-S07: damaged saved browser data stops the app before it starts,
  // with the owner's choices in front of them, rather than being filtered
  // into something that looks healthy. Reset boots a fresh frame.
  const [storageIssue, setStorageIssue] = useState<{ message: string; exportable: boolean } | null>(null);
  const [storageEpoch, setStorageEpoch] = useState(0);
  useEffect(() => {
    let channel: MessageChannel | undefined;
    let active = true;
    let initializing = false;
    let expired = false;
    let inFlight = 0;
    const storage = native ? nativeAppStorage(slug) : undefined;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => {
        expired = true;
        setError(
          "The app runtime did not load in time. Please reload to try again.",
        );
      },
      90000,
    );
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
      if (!matchesZippRuntime(event.data.zipp)) {
        clearTimeout(timeout);
        setError("This app runtime is out of date. Please update the hosted app runtime and reload.");
        return;
      }
      initializing = true;
      let zippWasm: ArrayBuffer;
      try {
        zippWasm = await getZippWasmBytes();
      } catch (reason) {
        clearTimeout(timeout);
        if (active) setError(reason instanceof Error ? reason.message : "The app engine could not be loaded.");
        initializing = false;
        return;
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
            const result = await api.runNativeRequest(slug, { path: url.pathname, query: Object.fromEntries(url.searchParams), method: options.method || "GET", headers: options.headers || {}, body: options.body || {} }, controller.signal);
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
          );
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
          // Clone the public bytes; never transfer/detach the page's cache.
          zippWasm,
        },
        "*",
        [channel.port2],
      );
      clearTimeout(timeout);
    }
    window.addEventListener("message", receive);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      channel?.port1.close();
    };
  }, [slug, client, version, native, storageEpoch]);
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
      <iframe
        key={`${slug}/${version}/${clientIdentity(client)}/${storageEpoch}`}
        ref={frame}
        title="Hosted app"
        src="/hosted-runtime/index.html"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-[420px] w-full flex-1 border-0"
      />
    </div>
  );
}
