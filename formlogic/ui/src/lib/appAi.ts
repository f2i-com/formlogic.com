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
  message: string;
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

export interface AppAiAdminView { settings: AppAiSiteSettings; apps: AppAiAdminApp[]; warnings: { code: string; message: string }[] }

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
