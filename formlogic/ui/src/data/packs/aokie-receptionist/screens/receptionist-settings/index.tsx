/** @jsxImportSource preact */
// Pack-owned Receptionist Settings SECTION screen - TSX edition (bundled in
// the sandbox on Preact). The grouped-card console over the singleton
// Receptionist Settings record PLUS the live plugin settings.
//
// Runtime contract (CustomScreenRuntime, APP runtime):
//  - opaque-origin iframe, strict CSP; `window.FormLogic` is the only bridge.
//    Lanes used: connector('aokie','settings.get'/'.set') (local-or-relay is
//    transparent), records()/submit()/updateRecord() (the singleton record -
//    create-on-first-save, then PARTIAL patches the controller PATCH-merges),
//    aiSources(), presence(), can(). Every action is TRUSTED_ONLY: the form's
//    custom_screen_trust must be owner/verified.
//  - The manager-PIN security boundary lives ENTIRELY in the plugin
//    (settings.get never returns the PIN - only managerPinSet; settings.set
//    seals + redacts + validates it): this screen can only WRITE a new PIN
//    and can never read the stored one. See store.ts for the preserved
//    write-only / partial-save / create-guard invariants.
//  - Theme = the injected --fl-* variables; JSX text is auto-escaped, so
//    record/settings values can never inject markup.
//  - The OAIY route (call_route 'oaiy', the default for new records) leads:
//    the OAIY card says whether OAIY is reachable and where calls go, the
//    route card chooses, and the voice / speech / audio cards give way to a
//    "Set in OAIY" card (OAIY owns those on its route).
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { loadAll, onOaiy, state, subscribe } from './store';
import { OaiyCard } from './components/OaiyCard';
import { RunningCard } from './components/RunningCard';
import { RouteCard } from './components/RouteCard';
import { BusinessCard } from './components/BusinessCard';
import { PersonalityCard } from './components/PersonalityCard';
import { SetInOaiyCard } from './components/SetInOaiyCard';
import { VoiceCard } from './components/VoiceCard';
import { ServicesCard } from './components/ServicesCard';
import { BackgroundAiCard } from './components/BackgroundAiCard';
import { AudioCard } from './components/AudioCard';
import { WaitingCard } from './components/WaitingCard';
import { ScreeningCard } from './components/ScreeningCard';
import { AdvancedCard } from './components/AdvancedCard';
import { SaveBar } from './components/SaveBar';

function Loading() {
  return (
    <section class="card" aria-busy="true" aria-label="Loading settings">
      <span class="skeleton" />
      <span class="skeleton short" />
      <p class="muted">Loading the receptionist settings...</p>
    </section>
  );
}

function App() {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), []);
  const toOaiy = onOaiy();
  return (
    <div id="rs" class="ak" aria-label="Receptionist settings">
      <header class="page-head">
        <h1>Receptionist settings</h1>
        <p class="sub">How the Aokie receptionist answers your phone, and what FormLogic sends it.</p>
      </header>
      <div id="cards">
        {state.draft === null ? (
          <Loading />
        ) : (
          <>
            <OaiyCard />
            {state.err ? <div id="err" role="alert">{state.err}</div> : null}
            <RunningCard />
            <RouteCard />
            <BusinessCard />
            <PersonalityCard />
            {toOaiy ? <SetInOaiyCard /> : null}
            {toOaiy ? null : <VoiceCard />}
            {toOaiy ? null : <ServicesCard />}
            <BackgroundAiCard />
            {toOaiy ? null : <AudioCard />}
            <WaitingCard />
            <ScreeningCard />
            {toOaiy ? null : <AdvancedCard />}
            <SaveBar />
          </>
        )}
      </div>
    </div>
  );
}

// Kick the load exactly where the original called wire(); a notify landing
// before the component subscribes is replayed by the store on subscribe.
void loadAll();

render(<App />, document.getElementById('root')!);
