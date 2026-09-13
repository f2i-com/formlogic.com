import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { workspaceBridge } from "../../lib/softn/workspaceBridge";
import { getZippWasmBytes, matchesZippRuntime } from "../../lib/formlogic/zipp-bytes";

import { nativeAppStorage } from "../../lib/nativeAppStorage";

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
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  const [error, setError] = useState("");
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
      if (native && event.data.nativeProtocol !== 1) {
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
      try { savedStorage = storage?.read(); } catch {
        clearTimeout(timeout);
        setError("This app’s saved browser session could not be read. Check browser storage and reload.");
        return;
      }
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
  }, [slug, client, version, native]);
  return (
    <div className="flex h-full min-h-[420px] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950">
      {error && (
        <p
          role="alert"
          className="bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {error}
        </p>
      )}
      <iframe
        key={`${slug}/${version}/${clientIdentity(client)}`}
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
