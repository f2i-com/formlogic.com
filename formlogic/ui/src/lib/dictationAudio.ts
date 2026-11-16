// The sound of someone speaking to a hosted app, as the site's speech server takes it (the
// `formlogicDictate` bridge: lib/dictationRecorder opens the microphone, NativeAppView's page asks
// and shows that it is listening). A browser records at its own rate, 44,100 or 48,000 Hz as a
// rule, in numbers from -1 to 1; the server is sent one RIFF/WAVE file at 16,000 Hz, mono, 16-bit.
// Nothing here touches the microphone or the page, so all of it is tested as it is.

/** The rate the speech server is sent, in samples a second. */
export const DICTATION_RATE = 16000;
/** The longest one recording runs: it stops by itself here, and what was said is kept for the app. */
export const DICTATION_MAX_SECONDS = 60;
/** Less than this is a press with nothing said: it is not sent. */
export const DICTATION_MIN_SECONDS = 0.3;

/** A recording's pieces as one run of samples, in order, and no more than `most` of them. */
export function joinSamples(pieces: readonly Float32Array[], most = Number.POSITIVE_INFINITY): Float32Array {
  const length = Math.min(most, pieces.reduce((sum, piece) => sum + piece.length, 0));
  const joined = new Float32Array(length);
  let at = 0;
  for (const piece of pieces) {
    if (at >= length) break;
    const part = piece.length > length - at ? piece.subarray(0, length - at) : piece;
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/**
 * A recording at another rate. Downward, each sample is the mean of the ones it stands for: taking
 * every third sample instead would fold what is too high for the new rate back into it as noise.
 * Upward (a device slower than the server's rate, which is rare), a straight line between neighbours.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (!(from > 0) || !(to > 0) || samples.length === 0) return new Float32Array(0);
  if (from === to) return samples.slice();
  const length = Math.round(samples.length * to / from);
  const out = new Float32Array(length);
  const step = from / to;
  if (step > 1) {
    for (let index = 0; index < length; index++) {
      const start = Math.floor(index * step);
      const end = Math.min(samples.length, Math.max(start + 1, Math.floor((index + 1) * step)));
      let sum = 0;
      for (let source = start; source < end; source++) sum += samples[source];
      out[index] = sum / (end - start);
    }
    return out;
  }
  for (let index = 0; index < length; index++) {
    const at = index * step;
    const low = Math.min(samples.length - 1, Math.floor(at));
    const high = Math.min(samples.length - 1, low + 1);
    out[index] = samples[low] + (samples[high] - samples[low]) * (at - low);
  }
  return out;
}

/**
 * Samples as a RIFF/WAVE file: one channel of 16-bit PCM at `rate`, the 44-byte header and then the
 * samples, low byte first. A sample past -1 or 1 is held at it, not wrapped round to the other side.
 */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const data = samples.length * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const word = (at: number, text: string) => { for (let index = 0; index < text.length; index++) view.setUint8(at + index, text.charCodeAt(index)); };
  word(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  word(8, 'WAVE');
  word(12, 'fmt ');
  view.setUint32(16, 16, true);
  // PCM, one channel.
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  // Bytes a second, bytes a sample, bits a sample.
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  word(36, 'data');
  view.setUint32(40, data, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0));
    view.setInt16(44 + index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
  }
  return bytes;
}

/** A recording's pieces, taken at `rate`, as the file the speech server is sent, and how long it runs. */
export function dictationWav(pieces: readonly Float32Array[], rate: number): { wav: Uint8Array; seconds: number } {
  const samples = resample(joinSamples(pieces, Math.floor(rate * DICTATION_MAX_SECONDS)), rate, DICTATION_RATE);
  return { wav: encodeWav(samples, DICTATION_RATE), seconds: samples.length / DICTATION_RATE };
}

/** How loud a piece of sound is: the root mean square of its samples, 0 for silence. */
export function loudness(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index++) sum += samples[index] * samples[index];
  return Math.sqrt(sum / samples.length);
}

/** The loudness a meter goes by next: up to a louder piece at once, down from a quieter one a part at a time, so it does not flicker between words. */
export function smoothLoudness(shown: number, next: number): number {
  return next >= shown ? next : shown + (next - shown) * 0.35;
}

/**
 * A loudness as a level from 0 to 1. Speech sits within a few hundredths of silence, so it is placed
 * by its decibels: -60 dB and under is 0, -10 dB (speech close to a microphone) and over is 1.
 */
export function meterLevel(rms: number): number {
  if (!(rms > 0)) return 0;
  const level = (20 * Math.log10(rms) + 60) / 50;
  return Math.round(Math.min(1, Math.max(0, level)) * 1000) / 1000;
}

/**
 * Why the microphone did not open, as an app is told: the person or the browser said no (`denied`),
 * there is none (`no_microphone`), or anything else (`failed`: in use by another program, as a rule).
 */
export function microphoneRefusal(reason: unknown): 'denied' | 'no_microphone' | 'failed' {
  const name = reason !== null && typeof reason === 'object' && 'name' in reason ? String((reason as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no_microphone';
  return 'failed';
}
