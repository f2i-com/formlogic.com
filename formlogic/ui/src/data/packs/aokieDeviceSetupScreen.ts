// Pack-owned Device Setup section screen (plan 8.4 port #4 - self-contained apps).
//
// TSX edition: the screen is REAL SOURCE FILES under ./aokie-screens/device-setup/
// (index.tsx + card components + helpers + styles.css), imported here as strings
// (?raw) and shipped in customScreen.files. The sandbox runtime bundles them on
// render (esbuild-wasm + embedded Preact - screenCompile.ts); the sources are
// type-checked by the repo's tsc and unit-tested by executing the REAL compiled
// bundle in JSDOM (aokieDeviceSetupScreenTsx.test.ts). The compiled registry
// screen `aokie-pairing` + its registry entry stay untouched; rollback is
// flipping the Hardware Events form's customScreen back to the sdk reference.
//
// Runtime contract (CustomScreenRuntime in the APP runtime):
//  - opaque-origin iframe; window.FormLogic is the only capability;
//  - uses the FULL bridge: connector() (dongle/phone commands, local-or-relay
//    routing is transparent), service() (linked desktops + Companion admin),
//    records()/deleteRecords() (hardware-event log), presence(), can()
//    (advisory button gating), host.ceremony() ('connect-desktop' pairing,
//    'start-fresh' reset - both host-owned with the host's own consent UI);
//  - every one of those actions is TRUSTED_ONLY, so the form's
//    custom_screen_trust must be owner/verified;
//  - PARITY GAPS vs the compiled screen (deliberate, documented): no desktop
//    plugin list (desktop-app detail), and Companion routing groups / history
//    live in FormLogic Desktop's Companion admin - this screen covers
//    endpoints (revoke/approve) + the remote-access policy.

import deviceIndexTsx from './aokie-screens/device-setup/index.tsx?raw';
import deviceBridgeTs from './aokie-screens/device-setup/bridge.ts?raw';
import deviceFormatTs from './aokie-screens/device-setup/format.ts?raw';
import deviceTypesTs from './aokie-screens/device-setup/types.ts?raw';
import deviceLoadingTsx from './aokie-screens/device-setup/components/Loading.tsx?raw';
import deviceRuntimeCardTsx from './aokie-screens/device-setup/components/RuntimeCard.tsx?raw';
import deviceDonglesCardTsx from './aokie-screens/device-setup/components/DonglesCard.tsx?raw';
import devicePhonesCardTsx from './aokie-screens/device-setup/components/PhonesCard.tsx?raw';
import deviceCompanionCardTsx from './aokie-screens/device-setup/components/CompanionCard.tsx?raw';
import deviceEventsCardTsx from './aokie-screens/device-setup/components/EventsCard.tsx?raw';
import deviceFreshCardTsx from './aokie-screens/device-setup/components/FreshCard.tsx?raw';
import deviceStylesCss from './aokie-screens/device-setup/styles.css?raw';

/**
 * The customScreen payload for the Hardware Events form section (kind 'code').
 * allowNewResponses stays false - rows are written automatically from
 * aokie.hardware.error events.
 */
export const AOKIE_DEVICE_SETUP_SCREEN = {
  enabled: true,
  allowNewResponses: false,
  kind: 'code' as const,
  title: 'Device Setup',
  entry: 'index.tsx',
  files: [
    { path: 'index.tsx', content: deviceIndexTsx },
    { path: 'bridge.ts', content: deviceBridgeTs },
    { path: 'format.ts', content: deviceFormatTs },
    { path: 'types.ts', content: deviceTypesTs },
    { path: 'components/Loading.tsx', content: deviceLoadingTsx },
    { path: 'components/RuntimeCard.tsx', content: deviceRuntimeCardTsx },
    { path: 'components/DonglesCard.tsx', content: deviceDonglesCardTsx },
    { path: 'components/PhonesCard.tsx', content: devicePhonesCardTsx },
    { path: 'components/CompanionCard.tsx', content: deviceCompanionCardTsx },
    { path: 'components/EventsCard.tsx', content: deviceEventsCardTsx },
    { path: 'components/FreshCard.tsx', content: deviceFreshCardTsx },
    { path: 'styles.css', content: deviceStylesCss },
  ],
};
