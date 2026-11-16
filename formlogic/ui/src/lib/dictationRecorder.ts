// The microphone, opened by FormLogic's own page for a hosted app that listens (the
// `formlogicDictate` bridge). The app's frame is sandboxed and can have no microphone; this page
// opens it, shows that it is listening (NativeAppView) and gives the app only the words. What is
// recorded is held in memory until it is sent to the speech server or let go, and nowhere else.
import { DICTATION_MAX_SECONDS, dictationWav, loudness, meterLevel, smoothLoudness } from './dictationAudio';

/** What was said, as the speech server takes it: a 16 kHz mono 16-bit WAV, and how long it runs. */
export interface HeardAudio { wav: Uint8Array; seconds: number }

/** A recording under way. The microphone stays open until `finish` or `close`, whichever comes first. */
export interface Recording {
  /** How loud the person is now, from 0 to 1. */
  level: () => number;
  /** Stops, lets the microphone go and hands over what was said. */
  finish: () => HeardAudio;
  /** Stops and lets the microphone go; what was said is let go with it. */
  close: () => void;
}

/** Whether this browser has a microphone to ask for at all. */
export function canRecord(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * Opens the microphone and records from it. The browser asks the person the first time, so this
 * can wait on them: a caller that has stopped waiting closes the recording it is handed. `onLimit`
 * is told once the recording has run its longest (DICTATION_MAX_SECONDS); the caller finishes it.
 * Rejects as getUserMedia does (lib/dictationAudio's microphoneRefusal reads why), with nothing left open.
 */
export async function startRecording(onLimit: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let timer = 0;
  let open = true;
  const release = () => {
    if (!open) return;
    open = false;
    window.clearTimeout(timer);
    if (processor) processor.onaudioprocess = null;
    try { source?.disconnect(); processor?.disconnect(); } catch { /* Already apart. */ }
    // The browser's own sign that a page is listening goes out with the tracks.
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => { /* Closed already. */ });
  };
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) throw new Error('This browser cannot record sound.');
    // At the device's own rate: a context at another rate is refused a microphone by some browsers.
    // What it records is brought to the server's rate once, at the end (dictationWav).
    const audio = new Context();
    context = audio;
    const rate = audio.sampleRate;
    const most = Math.floor(rate * DICTATION_MAX_SECONDS);
    const pieces: Float32Array[] = [];
    let held = 0;
    let rms = 0;
    source = audio.createMediaStreamSource(stream);
    // A script processor, not a worklet: a worklet is a second script file to serve and allow, and
    // this is a minute of speech at most. It is handed each piece as the device records it.
    processor = audio.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!open || held >= most) return;
      const heard = event.inputBuffer.getChannelData(0);
      rms = smoothLoudness(rms, loudness(heard));
      // Copied: the browser fills the same buffer again for the next piece.
      const piece = heard.slice(0, Math.min(heard.length, most - held));
      pieces.push(piece);
      held += piece.length;
      if (held >= most) onLimit();
    };
    source.connect(processor);
    // A processor runs only while it leads somewhere. It writes nothing, so nothing is played.
    processor.connect(audio.destination);
    void audio.resume?.().catch(() => { /* It records once the page is used, or the timer below ends it. */ });
    // Should the device hand over nothing (a context the browser keeps suspended), it still ends.
    timer = window.setTimeout(onLimit, (DICTATION_MAX_SECONDS + 1) * 1000);
    return {
      level: () => open ? meterLevel(rms) : 0,
      finish: () => { release(); return dictationWav(pieces, rate); },
      close: release,
    };
  } catch (reason) {
    release();
    throw reason;
  }
}
