import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppSplash } from "./AppSplash";
import { readLook, type NativeLook } from "../../lib/appLook";
import { api } from "../../lib/api";
import { workspaceBridge } from "../../lib/softn/workspaceBridge";
import { NATIVE_PROTOCOL } from "../../lib/softn/protocol";
import { engineIdentity, engineNeedsBytes, getEngineBytes, hostZippFiles } from "../../lib/formlogic/zipp-bytes";
import { announcedIdentity, chooseFrameEngine, frameSource, sameIdentity } from "../../lib/formlogic/frameEngine";

import { nativeAppStorage, nativeFrameAppId, NativeStorageError, isNativeStorageScope, onNativeStorageChange, SMALL_STORAGE_LIMITS, type NativeStorageLimits, type NativeStorageScope } from "../../lib/nativeAppStorage";
import { toast } from "../../stores/toastStore";
import { currentSessionGeneration, currentSessionOwner, isSessionGenerationCurrent, subscribeSessionGeneration } from "../../lib/sessionGeneration";
import { copyHostedActor, HOSTED_ACTOR_ERROR, isHostedAdmissionCurrent, sameHostedActor, type HostedAdmission } from '../../lib/hostedActor';

const navigate = (path: string) => window.location.assign(path);
/** The largest request a page sends its app's backend: a photo upload (SoftN takes 5.6 MB) and its envelope. */
const NATIVE_REQUEST_INPUT = 6 * 1024 * 1024;

/** The server's decision for one mount: the engine to run, and the revision actions send back. */
type FrameEngine = { id: string; revision: string };
/** `files`: the app may open the files the person picks and save files they ask for, as its owner chose and, where asked, the person agreed (NativeAppView). Settled before the frame opens. */
type NativeFrame = { assets: Record<string, string>; origins?: string[]; access: 'application' | 'members'; storageScope: NativeStorageScope; files?: boolean; look?: NativeLook | null };
const scopeAllowed = (native: NativeFrame) => isNativeStorageScope(native.storageScope) &&
  native.access === native.storageScope.access &&
  (native.storageScope.access === 'application' || native.storageScope.userId === currentSessionOwner());
// The frame bootstraps once. Its DOM lifetime must match the effect's client
// identity, including replacing source without changing a deployment version.
const clientIdentities = new WeakMap<object, number>();
let nextClientIdentity = 0;
function clientIdentity(client: object): number {
  let identity = clientIdentities.get(client);
  if (identity === undefined) {
    identity = ++nextClientIdentity;
    clientIdentities.set(client, identity);
  }
  return identity;
}

/** A map's stored bytes for an export, or null when there are none or they cannot be read. */
async function readRaw(storage: { exportRaw: () => Promise<string | null> } | undefined): Promise<string | null> {
  try { return (await storage?.exportRaw()) ?? null; } catch { return null; }
}

export function HostedAppFrame({
  slug,
  client,
  version,
  native,
  engine,
  hostedAdmission,
  workspaceOnly = false,
  bare = false,
  domain = false,
  plugin,
}: {
  /** The app IS the page: no card around it, and no minimum height to overflow a short screen. */
  bare?: boolean;
  /**
   * The page is the app's own domain (NativeAppView's `onDomain`): its storage takes the saves the
   * site's earlier SoftN page left, the first time it opens in a browser (nativeAppStorage).
   */
  domain?: boolean;
  slug: string;
  client: Record<string, string>;
  version: number;
  native?: NativeFrame;
  hostedAdmission?: HostedAdmission;
  /** Only trusted built-in clients may use the workspace bridge without hosted actions. */
  workspaceOnly?: boolean;
  /**
   * A plugin's own page (PluginVerifyPage): the things it may ask of this page, and nothing
   * else. `pluginContext` answers with what the server said the page is for; `pluginDone` hands
   * back to the host, which decides where to go from the server's answer, never the frame's;
   * `pluginCamera`, only for a plugin granted the camera, opens the site's camera check in this page.
   */
  plugin?: { context: Record<string, unknown>; onDone: () => void; onCamera?: () => void };
  /**
   * The engine the SERVER decided this app runs on, from the runtime GET, with the revision every
   * action sends back in X-FormLogic-Client-Engine. Absent (a server from before the decision, or
   * a mount with no runtime GET) means the engine every hosted app has always run, claimed to
   * nobody: no revision, so no header.
   */
  engine?: FrameEngine;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const hosted = useMemo(() => {
    const actor = copyHostedActor(hostedAdmission?.actor);
    return actor && hostedAdmission ? Object.freeze({ actor, slug: hostedAdmission.slug, generation: hostedAdmission.generation }) : null;
  }, [hostedAdmission]);
  const hostedAdmissionId = hostedAdmission ? clientIdentity(hostedAdmission) : 0;
  // Props identify an admitted server GET. A later session may not reuse that admission,
  // even if it belongs to the same user; NativeAppPage must fetch a fresh project first.
  const sourceKey = JSON.stringify([slug, version, clientIdentity(client), native ? clientIdentity(native) : 0,
    native?.access, native?.storageScope?.access, native?.storageScope?.appId,
    native?.storageScope?.access === 'members' ? native.storageScope.userId : null, native?.files === true, engine?.id, engine?.revision, hosted, hostedAdmissionId, workspaceOnly, plugin ? clientIdentity(plugin) : 0]);
  const [admitted, setAdmitted] = useState(() => ({ key: sourceKey, generation }));
  if (admitted.key !== sourceKey) setAdmitted({ key: sourceKey, generation });
  const admission = native || workspaceOnly ? (admitted.key === sourceKey ? admitted.generation : generation) : (hosted?.generation ?? -1);

  const [error, setError] = useState("");
  // The frame whose app has drawn its first page (SoftN's `shown`): until then a native app's frame
  // is covered by the same splash the page showed while it downloaded, so one wheel turns throughout.
  const [shownKey, setShownKey] = useState<string | null>(null);
  // Audit FL-S07: damaged saved browser data stops the app before it starts,
  // with the owner's choices in front of them, rather than being filtered
  // into something that looks healthy. Reset boots a fresh frame.
  const [storageIssue, setStorageIssue] = useState<{ key: string; message: string; exportable: boolean } | null>(null);
  const [storageEpoch, setStorageEpoch] = useState(0);
  // A 409 engine_changed says this mount's decision is no longer the server's. The refetched one
  // stands in for the props only while the parent keeps handing back the decision the server has
  // already refused; a parent that refetches for itself always wins. It carries the whole mount
  // the runtime GET answered with — client, version, native assets — not only the engine: the
  // decision changed because the OWNER changed something, often the bundle itself (a `.py` gone),
  // and a new engine handed the old client is refused by the shell by name.
  const [refetched, setRefetched] = useState<{
    replaced: string;
    engine: FrameEngine;
    client?: Record<string, string>;
    version?: number;
    native?: NativeFrame;
  } | null>(null);
  // An override belongs to this complete admitted mount, not merely its engine string.
  const decided = `${sourceKey}/${admission}`;
  const override = refetched?.replaced === decided ? refetched : null;
  const current = override ? override.engine : engine;
  const mountClient = override?.client ?? client;
  const mountVersion = override?.version ?? version;
  const mountNative = native ? (override?.native ?? native) : undefined;
  const blocked = generation !== admission || (!!mountNative && !scopeAllowed(mountNative)) ||
    (!mountNative && !workspaceOnly && !isHostedAdmissionCurrent(hosted, slug));
  const engineId = current?.id ?? "";
  const engineRevision = current?.revision ?? "";
  const frameKey = `${decided}/${mountVersion}/${clientIdentity(mountClient)}/${mountNative ? clientIdentity(mountNative) : 0}/${storageEpoch}/${engineId}/${engineRevision}`;
  // Source/engine props cannot revive rejected authority. Only a fresh server
  // admission object can release this quarantine, even for the same actor.
  const [quarantined, setQuarantined] = useState(-1);
  const actorRefused = quarantined === hostedAdmissionId;
  // The frame navigated itself (b3/b1: a sandboxed frame may replace its own document). Nothing
  // here can prevent that, so it is detected after the fact and the frame is taken away.
  const [tripped, setTripped] = useState("");
  const navigated = tripped === frameKey;
  const loads = useRef({ key: "", count: 0 });
  const port = useRef<MessagePort | null>(null);
  const invalidateMount = useRef<(() => void) | null>(null);
  const recovery = useRef<{
    key: string; storage: ReturnType<typeof nativeAppStorage>; isCurrent: () => boolean;
    retireGuest: () => void; invalidate: () => void;
  } | null>(null);
  const booting = useRef(0);
  // Read as a mount opens, not a reason to remount: it decides only what the opening read may take.
  // As a dependency it re-ran the mount on the same document when it changed, which disposed the
  // frame and then waited for a `ready` the frame sends once, so the app never opened.
  const domainRef = useRef(domain);
  useLayoutEffect(() => { domainRef.current = domain; }, [domain]);
  // Layout cleanup fences the previous document synchronously at a source/app/
  // engine replacement, before an old port callback can mutate parent storage.
  useLayoutEffect(() => {
    // In particular, do not even create a storage helper for an older server response.
    if (blocked || actorRefused) return;
    let channel: MessageChannel | undefined;
    let active = true;
    let mountValid = true;
    let recoveryValid = true;
    let channelClosed = false;
    const sessionGeneration = admission;
    const sameSession = () => active && isSessionGenerationCurrent(sessionGeneration) && (!mountNative || scopeAllowed(mountNative)) &&
      (!!mountNative || workspaceOnly || isHostedAdmissionCurrent(hosted, slug));
    const isCurrentMount = () => sameSession() && mountValid;
    let initializing = false;
    let expired = false;
    let inFlight = 0;
    let remounting = false;
    const storage = mountNative ? nativeAppStorage(slug, mountNative.storageScope, { domain: domainRef.current }) : undefined;
    if (storage) recovery.current = {
      key: frameKey, storage, isCurrent: () => sameSession() && recoveryValid,
      retireGuest, invalidate,
    };
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
      if (remounting || !isCurrentMount()) return;
      remounting = true;
      invalidate();
      let result;
      try { result = mountNative ? await api.getNativeRuntime(slug) : await api.getHostedRuntime(slug); }
      catch { if (sameSession()) setError("This app could not be reopened. Please reload to continue."); return; }
      if (!sameSession()) return;
      const data = result.data;
      // A new engine cannot re-admit a different actor or revive the rejected action.
      if (!mountNative && (!hosted || !sameHostedActor(hosted.actor, result.error ? result.actor : data && 'actor' in data ? data.actor : undefined))) {
        quarantine(); return;
      }
      if (result.error) { setError(result.error); return; }
      const nextNative = data && "project" in data && data.project ? {
        assets: data.project.assets, origins: data.project.origins, access: data.project.access, storageScope: data.project.storageScope,
        // The owner's choice as it is now: Off takes files away, Allowed without asking gives them. Where
        // the owner asks, the person's answer stands across a new engine: they were asked about the app.
        files: data.project.files === 'allow' || (data.project.files === 'ask' && !!mountNative?.files),
        look: ("look" in data ? readLook(data.look) : null) ?? mountNative?.look,
      } : undefined;
      if (mountNative && (!nextNative || !scopeAllowed(nextNative))) {
        setError("This app could not verify its browser storage access. Please reload or sign in again.");
        return;
      }
      const next = data?.engine;
      if (!next || (next.id === engineId && next.revision === engineRevision)) {
        // Remounting onto the same refused decision would only be refused again.
        setError("This app is now set to run on a different engine. Please reload to continue.");
        return;
      }
      // The bundle that answer was decided FOR, so the new engine is handed the client it can run.
      // An answer that lacks it keeps this mount's props.
      const bundle = data && "project" in data ? data.project : data && "deployment" in data ? data.deployment : undefined;
      setRefetched({
        replaced: decided,
        engine: next,
        client: bundle?.client,
        version: bundle?.version,
        native: nextNative,
      });
    }
    const timeout = window.setTimeout(
      () => {
        if (!isCurrentMount()) return;
        expired = true;
        invalidate();
        setError(
          "The app runtime did not load in time. Please reload to try again.",
        );
      },
      90000,
    );
    booting.current = timeout;
    function invalidate() {
      recoveryValid = false;
      retireGuest();
    }
    function quarantine() {
      invalidate();
      setQuarantined(hostedAdmissionId);
      setError(HOSTED_ACTOR_ERROR);
    }
    // A failed reset must leave the owner's recovery controls usable without
    // reviving the guest. Lifecycle invalidation still revokes both lifetimes.
    function retireGuest() {
      mountValid = false;
      controller.abort();
      clearTimeout(timeout);
      if (!channelClosed && channel) {
        channelClosed = true;
        // Closing a MessagePort does not reliably notify its peer. Explicitly
        // settle the shell's receipts/unsent queue before terminating this port.
        try { channel.port1.postMessage({ type: "formlogic:dispose" }); } catch { /* The peer may already be gone. */ }
        channel.port1.close();
      }
      if (port.current === channel?.port1) port.current = null;
    }
    invalidateMount.current = invalidate;
    // Another tab saved this app's data, so this frame's snapshot is old. It is reopened when
    // someone comes back to it, not on the spot: tabs that each save while opening would
    // otherwise reopen each other for ever. A save from an old snapshot is refused (stale).
    let snapshotOld = false;
    const noteOtherTab = (event: StorageEvent) => {
      if (storage && (event.key === storage.key || event.key === null)) snapshotOld = true;
    };
    // A map kept in IndexedDB is announced on a channel instead (nativeAppStorage), by the handle
    // that wrote it: this mount's own saves are not another tab's.
    const stopChanges = storage ? onNativeStorageChange((key, from) => { if (key === storage.key && from !== storage.id) snapshotOld = true; }) : () => {};
    const reopenIfOld = () => {
      if (!snapshotOld || document.hidden || !isCurrentMount()) return;
      snapshotOld = false;
      setStorageEpoch((epoch) => epoch + 1);
    };
    window.addEventListener("storage", noteOtherTab);
    window.addEventListener("focus", reopenIfOld);
    document.addEventListener("visibilitychange", reopenIfOld);
    // Close the old channel at the session boundary itself, before React cleanup.
    const unsubscribe = subscribeSessionGeneration(() => { if (!sameSession()) invalidate(); });
    async function receive(event: MessageEvent) {
      if (
        !isCurrentMount() ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "formlogic:ready" ||
        channel || initializing || expired
      )
        return;
      if (mountNative && event.data.nativeProtocol !== NATIVE_PROTOCOL) {
        clearTimeout(timeout);
        setError("This hosted runtime does not support native apps yet. Update the hosted app runtime and reload.");
        return;
      }
      // The shell answered: now the engine is decided, from what it serves and what this page holds.
      // `null` means the document that was mounted cannot serve what was asked for — the host
      // document, whose shell did not announce host-js — and there is nothing to fall back to on it.
      const runsSiteZipp = event.data.zippGlue === 1;
      const chosen = chooseFrameEngine(engineId ? { id: engineId } : undefined, event.data.engines, engineIdentity, runsSiteZipp);
      // A frame built with this page's ZIPP runs these bytes on the glue it carries, as it always did.
      // One built with another ZIPP that runs the site's own (SoftN v0.0.36 on, ready's `zippGlue: 1`)
      // is sent this site's glue and torch package from its ZIPP folder with the bytes, so it runs the
      // ZIPP this site has. Only then: a site whose server does not answer the ZIPP folder yet keeps
      // working for as long as its ZIPP is the runtime's. Any other frame is out of date.
      const sameZipp = chosen !== null && sameIdentity(announcedIdentity(event.data, chosen), engineIdentity(chosen));
      const siteZipp = chosen !== null && !sameZipp && runsSiteZipp && engineNeedsBytes(chosen);
      if (chosen === null || (!sameZipp && !siteZipp)) {
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
          if (isCurrentMount()) setError(reason instanceof Error ? reason.message : "The app engine could not be loaded.");
          initializing = false;
          return;
        }
      }
      if (!isCurrentMount() || expired) return;
      const acknowledgedStorage = !!storage && event.data.storageProtocol === 1;
      let savedStorage: Record<string, string> | undefined;
      // What the store this map is kept in holds (nativeAppStorage): IndexedDB's are the frame's to
      // be told, localStorage's are the ones it already keeps.
      let limits: NativeStorageLimits | undefined;
      try {
        if (storage) { savedStorage = await storage.read(); limits = await storage.storageLimits(); }
      } catch (reason) {
        if (!isCurrentMount() || expired) return;
        clearTimeout(timeout);
        initializing = false;
        const failure = reason instanceof NativeStorageError ? reason : null;
        const exportable = failure?.code !== "unavailable" && !!(await readRaw(storage));
        if (!isCurrentMount()) return;
        setStorageIssue({ key: frameKey, message: failure?.message ?? "This app's saved browser session could not be read.", exportable });
        setError(failure?.code === "unavailable" ? "Browser storage is not available, so this app cannot keep a session here. Check browser privacy settings and reload." : "This app’s saved browser session could not be read, so the app was not started.");
        return;
      }
      if (!isCurrentMount() || expired) return;
      const largeStorage = !!limits && limits.value > SMALL_STORAGE_LIMITS.value;
      setStorageIssue(null);
      setError("");
      channel = new MessageChannel();
      channel.port1.onmessage = async (event) => {
        if (!isCurrentMount()) {
          retireGuest();
          return;
        }
        if (event.data?.type === "shown") {
          setShownKey(frameKey);
          return;
        }
        if (event.data?.type === "error") {
          // An app that failed after its first page was drawn is still on screen and shows what
          // went wrong inside it (SoftN v0.0.28 says `phase`); a frame before that sends none,
          // and meant a load failure.
          if (event.data.phase !== "runtime") setError(
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
          if (isCurrentMount()) channel?.port1.postMessage({ id, result });
        };
        // A structured clone can carry what JSON cannot (a BigInt, an object that contains
        // itself): that input is refused like an oversized one rather than left unanswered.
        const measure = (value: object) => { try { return JSON.stringify(value).length; } catch { return Infinity; } };
        // A request to the app's own backend may carry a photo (SoftN's upload routes take 5.6 MB;
        // the server holds each route to its own limit), and a save may be as large as the store
        // keeps (a game's saved state). Every other call is held to the 32 KB it always was.
        const inputLimit = mountNative && action === "nativeRequest" ? NATIVE_REQUEST_INPUT
          : storage && action === "nativeStorage" && limits ? Math.max(32768, limits.input) : 32768;
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          measure(input) > inputLimit
        ) {
          reply({ error: "Invalid action input." });
          return;
        }
        // A save is answered at once from this page's storage, so it is not held to the four
        // backend calls: a screen busy with its own calls had its saves refused. The frame sends
        // saves in a lane of their own when told it may (`storageLane` below).
        // Only where this mount has storage: in a hosted app without it a call by that name is an
        // ordinary action, a request to the server, and is counted like the rest.
        const counted = !(storage && action === "nativeStorage");
        if (counted && inFlight >= 4) {
          reply({ error: "Please wait for the current request." });
          return;
        }
        if (counted) inFlight++;
        try {
          if (storage && action === "nativeStorage") {
            if (input.operation === "batch" && !acknowledgedStorage) throw new Error("This app runtime does not support acknowledged storage batches.");
            // The trusted auth generation and mount are checked BEFORE the
            // mutation, rather than only when replying to the app afterward.
            if (!isCurrentMount()) { retireGuest(); return; }
            reply({ result: await storage.mutate(input) });
            return;
          }
          if (mountNative && action === "nativeRequest") {
            if (typeof input.url !== "string" || !input.options || typeof input.options !== "object" || Array.isArray(input.options)) throw new Error("Invalid app request");
            const url = new URL(input.url, window.location.origin);
            if (url.origin !== window.location.origin && !mountNative.origins?.includes(url.origin)) throw new Error("This URL is not part of the app backend");
            const options = input.options as Record<string, unknown>;
            // Upper-cased as a browser's fetch sends it: `post` from a frame before SoftN v0.0.28 was refused.
            const result = await api.runNativeRequest(slug, { path: url.pathname, query: Object.fromEntries(url.searchParams), method: String(options.method || "GET").toUpperCase(), headers: options.headers || {}, body: options.body || {} }, controller.signal, clientEngine);
            if (isCurrentMount() && engineChanged(result)) void remountOnNewEngine();
            reply(result.error ? { error: result.error } : result.data);
            return;
          }
          if (mountNative && plugin && action === "pluginContext") {
            reply({ result: plugin.context });
            return;
          }
          if (mountNative && plugin && action === "pluginDone") {
            invalidate();
            plugin.onDone();
            return;
          }
          // The site's camera check, for a plugin granted the camera: this page opens it outside the
          // frame, which cannot have the camera. The frame learns only that it opened.
          if (mountNative && plugin?.onCamera && action === "pluginCamera") {
            plugin.onCamera();
            reply({ result: { opened: true } });
            return;
          }
          // Not for a plugin's page: a plugin is anyone's code, and workspaceOpen moves this page.
          if (!plugin && ["workspaceInfo", "workspaceRecords", "workspaceOpen", "workspaceDashboard"].includes(action)) {
            reply({ result: await workspaceBridge(slug, action, input, (path) => {
              if (!isCurrentMount()) return;
              invalidate();
              navigate(path);
            }, isCurrentMount) });
            return;
          }
          // The guest cannot supply or replace admission; built-in workspace and native
          // bridges have no implicit permission to call private hosted actions.
          if (workspaceOnly || !isHostedAdmissionCurrent(hosted, slug)) {
            reply({ error: HOSTED_ACTOR_ERROR }); return;
          }
          const result = await api.runHostedAction(
            slug,
            action,
            input,
            controller.signal,
            clientEngine,
            hosted.actor,
          );
          if (!isCurrentMount()) return;
          if (result.transportFailure) {
            reply({ error: 'The request could not be completed. Try again.' }); return;
          }
          if (!sameHostedActor(hosted.actor, result.error ? result.actor : result.data?.actor) ||
              ['actor_changed', 'actor_context_required', 'actor_context_unavailable'].includes(result.code || '')) {
            quarantine(); return;
          }
          if (isCurrentMount() && engineChanged(result)) void remountOnNewEngine();
          reply(result.error ? { error: result.error } : { result: result.data?.result });
        } catch (reason) {
          if (action === "nativeStorage" && reason instanceof NativeStorageError && reason.code === "stale" && isCurrentMount()) {
            toast.warning("This app changed in another tab", "It has reopened with the latest saved data. Your last change was not saved.");
            setStorageEpoch((epoch) => epoch + 1);
          }
          // Answered first: what follows reads the store, and the app's save must not wait on it.
          reply({ error: reason instanceof Error ? reason.message : "The request could not be completed." });
          if (action === "nativeStorage" && reason instanceof NativeStorageError && ["corrupt", "too-large", "unavailable"].includes(reason.code) && isCurrentMount()) {
            const exportable = reason.code !== "unavailable" && !!(await readRaw(storage));
            if (isCurrentMount()) {
              setStorageIssue({ key: frameKey, message: reason.message, exportable });
              setError("This app's browser data could not be saved. Export or reset it before continuing.");
            }
          }
        } finally {
          if (counted) inFlight--;
        }
      };
      frame.current?.contentWindow?.postMessage(
        {
          type: "formlogic:init",
          client: mountClient,
          appId: mountNative ? nativeFrameAppId(mountNative.storageScope?.appId ?? slug) : `hosted-${slug}-${mountVersion}`,
          native: !!mountNative,
          assets: mountNative?.assets,
          storage: savedStorage,
          ...(acknowledgedStorage ? { storageProtocol: 1 } : {}),
          // Saves are not counted against the four calls above, so the frame (SoftN v0.0.28 on)
          // may send them in a lane of their own; an older frame ignores the key.
          ...(storage ? { storageLane: true } : {}),
          // What the app may do beyond its own frame: files, where granted (a SoftN v0.0.33 frame reads it;
          // an older one grants nothing, as it always did).
          ...(mountNative?.files ? { permissions: { files: true } } : {}),
          // How much the map may hold where it is kept in IndexedDB: a frame from SoftN v0.0.33
          // raises its own limits to these, an older one keeps the small ones it always had,
          // which this side still takes.
          ...(largeStorage && limits ? { storageLimits: { value: limits.value, entries: limits.entries, map: limits.map, input: limits.input, queued: limits.queued } } : {}),
          dark: document.documentElement.classList.contains("dark"),
          // The id alone: the shell serves engines by name and refuses one it does not, so an
          // object here would arrive as "[object Object]" and be refused. A shell from before the
          // handshake ignores the key and runs what it always ran.
          engine: chosen,
          // Clone the public bytes; never transfer/detach the page's cache. The key is ABSENT,
          // not undefined, for an engine that needs none: a structured clone carries an explicit
          // undefined across, and the host document must not be sent an engine field at all.
          ...(zippWasm ? { zippWasm } : {}),
          // The glue and torch package of the ZIPP those bytes are, in this site's ZIPP folder, each
          // with the digest the frame checks before it imports or runs it.
          ...(siteZipp && zippWasm ? (({ glue, torch }) => ({ zippGlue: glue, ...(torch ? { zippTorch: torch } : {}) }))(hostZippFiles()) : {}),
        },
        "*",
        [channel.port2],
      );
      port.current = channel.port1;
      clearTimeout(timeout);
      // A frame before SoftN v0.0.34 never says `shown`: it is uncovered at once, as before. One that
      // does is uncovered by it, or after 45 seconds whatever happened, so nothing is hidden for good.
      if (event.data.shown !== 1) setShownKey(frameKey);
      else uncover = window.setTimeout(() => { if (isCurrentMount()) setShownKey(frameKey); }, 45_000);
    }
    let uncover: number | undefined;
    window.addEventListener("message", receive);
    return () => {
      active = false;
      window.clearTimeout(uncover);
      unsubscribe();
      invalidate();
      stopChanges();
      window.removeEventListener("storage", noteOtherTab);
      window.removeEventListener("focus", reopenIfOld);
      document.removeEventListener("visibilitychange", reopenIfOld);
      window.removeEventListener("message", receive);
      if (invalidateMount.current === invalidate) invalidateMount.current = null;
      if (recovery.current?.key === frameKey) recovery.current = null;
    };
  }, [slug, mountClient, mountVersion, mountNative, storageEpoch, engineId, engineRevision, admission, blocked, decided, frameKey, hosted, workspaceOnly, actorRefused, hostedAdmissionId, plugin]);
  // Every engine: the first load is the frame starting, a second is the document being replaced
  // under it. Counted per frame, so a remount (new source, reset data, a new engine) starts over.
  const countLoad = () => {
    if (blocked || !isSessionGenerationCurrent(admission)) return;
    if (loads.current.key !== frameKey) loads.current = { key: frameKey, count: 0 };
    if (++loads.current.count < 2) return;
    invalidateMount.current?.();
    // The frame is gone: a boot that never finished is not news on top of that.
    clearTimeout(booting.current);
    setTripped(frameKey);
  };
  const exportSavedData = async () => {
    const current = recovery.current;
    if (blocked || current?.key !== frameKey || !current.isCurrent()) return;
    const raw = await readRaw(current.storage);
    if (raw === null || !current.isCurrent()) return;
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug}-browser-data.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const resetSavedData = async () => {
    const current = recovery.current;
    if (blocked || current?.key !== frameKey || !current.isCurrent()) return;
    if (!window.confirm("Reset this app’s saved browser data on this device? Export it first if you may need it.")) return;
    if (!current.isCurrent()) return;
    current.retireGuest();
    try { await current.storage.reset(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Browser storage is not available."); return; }
    current.invalidate();
    setStorageIssue(null);
    setError("");
    setStorageEpoch((epoch) => epoch + 1);
  };
  return (
    <div className={`flex h-full min-w-0 flex-col overflow-hidden bg-white dark:bg-slate-950 ${bare ? "" : "min-h-[420px] rounded-2xl border border-slate-200 dark:border-slate-700"}`}>
      {!blocked && error && (
        <div
          role="alert"
          className="bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          <p>{error}</p>
          {storageIssue?.key === frameKey && (
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
      {blocked ? <p role="alert" className="p-4 text-sm">{mountNative ? "This app's browser storage access could not be verified. Please reload or sign in again." : HOSTED_ACTOR_ERROR}</p> : actorRefused ? null : navigated ? (
        <div role="alert" className="bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p>This app tried to navigate away and was stopped</p>
        </div>
      ) : (
        <div className={`relative flex min-h-0 w-full flex-1 flex-col ${bare ? "" : "min-h-[420px]"}`}>
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
          // A file the app saves is a download, which the sandbox blocks unless it allows them: only for
          // an app granted files, and that frame keeps everything else above.
          sandbox={mountNative?.files ? "allow-scripts allow-downloads" : "allow-scripts"}
          referrerPolicy="no-referrer"
          className={`w-full flex-1 border-0 ${bare ? "" : "min-h-[420px]"}`}
          onLoad={countLoad}
        />
        {mountNative && !error && shownKey !== frameKey && <AppSplash look={mountNative.look} className="absolute inset-0" />}
        </div>
      )}
    </div>
  );
}
