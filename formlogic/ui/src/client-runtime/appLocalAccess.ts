// What an app may use of the person viewing it.
//
// An app's flows and screens are its author's code, and they run in the viewer's
// browser. That browser reaches things that are the viewer's and not the app's: OAIY
// or FormLogic Desktop on this computer (a phone, plugins, local AI, and what those
// report as it happens), the AI keys in their settings, and whatever the browser has
// already been allowed for this whole site, such as location. The connector grants an
// app declares are the app's own word, so
// they cannot be what lets it use those. Someone who manages the app chose what it
// runs, so what they reach is theirs to spend. Anyone else is asked, once for each
// app, and a yes is kept for their account until they take it back in Settings. Staff
// running a business's app on their own OAIY say yes once.
//
// A desktop linked to the account is not this: the server relays those commands
// itself, under its own rules, and they do not go through here.

export interface OnScreenApp {
  id: string;
  slug: string;
  name: string;
  /** The server's word that this viewer manages the app. */
  manages: boolean;
}

export interface AllowedApp {
  id: string;
  name: string;
}

export interface AppAccessRequest {
  app: OnScreenApp;
  /** The person's answer. A no lasts until the page is loaded again. */
  decide(allowed: boolean): void;
}

export const NOT_ALLOWED_MESSAGE =
  'This app has not been allowed to use your AI or OAIY on this computer. Allow it when asked, or ask whoever manages the app.';

const STORAGE_PREFIX = 'formlogic:app-local-access:v1:';

interface WaitingRequest extends AppAccessRequest {
  /** Ends the wait with a no that nobody gave, so it is not kept as anyone's answer. */
  withdraw(): void;
}

let onScreen: OnScreenApp | null = null;
let account: string | null = null;
const declined = new Set<string>();
/** A yes from someone not signed in: there is no account to keep it under, so it lasts for the page. */
const allowedForThePage = new Set<string>();
const pending = new Map<string, Promise<boolean>>();
const queue: WaitingRequest[] = [];
const requestListeners = new Set<(request: AppAccessRequest | null) => void>();
const allowedListeners = new Set<() => void>();

/** The app the viewer has open; the app runtime store sets it. */
export function setOnScreenApp(app: OnScreenApp | null): void {
  onScreen = app;
}

/** Whose answers these are; authStore sets it. What one account allowed, another has not. */
export function setAppLocalAccessAccount(userId: string | null): void {
  if (userId === account) return;
  account = userId;
  declined.clear();
  allowedForThePage.clear();
  // A prompt still open was put to the last account. Answered now, one person's yes would release
  // another's command, and be kept for them.
  const waiting = queue.splice(0);
  pending.clear();
  for (const request of waiting) request.withdraw();
  if (waiting.length > 0) publishRequest();
  for (const listener of allowedListeners) listener();
}

function readAllowed(userId: string): AllowedApp[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${userId}`) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((row): row is AllowedApp => typeof row?.id === 'string' && typeof row?.name === 'string');
  } catch {
    return [];
  }
}

function writeAllowed(userId: string, apps: AllowedApp[]): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(apps));
  } catch {
    /* storage blocked: the yes lasts for this page */
  }
  for (const listener of allowedListeners) listener();
}

/** The apps this account has allowed, for Settings to show and take back. */
export function listAllowedApps(): AllowedApp[] {
  return account ? readAllowed(account) : [];
}

export function forgetAllowedApp(appId: string): void {
  if (!account) return;
  writeAllowed(account, readAllowed(account).filter((app) => app.id !== appId));
}

export function subscribeAllowedApps(listener: () => void): () => void {
  allowedListeners.add(listener);
  return () => {
    allowedListeners.delete(listener);
  };
}

/** Erase what an account allowed: the account is being deleted. */
export function forgetAppLocalAccessOf(userId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${userId}`);
  } catch {
    /* storage blocked: nothing to erase */
  }
}

function publishRequest(): void {
  const next = queue[0] ?? null;
  for (const listener of requestListeners) listener(next);
}

/** The one place that asks the person (AppLocalAccessPrompt). With nobody to ask, the answer is no. */
export function subscribeAppAccessRequests(listener: (request: AppAccessRequest | null) => void): () => void {
  requestListeners.add(listener);
  listener(queue[0] ?? null);
  return () => {
    requestListeners.delete(listener);
  };
}

function ask(app: OnScreenApp): Promise<boolean> {
  const asking = pending.get(app.id);
  if (asking) return asking;
  if (requestListeners.size === 0) return Promise.resolve(false);
  const answer = new Promise<boolean>((resolve) => {
    const request: WaitingRequest = {
      app,
      decide(allowed) {
        // Answered already, or withdrawn while the prompt was closing.
        if (queue[0] !== request) return;
        queue.shift();
        pending.delete(app.id);
        if (allowed) {
          if (account) writeAllowed(account, [...readAllowed(account).filter((row) => row.id !== app.id), { id: app.id, name: app.name }]);
          else allowedForThePage.add(app.id);
        } else {
          declined.add(app.id);
        }
        publishRequest();
        resolve(allowed);
      },
      withdraw: () => resolve(false),
    };
    queue.push(request);
  });
  pending.set(app.id, answer);
  publishRequest();
  return answer;
}

/**
 * May the app on screen use the viewer's AI and what this browser reaches on this
 * computer? With no app open, this is the person's own page and the answer is yes.
 * `slug` is the app a run belongs to: anything but the app on screen is refused.
 */
export async function appMayUseThisComputer(slug?: string): Promise<boolean> {
  if (slug === undefined && onScreen === null) return true;
  if (onScreen === null || (slug !== undefined && onScreen.slug !== slug)) return false;
  const app = onScreen;
  if (app.manages) return true;
  if (allowedForThePage.has(app.id)) return true;
  if (account && readAllowed(account).some((row) => row.id === app.id)) return true;
  if (declined.has(app.id)) return false;
  return ask(app);
}

/** As {@link appMayUseThisComputer}, for a caller whose failure is a thrown error. */
export async function assertAppMayUseThisComputer(slug?: string): Promise<void> {
  if (!(await appMayUseThisComputer(slug))) throw new Error(NOT_ALLOWED_MESSAGE);
}

/** Test-only. */
export function __resetAppLocalAccessForTests(): void {
  onScreen = null;
  account = null;
  declined.clear();
  allowedForThePage.clear();
  pending.clear();
  queue.length = 0;
  requestListeners.clear();
  allowedListeners.clear();
}
