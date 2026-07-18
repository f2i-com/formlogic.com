// Pack-owned Receptionist Settings console (plan §8.4 port #3 — the LAST screen).
//
// TSX edition: the screen is REAL SOURCE FILES under
// ./aokie-screens/receptionist-settings/ (index.tsx + store.ts + helpers.ts +
// agentPayload.ts + components/* + styles.css), imported here as strings (?raw)
// and shipped in customScreen.files. The sandbox runtime bundles them on render
// (esbuild-wasm + embedded Preact — screenCompile.ts); the sources are
// type-checked by the repo's tsc and unit-tested BOTH as modules and as the
// COMPILED artifact (aokieReceptionistSettingsScreenTsx.test.ts). The compiled
// registry screen `aokie-receptionist-settings` stays untouched for rollback
// (flip the form's SECTION customScreen back to the sdk reference).
//
// Behavior-preserving port of the embedded-string edition. The security
// boundary for the manager PIN lives ENTIRELY in the plugin — settings.get
// never returns it (only `managerPinSet`), settings.set seals it (DPAPI) and
// redacts it from the response, and the plugin validates it. The sandbox can
// only WRITE a new PIN and can NEVER read the stored one; the screen keeps the
// reviewed invariants (write-only PIN field / blank-keeps / explicit Remove
// PIN, partial-save baseline rebasing, the shared create-in-flight guard) —
// see store.ts, all test-locked. AOK-304 (settings OWNERSHIP split) remains a
// separate supervised refactor, not a prerequisite for this UI move.
//
// Runtime contract (CustomScreenRuntime, APP runtime): opaque-origin iframe;
// window.FormLogic only. Lanes used: connector('aokie', 'settings.get'/'.set')
// (routing local-or-relay is transparent), records()/submit()/updateRecord()
// (the singleton record — create-on-first-save, then PARTIAL patches which the
// controller PATCH-merges), aiSources() (host-resolved desktop AI-sources for
// the lane pickers), presence(), can(). "Save & apply now" composes the
// settings.set payload with agentPayload.ts's SELF-CONTAINED copy of
// composeAgentPayload (+ DEFAULT_PERSONA + AI_GATEWAY_BASE) — the sandbox
// cannot import host modules, so the copy is pinned to the canonical
// receptionistPayload.ts / aokieReceptionistPersona.ts by the parity tests
// (strict-equal constants, deep-equal payloads), keeping console, flow and
// this screen in lock-step.
//
// Every bridge action is TRUSTED_ONLY: the form's custom_screen_trust must be
// owner/verified. Screen sources stay ASCII-clean (the persona's em dash is a
// backslash-u2014 escape) and token-only in CSS — the check-pack-screens gate
// enforces both on the shipped files.

import settingsIndexTsx from './aokie-screens/receptionist-settings/index.tsx?raw';
import settingsStoreTs from './aokie-screens/receptionist-settings/store.ts?raw';
import settingsHelpersTs from './aokie-screens/receptionist-settings/helpers.ts?raw';
import settingsAgentPayloadTs from './aokie-screens/receptionist-settings/agentPayload.ts?raw';
import settingsCss from './aokie-screens/receptionist-settings/styles.css?raw';
import runningCardTsx from './aokie-screens/receptionist-settings/components/RunningCard.tsx?raw';
import businessCardTsx from './aokie-screens/receptionist-settings/components/BusinessCard.tsx?raw';
import personalityCardTsx from './aokie-screens/receptionist-settings/components/PersonalityCard.tsx?raw';
import voiceCardTsx from './aokie-screens/receptionist-settings/components/VoiceCard.tsx?raw';
import servicesCardTsx from './aokie-screens/receptionist-settings/components/ServicesCard.tsx?raw';
import audioCardTsx from './aokie-screens/receptionist-settings/components/AudioCard.tsx?raw';
import waitingCardTsx from './aokie-screens/receptionist-settings/components/WaitingCard.tsx?raw';
import screeningCardTsx from './aokie-screens/receptionist-settings/components/ScreeningCard.tsx?raw';
import advancedCardTsx from './aokie-screens/receptionist-settings/components/AdvancedCard.tsx?raw';
import saveBarTsx from './aokie-screens/receptionist-settings/components/SaveBar.tsx?raw';

/**
 * The customScreen SECTION payload for the Receptionist Settings form (kind
 * 'code'). The screen owns the singleton record itself, so New-record chrome
 * stays off.
 */
export const AOKIE_RECEPTIONIST_SETTINGS_SCREEN = {
  enabled: true,
  allowNewResponses: false,
  kind: 'code' as const,
  title: 'Receptionist Settings',
  entry: 'index.tsx',
  files: [
    { path: 'index.tsx', content: settingsIndexTsx },
    { path: 'store.ts', content: settingsStoreTs },
    { path: 'helpers.ts', content: settingsHelpersTs },
    { path: 'agentPayload.ts', content: settingsAgentPayloadTs },
    { path: 'components/RunningCard.tsx', content: runningCardTsx },
    { path: 'components/BusinessCard.tsx', content: businessCardTsx },
    { path: 'components/PersonalityCard.tsx', content: personalityCardTsx },
    { path: 'components/VoiceCard.tsx', content: voiceCardTsx },
    { path: 'components/ServicesCard.tsx', content: servicesCardTsx },
    { path: 'components/AudioCard.tsx', content: audioCardTsx },
    { path: 'components/WaitingCard.tsx', content: waitingCardTsx },
    { path: 'components/ScreeningCard.tsx', content: screeningCardTsx },
    { path: 'components/AdvancedCard.tsx', content: advancedCardTsx },
    { path: 'components/SaveBar.tsx', content: saveBarTsx },
    { path: 'styles.css', content: settingsCss },
  ],
};
