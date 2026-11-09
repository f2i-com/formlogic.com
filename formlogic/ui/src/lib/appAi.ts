/**
 * App AI's settings, as FormLogic answers them (AppAiController): an app's "AI for this app" and the
 * administrator's "AI for apps". See docs/HOSTED_APPS.md, "App AI, visitors and payments".
 */
export type AppAiMode = 'off' | 'site' | 'own';

export interface AppAiLimits { perRequesterDay: number; perIpDay: number; perIpHour: number; perAppDay: number }

/** The owner's own computer the app's AI runs on ("Use my OAIY"), as the owner chose it. */
export interface AppAiOwnComputer { connectionId: string; deviceName: string; providerId: string; pictureModel: string | null; chatModel: string | null }

/** What the owner sends to choose their own computer: OAIY's own engine draws the pictures. */
export interface AppAiOwnChoice { connectionId: string; providerId: string; pictureModel: string | null }

/** One of the owner's linked computers that could serve: it has published its chat key. */
export interface AppAiComputer { connectionId: string; instanceId: string; deviceName: string; fingerprint: string; online: boolean; lastSeenAt: string | null }

export interface AppAiSettings extends AppAiLimits {
  mode: AppAiMode;
  blocked: boolean;
  blockedReason: string | null;
  pausedUntil: string | null;
  own: AppAiOwnComputer | null;
}

export interface AppAiStatus {
  /** off, idle, busy (jobs waiting or running), offline (the computer has not checked in), paused (the site or the breaker), blocked. */
  state: 'off' | 'idle' | 'busy' | 'offline' | 'paused' | 'blocked';
  waiting: number;
  running: number;
  since: string | null;
  /** While offline: when the computer was last heard from (UTC, `YYYY-MM-DD HH:MM:SS`). */
  offlineSince?: string | null;
  message: string;
}

/** "Use this site's AI" as an app's owner would find it now, whatever the app is set to. */
export interface AppAiSiteOffer {
  /** The administrator lets apps use the site's AI. */
  offered: boolean;
  /** It would answer now. */
  working: boolean;
  /** Why it is not offered or would not work: site_ai_closed, ai_paused, site_ai_gone, site_ai_unavailable, model_unset, no_pictures. */
  reason: string | null;
  kinds: string[];
  /** What the app asks for that the site's AI cannot do yet, and why (model_unset, no_pictures). */
  missing: { kinds: string[]; reason: string } | null;
}

export interface AppAiLogEntry {
  id: string;
  appJobId: string;
  kind: 'picture' | 'edit' | 'chat' | string;
  status: string;
  code: string | null;
  message: string | null;
  requester: string;
  test: boolean;
  createdAt: string;
  finishedAt: string | null;
  seconds: number | null;
}

/** The owner's "AI for this app". */
export interface AppAiView {
  declared: { uses: string[]; purpose: string; table: string; deliver: string } | null;
  settings: AppAiSettings;
  availability: { enabled: boolean; source: AppAiMode; label: string; kinds: string[]; reason: string | null };
  reasonText: string | null;
  siteOffers: boolean;
  site?: AppAiSiteOffer;
  status: AppAiStatus;
  today: { jobs: number; failed: number; refused: number };
  log: AppAiLogEntry[];
  computers?: AppAiComputer[];
}

export interface AppAiTestResult {
  status: 'queued' | 'running' | 'done' | 'failed';
  picture?: string;
  text?: string;
  model?: string | null;
  seed?: number | null;
  seconds?: number | null;
  code?: string | null;
  message?: string | null;
  /** While it waits or runs: for how long. */
  waitedSeconds?: number;
  /** The administrator's test, while it waits: for the worker (nothing runs it), or for the computer (it is offline). */
  waiting?: 'worker' | 'computer';
}

/** The administrator's "AI for apps". */
export interface AppAiSiteSettings {
  allowApps: boolean;
  paused: boolean;
  pictureModel: string | null;
  chatModel: string | null;
  defaults: AppAiLimits;
  siteDay: number;
  words: string[];
}

export interface AppAiAdminApp {
  appId: string;
  name: string;
  ownerEmail: string;
  mode: AppAiMode;
  jobsToday: number;
  failedToday: number;
  blocked: boolean;
  blockedReason: string | null;
  pausedUntil: string | null;
}

/** The administrator's setup checklist: where the site's AI runs now, and what apps on it would get. */
export interface AppAiSetup {
  /** A computer is chosen and stands; the one chosen is gone; none chosen and the server's settings name a provider; or nothing. */
  source: 'computer' | 'env' | 'gone' | 'none';
  computer: { connectionId: string; deviceName: string; providerId: string; online: boolean; lastSeenAt: string | null } | null;
  gone: { deviceName: string } | null;
  /** The server's own provider: named in its settings, and the Site AI switch, without which it is never used. */
  provider: { named: boolean; on: boolean };
  /** This server can prepare the pictures that come back (PHP's GD). */
  drawing: boolean;
  /** What the site's AI takes now: picture, chat. */
  kinds: string[];
  reason: string | null;
  /** Apps can make pictures now. */
  ready: boolean;
  /** Seconds since the worker last ran on this server; null when it never has. */
  workerIdleSeconds: number | null;
  /**
   * The last test picture that finished (UTC `at`), or null. `current`: it ran where the site's AI
   * runs now, with the picture model chosen now.
   */
  lastTest?: { status: 'done' | 'failed'; at: string; seconds: number | null; model: string | null; code: string | null; message: string | null; current: boolean } | null;
}

export interface AppAiAdminView { settings: AppAiSiteSettings; setup?: AppAiSetup; apps: AppAiAdminApp[]; warnings: { code: string; message: string }[] }

/** A model as a computer lists it; `type` is `image` for a picture model, absent for a language model. */
export interface AiModel { id: string; name: string; type?: string }

/** The picture model to suggest from a computer's list: FLUX 3 Image Klein where it has it, else its first picture model. */
export function suggestedPictureModel(models: AiModel[]): string | null {
  const pictures = models.filter((model) => model.type === 'image');
  return (pictures.find((model) => model.id === 'flux-3-image-klein') ?? pictures[0])?.id ?? null;
}

/** A time the server gave in UTC (`YYYY-MM-DD HH:MM:SS`), as a Date. */
export function utcStamp(stamp: string): Date {
  return new Date(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T').slice(0, 19)}Z`);
}

/** A server's time in the reader's own: "2:05 pm" today, "9 Nov, 2:05 pm" on another day. */
function clockWords(stamp: string | null | undefined, now: Date): { today: boolean; text: string } | null {
  if (!stamp) return null;
  const then = utcStamp(stamp);
  if (Number.isNaN(then.getTime())) return null;
  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = then.toDateString() === now.toDateString();
  return { today, text: today ? time : `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}` };
}

/** "since 2:05 pm", or with the day when it was not today. */
export function sinceWords(stamp: string | null | undefined, now: Date = new Date()): string {
  const clock = clockWords(stamp, now);
  return clock ? `since ${clock.text}` : '';
}

/** "at 2:05 pm", or "on 9 Nov, 2:05 pm" when it was not today. */
export function whenWords(stamp: string | null | undefined, now: Date = new Date()): string {
  const clock = clockWords(stamp, now);
  return clock ? `${clock.today ? 'at' : 'on'} ${clock.text}` : '';
}

/** Why "Use this site's AI" is not offered or would not work, said to an app's owner. */
export const SITE_AI_REASON_WORDS: Record<string, string> = {
  site_ai_closed: 'This site does not let apps use its AI yet.',
  site_ai_unavailable: 'This site has no AI set up yet.',
  site_ai_gone: 'The computer this site\'s AI ran on is gone. An administrator has to choose one again.',
  ai_paused: 'The site\'s administrator has paused AI for apps.',
  model_unset: 'No picture model is chosen for this site\'s AI yet, so it cannot make pictures.',
  no_pictures: 'This site\'s server cannot prepare pictures for apps yet.',
};

/** What a job's kind is called to a person. */
export const AI_KIND_WORDS: Record<string, string> = { picture: 'Picture', edit: 'Picture edit', chat: 'Chat' };

/** What a status is called to a person. */
export function aiStatusWords(status: string, code: string | null): string {
  if (status === 'done') return 'Delivered';
  if (status === 'delivering') return 'Ready, being delivered';
  if (status === 'queued') return 'Waiting';
  if (status === 'sending' || status === 'running') return 'Working';
  if (status === 'cancelled') return 'Cancelled by the app';
  if (status === 'refused') {
    if (code === 'limit_reached') return 'Over a limit';
    if (code === 'busy') return 'Too many waiting';
    if (code === 'ai_off') return 'Refused: AI was off';
    if (code === 'ai_paused') return 'Refused: AI was paused';
    return 'Refused';
  }
  if (code === 'expired') return 'Ran out of time';
  return code === 'undelivered' ? 'Not taken by the app' : 'Failed';
}
