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
 */
import protocol from './protocol.json';

export const NATIVE_PROTOCOL: number = protocol.nativeProtocol;
export const RECORD_EVENTS_PROTOCOL: number = protocol.recordEvents;
export const EDITOR_BRIDGE_PROTOCOL: number = protocol.editorBridge;
