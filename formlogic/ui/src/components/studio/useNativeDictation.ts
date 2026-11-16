// Listening for a hosted app (its `formlogicDictate` bridge: HostedAppFrame hands the calls on,
// NativeAppView shows what this returns). One session at a time: the person is asked, the
// microphone is opened by this page, and what they say is sent to the site's speech server when
// the app asks for it. The app hears the words and nothing else, and learns how things stand only by
// asking: no call here waits on the person.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { DICTATION_MIN_SECONDS, microphoneRefusal } from '../../lib/dictationAudio';
import { canRecord, startRecording, type HeardAudio, type Recording } from '../../lib/dictationRecorder';
import type { DictateAnswer, DictateEnding } from '../../lib/nativeHost';
import { bytesToBase64 } from '../../lib/nativeHosting';

/**
 * A person's yes to an app that listens, kept on this device: they are asked by FormLogic the first
 * time an app asks in this browser, and not again. Not now is not kept: the next press asks again.
 * Keyed as the answer about files is (NativeAppView): by the app's id, and for a members' app by the
 * member too.
 */
const listenKey = (appId: string) => `formlogic:native-listen:v1:${appId}`;
function listenAllowed(appId: string): boolean {
  try { return localStorage.getItem(listenKey(appId)) === 'allow'; } catch { return false; }
}
function rememberListenAllowed(appId: string): void {
  try { localStorage.setItem(listenKey(appId), 'allow'); } catch { /* Asked again next time. */ }
}

/** How long `start` waits for a microphone that needs no asking, to answer `listening` rather than `asking`. */
const START_GRACE_MS = 300;
/** How long `stop` waits for the words: inside the frame's own deadline for a call (35 seconds). */
const STOP_ANSWER_MS = 28_000;

/**
 * `asking`: FormLogic's own question is open (`question`), or the browser's is. `ended`: the
 * recording stopped without the app (the limit, or the person stopped it here) and what was said is
 * held for the app's `stop`. `run` tells one session's late answers from the next one's.
 */
type Session =
  | { state: 'idle'; reason?: DictateEnding }
  | { state: 'asking'; run: number; question: boolean }
  | { state: 'listening'; run: number; recording: Recording }
  | { state: 'ended'; audio: HeardAudio | null };

/** What the page shows: FormLogic's question, that the microphone is being opened, that it is listening, or nothing. */
export type DictationView = 'question' | 'opening' | 'listening' | null;

/** `work` settled, or `ms` gone by, whichever is first. */
const within = (work: Promise<unknown>, ms: number) => new Promise<void>((resolve) => {
  const timer = window.setTimeout(resolve, ms);
  void work.finally(() => { window.clearTimeout(timer); resolve(); });
});

/** What a recording heard, with the microphone let go; nothing where it cannot be read. */
function heardBy(recording: Recording): HeardAudio | null {
  try { return recording.finish(); } catch { recording.close(); return null; }
}

/** What was said, as words: from the site's speech server, within the time `stop` has to answer. */
async function wordsOf(slug: string, audio: HeardAudio, visitor: boolean): Promise<DictateAnswer> {
  const controller = new AbortController();
  let timer = 0;
  try {
    const result = await Promise.race([
      api.listenNative(slug, bytesToBase64(audio.wav), controller.signal, visitor),
      new Promise<null>((resolve) => { timer = window.setTimeout(() => { controller.abort(); resolve(null); }, STOP_ANSWER_MS); }),
    ]);
    if (!result || result.error || !result.data) return { text: '', reason: result?.status === 429 ? 'limit' : 'failed' };
    const text = typeof result.data.text === 'string' ? result.data.text.trim() : '';
    if (!text) return { text: '', reason: 'nothing' };
    const seconds = result.data.seconds;
    return { text, seconds: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : Math.round(audio.seconds * 100) / 100 };
  } catch {
    return { text: '', reason: 'failed' };
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * `appId`: what the person's yes is kept under (null until the app has opened). `enabled`: the
 * app's owner lets people speak to it (the runtime GET's `project.listen`). `visitor`: the app's
 * requests carry FormLogic's visitor marker, and so does the recording sent for it.
 */
export function useNativeDictation({ slug, appId, enabled, visitor }: { slug: string; appId: string | null; enabled: boolean; visitor: boolean }) {
  const session = useRef<Session>({ state: 'idle' });
  const runs = useRef(0);
  const [view, setView] = useState<DictationView>(null);
  // Read when the app asks: the calls below are the same functions for as long as the page is open.
  const about = useRef({ slug, appId, enabled, visitor });
  useLayoutEffect(() => { about.current = { slug, appId, enabled, visitor }; }, [slug, appId, enabled, visitor]);

  const become = useCallback((next: Session) => {
    session.current = next;
    setView(next.state === 'asking' ? (next.question ? 'question' : 'opening') : next.state === 'listening' ? 'listening' : null);
  }, []);

  /** Opens the microphone for session `run`. The browser may ask the person first: settles once it has, never rejects. */
  const open = useCallback((run: number) => {
    become({ state: 'asking', run, question: false });
    const ownRun = (now: Session) => (now.state === 'asking' || now.state === 'listening') && now.run === run;
    return startRecording(() => {
      // The limit: it stops by itself and holds what was said for the app.
      const now = session.current;
      if (now.state === 'listening' && ownRun(now)) become({ state: 'ended', audio: heardBy(now.recording) });
    }).then((recording) => {
      // Stopped or cancelled while the browser asked: the microphone is let go as it opens.
      if (!ownRun(session.current)) { recording.close(); return; }
      become({ state: 'listening', run, recording });
    }, (reason: unknown) => {
      if (ownRun(session.current)) become({ state: 'idle', reason: microphoneRefusal(reason) });
    });
  }, [become]);

  /** The app's call. An `op` it does not know is thrown, and the app hears the message. */
  const call = useCallback(async (input: Record<string, unknown>): Promise<DictateAnswer> => {
    const { slug, appId, enabled, visitor } = about.current;
    const now = session.current;
    switch (input.op) {
      case 'start': {
        if (!enabled || !appId) return { state: 'refused', reason: 'off' };
        if (!canRecord()) return { state: 'refused', reason: 'no_microphone' };
        if (now.state === 'asking' || now.state === 'listening') return { state: 'refused', reason: 'busy' };
        // (What an ended session still held is let go: the app asked to start over without taking it.)
        const run = ++runs.current;
        if (!listenAllowed(appId)) {
          become({ state: 'asking', run, question: true });
          return { state: 'asking' };
        }
        // A microphone the browser opens without asking is open in a moment, and the app is told so.
        // One it asks about is the person's to answer in their own time: the app asks again.
        await within(open(run), START_GRACE_MS);
        const after = session.current;
        if (after.state === 'listening' && after.run === run) return { state: 'listening' };
        if (after.state === 'idle' && (after.reason === 'denied' || after.reason === 'no_microphone')) return { state: 'refused', reason: after.reason };
        return { state: 'asking' };
      }
      case 'status': {
        if (now.state === 'listening') return { state: 'listening', level: now.recording.level() };
        if (now.state === 'idle') return now.reason ? { state: 'idle', reason: now.reason } : { state: 'idle' };
        return { state: now.state };
      }
      case 'stop': {
        if (now.state === 'idle') return { text: '', reason: now.reason === 'failed' ? 'failed' : 'nothing' };
        const audio = now.state === 'listening' ? heardBy(now.recording) : now.state === 'ended' ? now.audio : null;
        become({ state: 'idle' });
        if (!audio || audio.seconds < DICTATION_MIN_SECONDS) return { text: '', reason: 'nothing' };
        return wordsOf(slug, audio, visitor);
      }
      case 'cancel': {
        if (now.state === 'listening') now.recording.close();
        become({ state: 'idle' });
        return { cancelled: true };
      }
      default:
        throw new Error('Unknown dictation action.');
    }
  }, [become, open]);

  /** The person's answer to FormLogic's own question. Not now ends the session, and is not kept. */
  const answer = useCallback((choice: 'allow' | 'deny') => {
    const now = session.current;
    if (now.state !== 'asking' || !now.question) return;
    if (choice === 'deny') { become({ state: 'idle', reason: 'denied' }); return; }
    const { appId } = about.current;
    if (appId) rememberListenAllowed(appId);
    void open(now.run);
  }, [become, open]);

  /** FormLogic's own Stop: the session ends as the limit ends it, holding what was said for the app. */
  const halt = useCallback(() => {
    const now = session.current;
    if (now.state === 'listening') become({ state: 'ended', audio: heardBy(now.recording) });
    else if (now.state === 'asking') become({ state: 'ended', audio: null });
  }, [become]);

  /** Everything let go and forgotten: the frame that asked is gone, or the page is. */
  const release = useCallback(() => {
    const now = session.current;
    if (now.state === 'listening') now.recording.close();
    if (now.state !== 'idle' || now.reason) become({ state: 'idle' });
  }, [become]);
  // Another app or another person in this page, or the page going: nothing is kept open for them.
  useEffect(() => release, [slug, appId, release]);

  return { view, call, answer, halt, release };
}
