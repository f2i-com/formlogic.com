// The engine capability of the editor bridge, beside editorAgent.ts's agent runs.
import { ZIPP_RUNTIME_IDENTITY } from '../../lib/formlogic/zipp-bytes';
/**
 * The engine capability of the editor bridge (Softn v0.0.35 on): an editor that names the ZIPP
 * build this page runs (`engine: 1`, `zipp: {version, sha256}` in formlogic-editor-ready) is sent
 * this page's copy as `zippWasm` in formlogic-editor-connect, downloaded and checked once for the
 * whole site (getZippWasmBytes, the bytes the app frame is sent too), and carries none of its own.
 */
export const EDITOR_ENGINE_VERSION = 1;

/**
 * The bridge's `glue` capability (Softn v0.0.36 on): an editor that takes the engine and says
 * `glue: 1` runs the site's own ZIPP, so it is sent this page's engine with the glue of the same
 * ZIPP (`zippGlue`, in the site's ZIPP folder), whichever ZIPP it was built with.
 */
export const EDITOR_GLUE_VERSION = 1;

type EditorReady = { engine?: unknown; glue?: unknown; zipp?: { version?: unknown; sha256?: unknown } } | null | undefined;

/** Whether a ready message names this page's ZIPP as the one the editor was built with. */
function builtWithThisZipp(data: EditorReady): boolean {
  return data?.zipp?.version === ZIPP_RUNTIME_IDENTITY.version && data.zipp?.sha256 === ZIPP_RUNTIME_IDENTITY.sha256;
}

/**
 * Whether an editor needs the site's own ZIPP named to it: one built with another ZIPP that runs
 * the site's (`glue: 1`). An editor built with this page's ZIPP runs these bytes on its own glue,
 * so a site whose server does not answer the ZIPP folder yet keeps working while the two agree.
 */
export function editorTakesSiteZipp(data: EditorReady): boolean {
  return data?.engine === EDITOR_ENGINE_VERSION && data.glue === EDITOR_GLUE_VERSION && !builtWithThisZipp(data);
}

/** Whether a ready message comes from an editor that takes this page's engine: one built with it, or one that runs the site's ZIPP. */
export function editorTakesEngine(data: EditorReady): boolean {
  return data?.engine === EDITOR_ENGINE_VERSION && (builtWithThisZipp(data) || data.glue === EDITOR_GLUE_VERSION);
}
