/**
 * First-run setup guide ("Let's get you ready") — state + checklist logic.
 *
 * The wizard itself (SetupWizard.tsx) is a smart CHECKLIST, not a tour: each
 * row derives its done-state live from the same Overview poll the rest of the
 * app uses, and a "Take me there" hand-off opens the real panel (which does
 * the explaining). This module keeps the React-free parts:
 *
 *  - localStorage state (try/catch so private mode / disabled storage degrade):
 *    `formlogic.setupGuide` — absent = true first run (auto-open once),
 *    'pending' = seen but unfinished (header pill re-opens it),
 *    'done' / 'dismissed' = never auto-surface again.
 *    `formlogic.setupAiChoice` — 'local' | 'cloud' (soft preference, not a fork).
 *  - a tiny module event so Settings can re-open the wizard that lives in App
 *    without prop-drilling or a reload.
 *  - deriveSetupChecklist(): a PURE function (unit-tested under node:test)
 *    that turns the live snapshots into checklist rows.
 */

export type SetupGuideState = 'pending' | 'done' | 'dismissed';
export type SetupAiChoice = 'local' | 'cloud';

const STATE_KEY = 'formlogic.setupGuide';
const CHOICE_KEY = 'formlogic.setupAiChoice';

export function getSetupGuideState(): SetupGuideState {
  try {
    const v = localStorage.getItem(STATE_KEY);
    return v === 'done' || v === 'dismissed' ? v : 'pending';
  } catch {
    return 'pending';
  }
}

/** True only on a genuine first run — nothing recorded yet. Drives the single
 *  automatic open; every later surfacing is user-initiated (pill / Settings). */
export function isSetupGuideFirstRun(): boolean {
  try {
    return localStorage.getItem(STATE_KEY) === null;
  } catch {
    return false;
  }
}

export function setSetupGuideState(v: SetupGuideState): void {
  try {
    localStorage.setItem(STATE_KEY, v);
  } catch {
    /* private mode / disabled storage — the wizard just won't remember */
  }
}

export function getSetupAiChoice(): SetupAiChoice | null {
  try {
    const v = localStorage.getItem(CHOICE_KEY);
    return v === 'local' || v === 'cloud' ? v : null;
  } catch {
    return null;
  }
}

export function setSetupAiChoice(v: SetupAiChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, v);
  } catch {
    /* non-fatal — the choice card just re-asks next time */
  }
}

// ---- "open the wizard" module event (Settings → App, no prop drilling) ----

type OpenListener = () => void;
const openListeners = new Set<OpenListener>();

export function subscribeSetupGuideOpen(fn: OpenListener): () => void {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}

/** Settings' "Show the setup guide": reset to pending + ask App to open it. */
export function reopenSetupGuide(): void {
  setSetupGuideState('pending');
  for (const fn of [...openListeners]) fn();
}

// ---- pure checklist derivation ----

/**
 * Structural slices of the live snapshots — DesktopOverviewData and
 * AiProviderView satisfy these as-is, and tests can build tiny literals
 * without dragging in api.ts (which imports Tauri modules node:test can't).
 */
export interface SetupServiceLike {
  id: string;
  status: string;
  installed: boolean;
}

export interface SetupOverviewLike {
  services?: { services: SetupServiceLike[] };
  models?: { models: readonly unknown[] };
  plugins?: { plugins: { id: string; state: string }[] };
  runtime?: { linked: boolean };
  cloud?: { linked: boolean };
}

export interface SetupAiProviderLike {
  enabled: boolean;
  hasKey: boolean;
  /** Local endpoints (Ollama / LM Studio / local gateways) work keyless. */
  allowLocal?: boolean;
}

export interface SetupChecklistItem {
  id: string;
  title: string;
  hint: string;
  done: boolean;
  /** The section a "Take me there" hand-off opens (App changeSection id). */
  section: string;
  /** Optional rows never block the guide from counting as complete. */
  optional: boolean;
}

/** The service the LOCAL path needs running (ships as a built-in template). */
export const LOCAL_AI_SERVICE_ID = 'llama-cpp';

export function deriveSetupChecklist(
  overview: SetupOverviewLike,
  aiProviders: readonly SetupAiProviderLike[] | undefined,
  aiChoice: SetupAiChoice,
): SetupChecklistItem[] {
  const services = overview.services?.services ?? [];
  const llama = services.find((s) => s.id === LOCAL_AI_SERVICE_ID);
  const items: SetupChecklistItem[] = [];

  if (aiChoice === 'local') {
    items.push(
      {
        id: 'llama-service',
        title: 'Install & start the llama.cpp service',
        hint: 'Runs AI models privately on this computer.',
        done: !!llama && llama.installed && llama.status === 'running',
        section: 'services',
        optional: false,
      },
      {
        id: 'model',
        title: 'Download a model',
        hint: 'Pick one from the catalog — llama.cpp loads it.',
        done: (overview.models?.models.length ?? 0) > 0,
        section: 'models',
        optional: false,
      },
    );
  } else {
    items.push({
      id: 'ai-provider',
      title: 'Add an AI provider',
      hint: 'Bring an API key — OpenAI, Anthropic, or any compatible endpoint.',
      done: (aiProviders ?? []).some((p) => p.enabled && (p.hasKey || !!p.allowLocal)),
      section: 'services', // the AI providers panel lives inside Services
      optional: false,
    });
  }

  items.push(
    {
      id: 'aokie-plugin',
      title: 'Install the Aokie phone receptionist',
      hint: 'Optional — an AI that answers your business line.',
      done: (overview.plugins?.plugins ?? []).some(
        (p) => p.id === 'aokie' && p.state === 'running',
      ),
      section: 'plugins',
      optional: true,
    },
    {
      id: 'cloud-link',
      title: 'Link your FormLogic account',
      hint: 'Optional — lets your FormLogic apps use this computer.',
      done: (overview.runtime?.linked ?? overview.cloud?.linked) === true,
      section: 'connections',
      optional: true,
    },
  );

  return items;
}

/** All REQUIRED rows done (optional rows never block). */
export function setupChecklistComplete(items: readonly SetupChecklistItem[]): boolean {
  return items.filter((i) => !i.optional).every((i) => i.done);
}
