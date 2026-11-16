// What a hosted SoftN app may ask of FormLogic's own page, beyond its backend, its storage and its
// wallet: the three calls HostedAppFrame hands on (`host`) and NativeAppView answers. The app's frame
// is anyone's code in a sandbox, so each of these is FormLogic doing something for the app in its own
// page, where the person sees it and can stop it, and telling the app only how it went.
//   formlogicHost    { op: "abilities" }                 what this page can do for the app
//   formlogicDictate { op: "start" | "status" | "stop" | "cancel" }   listening, and the words
//   formlogicAddApp  { op: "offer", from, name? } | { op: "status" }  offering an app it made
// Every answer comes at once or well inside the frame's own deadline for a call (35 seconds): none
// waits on the person. An app asks again (`status`) to learn what they chose.

/** `dictate`: the owner lets people speak to the app and this browser has a microphone to ask for. `addApp`: the owner lets it offer the apps it makes. */
export interface HostAbilities { dictate: boolean; addApp: boolean }

/** Why listening ended with nothing heard. */
export type DictateEnding = 'denied' | 'no_microphone' | 'failed';

export type DictateAnswer =
  // start: the person is being asked (by FormLogic, or by the browser), or the microphone is open.
  | { state: 'asking' }
  | { state: 'listening'; level?: number }
  // start, refused: the owner has it off, the person or the browser said no, there is no microphone, or it is listening already.
  | { state: 'refused'; reason: 'off' | 'denied' | 'no_microphone' | 'busy' }
  // status: it stopped by itself (the limit, or the person stopped it in FormLogic's page) and holds what was said for `stop`.
  | { state: 'ended' }
  | { state: 'idle'; reason?: DictateEnding }
  // stop: the words, or why there are none.
  | { text: string; seconds: number }
  | { text: ''; reason: 'nothing' | 'limit' | 'failed' }
  | { cancelled: true };

export type AddAppAnswer =
  | { state: 'asking' | 'adding' | 'idle' }
  | { state: 'refused'; reason: 'off' | 'signed_out' | 'busy' | 'invalid' }
  // `updated`: the person chose to update the app of theirs that an earlier offer from the same address added.
  | { state: 'added'; name: string; updated?: true }
  | { state: 'declined'; reason: 'declined' }
  | { state: 'failed'; reason: 'invalid' | 'limit' | 'failed' };

/**
 * One GET of the offering app's own backend, as the person and as the app's own requests are sent
 * (HostedAppFrame makes it: the frame knows the engine and the visitor marker they carry). The
 * answer is `api.runNativeRequest`'s.
 */
export type AppReader = (path: string) => Promise<{ data?: { result?: { status?: number; body?: unknown } }; error?: string; status?: number }>;

export interface NativeHost {
  abilities: () => HostAbilities;
  /** Throws for an `op` it does not know, as every bridge does: the app hears the message. */
  dictate: (input: Record<string, unknown>) => Promise<DictateAnswer>;
  addApp: (input: Record<string, unknown>, read: AppReader) => AddAppAnswer;
  /** The frame that was asking has gone (closed, or opened again): the microphone is let go. */
  gone: () => void;
}
