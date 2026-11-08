// The engine capability of the editor bridge, beside editorAgent.ts's agent runs.
import { ZIPP_RUNTIME_IDENTITY } from '../../lib/formlogic/zipp-bytes';
/**
 * The engine capability of the editor bridge (Softn v0.0.35 on): an editor that names the ZIPP
 * build this page runs (`engine: 1`, `zipp: {version, sha256}` in formlogic-editor-ready) is sent
 * this page's copy as `zippWasm` in formlogic-editor-connect, downloaded and checked once for the
 * whole site (getZippWasmBytes, the bytes the app frame is sent too), and carries none of its own.
 */
export const EDITOR_ENGINE_VERSION = 1;

/** Whether a ready message comes from an editor that takes this page's engine. */
export function editorTakesEngine(data: { engine?: unknown; zipp?: { version?: unknown; sha256?: unknown } } | null | undefined): boolean {
  return data?.engine === EDITOR_ENGINE_VERSION && data.zipp?.version === ZIPP_RUNTIME_IDENTITY.version && data.zipp?.sha256 === ZIPP_RUNTIME_IDENTITY.sha256;
}
