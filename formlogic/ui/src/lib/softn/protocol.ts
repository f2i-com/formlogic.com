/**
 * The protocol versions FormLogic shares with the Softn runtime and editors,
 * in one place. `protocol.json` is the source of truth: this module types it
 * for the UI, `scripts/softn-protocol.mjs` reads it for the build scripts, and
 * `NativeAppService` keeps the same numbers on the PHP side (its test pins them
 * to this file). Softn declares its own in `apps/softn-host-php/runtime/host-protocol.json`
 * and in the `formlogic:ready` / `formlogic-editor-ready` messages; the
 * ecosystem manifest check fails when the two repositories disagree.
 *
 * - nativeProtocol: the hosted-frame handshake (`formlogic:ready`) and the PHP
 *   native runtime (host-protocol.json).
 * - recordEvents: the native runtime's record automation protocol.
 * - editorBridge: the Builder/Studio iframe bridge (`formlogic-editor-ready`).
 * - hostedEngines: how many hosted-runtime entry documents beyond `index.html` the runtime
 *   carries. At 1 that is `host.html`, which serves the `host-js` engine under a policy
 *   `index.html` must never have; HostedAppFrame mounts it by name.
 * - logicLanguages: the runtime treats a client logic file whose name ends `.py` as Python, and
 *   refuses an engine that cannot run it rather than handing it over. FormLogic derives the same
 *   languages from the same client file names (backend RuntimeEngineService::languagesOf) and
 *   clamps such an app onto `zipp-web-python`, so both sides must speak this before either acts.
 */
import protocol from './protocol.json';

export const NATIVE_PROTOCOL: number = protocol.nativeProtocol;
export const RECORD_EVENTS_PROTOCOL: number = protocol.recordEvents;
export const EDITOR_BRIDGE_PROTOCOL: number = protocol.editorBridge;
