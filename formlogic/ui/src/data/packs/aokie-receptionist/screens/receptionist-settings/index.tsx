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
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { loadAll, state, subscribe } from './store';
import { RunningCard } from './components/RunningCard';
import { BusinessCard } from './components/BusinessCard';
import { PersonalityCard } from './components/PersonalityCard';
import { VoiceCard } from './components/VoiceCard';
import { ServicesCard } from './components/ServicesCard';
import { AudioCard } from './components/AudioCard';
import { WaitingCard } from './components/WaitingCard';
import { ScreeningCard } from './components/ScreeningCard';
import { AdvancedCard } from './components/AdvancedCard';
import { SaveBar } from './components/SaveBar';

function App() {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((t) => t + 1)), []);
  return (
    <div id="rs" aria-label="Receptionist settings">
      <div id="cards">
        {state.draft === null ? (
          <div class="card"><p class="muted">Loading settings...</p></div>
        ) : (
          <>
            <RunningCard />
            {state.err ? <div id="err">{state.err}</div> : null}
            <BusinessCard />
            <PersonalityCard />
            <VoiceCard />
            <ServicesCard />
            <AudioCard />
            <WaitingCard />
            <ScreeningCard />
            <AdvancedCard />
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
