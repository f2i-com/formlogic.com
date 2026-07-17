import { useEffect, useMemo, useState } from 'react';
import { aiProviders, type AiProviderView } from './api';
import type { DesktopOverviewData } from './useDesktopOverview';
import { CheckIcon, XIcon } from './Icons';
import {
  deriveSetupChecklist,
  getSetupAiChoice,
  getSetupGuideState,
  setSetupAiChoice,
  setSetupGuideState,
  setupChecklistComplete,
  type SetupAiChoice,
  type SetupChecklistItem,
} from './setupWizard';

/**
 * First-run "Let's get you ready" wizard — a smart checklist, not a tour.
 *
 * Step 1 asks ONE question (local vs cloud AI — a soft preference stored in
 * localStorage, changeable any time); step 2 renders the live checklist with
 * "Take me there" hand-offs into the real panels, which do the explaining.
 * Done-states derive from the same Overview poll the rest of the app uses,
 * so ticks appear on their own as the user finishes each step.
 */

interface SetupWizardProps {
  overview: DesktopOverviewData;
  /** Close + switch section + trigger the gentle context highlight. */
  onNavigate: (section: string, itemId: string) => void;
  onClose: () => void;
}

const AI_PROVIDERS_POLL_MS = 5000;

export default function SetupWizard({ overview, onNavigate, onClose }: SetupWizardProps) {
  const [choice, setChoice] = useState<SetupAiChoice | null>(() => getSetupAiChoice());
  const [step, setStep] = useState<'choice' | 'list'>(choice ? 'list' : 'choice');
  const [providers, setProviders] = useState<AiProviderView[] | undefined>(undefined);
  const [dismissChecked, setDismissChecked] = useState(false);

  // The cloud row's done-state needs the AI-provider list, which the Overview
  // poll doesn't carry — fetch it here, only while the wizard is open.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await aiProviders.list();
        if (!cancelled) setProviders(res.providers);
      } catch {
        /* desktop API not up yet — the row just stays unticked */
      }
    };
    void tick();
    const id = window.setInterval(tick, AI_PROVIDERS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const items = useMemo(
    () => deriveSetupChecklist(overview, providers, choice ?? 'local'),
    [overview, providers, choice],
  );
  const allDone = choice !== null && overview.loaded && setupChecklistComplete(items);

  // Completing every required row marks the guide done — the header pill
  // retires on its own, no click needed.
  useEffect(() => {
    if (allDone && getSetupGuideState() === 'pending') setSetupGuideState('done');
  }, [allDone]);

  const recordSeen = () => {
    // Leaving without finishing keeps 'pending' (recorded — the auto-open is
    // one-shot; the header pill takes over) unless the user opted out.
    if (dismissChecked) setSetupGuideState('dismissed');
    else if (getSetupGuideState() === 'pending') setSetupGuideState('pending');
  };

  const close = () => {
    recordSeen();
    onClose();
  };

  const navigate = (item: SetupChecklistItem) => {
    recordSeen();
    onNavigate(item.section, item.id);
  };

  const pickChoice = (c: SetupAiChoice) => {
    setSetupAiChoice(c);
    setChoice(c);
    setStep('list');
  };

  return (
    <div
      className="confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Setup guide"
    >
      <div className="confirm-dialog setup-dialog">
        <div className="setup-head">
          <h2 className="confirm-title">Let's get you ready</h2>
          <button type="button" className="btn-tiny" aria-label="Close" onClick={close}>
            <XIcon size={16} />
          </button>
        </div>

        {step === 'choice' ? (
          <>
            <p className="confirm-body">
              How do you want to run AI? You can change this any time.
            </p>
            <div className="setup-choice-grid">
              <button
                type="button"
                className={`setup-choice-card${choice === 'local' ? ' is-selected' : ''}`}
                onClick={() => pickChoice('local')}
              >
                <span className="setup-choice-tag">Recommended</span>
                <strong>On this computer</strong>
                <span>Private — uses your GPU. Nothing leaves this machine.</span>
              </button>
              <button
                type="button"
                className={`setup-choice-card${choice === 'cloud' ? ' is-selected' : ''}`}
                onClick={() => pickChoice('cloud')}
              >
                <strong>Cloud provider</strong>
                <span>Bring an API key — OpenAI, Anthropic, or any compatible endpoint.</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="setup-mode-line">
              AI: {choice === 'cloud' ? 'cloud provider' : 'on this computer'}
              <button type="button" className="btn-tiny" onClick={() => setStep('choice')}>
                Change
              </button>
            </p>
            <ul className="setup-checklist">
              {items.map((it) => (
                <li key={it.id} className={`setup-item${it.done ? ' is-done' : ''}`}>
                  <span className="setup-item__mark" aria-hidden="true">
                    {it.done ? <CheckIcon size={12} /> : ''}
                  </span>
                  <span className="setup-item__text">
                    <strong>
                      {it.title}
                      {it.optional && <em> · optional</em>}
                    </strong>
                    <span className="setup-item__hint">{it.hint}</span>
                  </span>
                  {!it.done && (
                    <button type="button" className="btn btn-secondary" onClick={() => navigate(it)}>
                      Take me there →
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {allDone && (
              <p className="setup-done-note">
                You're all set — the optional rows are there whenever you want them.
              </p>
            )}
          </>
        )}

        <div className="setup-footer">
          <label>
            <input
              type="checkbox"
              checked={dismissChecked}
              onChange={(e) => setDismissChecked(e.target.checked)}
            />
            Don't show this again
          </label>
          <button type="button" className="btn btn-primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
