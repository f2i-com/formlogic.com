// Pack-owned Live Call section screen (plan §8.4 port #6 — self-contained apps).
//
// TSX edition: the operator's front-desk console is REAL SOURCE FILES under
// ./aokie-screens/live-call/ (index.tsx + controller.ts + phone.ts + components/* +
// styles.css), imported here as strings (?raw) and shipped in customScreen.files. The
// sandbox runtime bundles them on render (esbuild-wasm + embedded Preact —
// screenCompile.ts); the sources are type-checked by the repo's tsc and behavioral
// tests execute the compiled artifact (aokieLiveCallScreenTsx.test.ts). The compiled
// registry screen `aokie-live-call` + its registry entry stay untouched for rollback
// (flip the Calls form's SECTION customScreen back to the sdk reference; the
// recordScreen transcript is a separate blob and is unaffected).
//
// Runtime contract (CustomScreenRuntime in the APP runtime): opaque-origin iframe;
// window.FormLogic is the only capability. The screen drives the FULL bridge + the
// subscription lanes:
//  - connector('aokie', cmd) — call.current + answer/reject/hangup/operatorSpeak
//    (routing is transparent: local desktop bridge, or the owner's relay when the
//    receptionist runs on another machine; command failures RESOLVE, and 'uncertain'
//    is surfaced honestly);
//  - events.subscribe({connectorId:'aokie'}) — live call lifecycle + final transcript
//    turns (LOCAL bridge; attaches on a presence transition to 'local', detaches when
//    it goes away; demo/remote just poll instead);
//  - captions.subscribe(handler) — the volatile caller-partial + session phase (LOCAL
//    only; tombstoned when a durable caller turn lands, final wins);
//  - records({limit}) — the recent-calls list (the attached Calls form);
//  - queryRecords('transcript-turns' | 'customers') — the stored transcript in
//    remote/demo mode + the known-caller name lookup;
//  - presence() — local / remote / none, re-polled every tick (self-heals);
//  - can('connector.aokie.<cmd>') — greys out controls the app can't run;
//  - host.ceremony('simulate-call') — the scripted demo call, and host.openRecord for
//    the recent-call rows.
//
// LOAD-BEARING (commit 5c0615b): the standby panel branches by presence — 'remote'
// shows a mirror note ONLY and never offers the demo Simulate button; 'none'/demo
// offers the demo call; 'local' shows no panel. Test-locked in
// aokieLiveCallScreenTsx.test.ts.
//
// Every bridge action is TRUSTED_ONLY: the Calls form's custom_screen_trust must be
// owner/verified.

import liveCallIndexTsx from './live-call/index.tsx?raw';
import liveCallControllerTs from './live-call/controller.ts?raw';
import liveCallPhoneTs from './live-call/phone.ts?raw';
import liveCallStageTsx from './live-call/components/CallStage.tsx?raw';
import liveCallTranscriptTsx from './live-call/components/Transcript.tsx?raw';
import liveCallRecentTsx from './live-call/components/RecentCalls.tsx?raw';
import liveCallCss from './live-call/styles.css?raw';

/**
 * The customScreen SECTION payload for the Calls form (kind 'code', files-based). The
 * Calls form ALSO carries a recordScreen (the transcript widget); that is a separate
 * blob and is spread in alongside this at the pack site.
 */
export const AOKIE_LIVE_CALL_SCREEN = {
  enabled: true,
  allowNewResponses: false,
  kind: 'code' as const,
  title: 'Live Call',
  entry: 'index.tsx',
  files: [
    { path: 'index.tsx', content: liveCallIndexTsx },
    { path: 'controller.ts', content: liveCallControllerTs },
    { path: 'phone.ts', content: liveCallPhoneTs },
    { path: 'components/CallStage.tsx', content: liveCallStageTsx },
    { path: 'components/Transcript.tsx', content: liveCallTranscriptTsx },
    { path: 'components/RecentCalls.tsx', content: liveCallRecentTsx },
    { path: 'styles.css', content: liveCallCss },
  ],
};
