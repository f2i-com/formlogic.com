// @vitest-environment jsdom
// The microphone, opened by FormLogic's own page for an app that listens: what it records, and that
// it is always let go again (the tracks stopped, the audio context closed), however the recording ends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DICTATION_MAX_SECONDS } from './dictationAudio';
import { canRecord, startRecording } from './dictationRecorder';

type Processor = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onaudioprocess: ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null };
const made = { contexts: [] as Array<{ sampleRate: number; close: ReturnType<typeof vi.fn>; processor: Processor; source: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } }> };
const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
const getUserMedia = vi.fn();
let contextFails = false;

beforeEach(() => {
  made.contexts.length = 0;
  contextFails = false;
  for (const track of tracks) track.stop.mockClear();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => tracks });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', class {
    sampleRate = 48000;
    destination = {};
    close = vi.fn(async () => undefined);
    resume = vi.fn(async () => undefined);
    processor: Processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
    source = { connect: vi.fn(), disconnect: vi.fn() };
    constructor() {
      if (contextFails) throw new Error('No audio device.');
      made.contexts.push(this);
    }
    createMediaStreamSource() { return this.source; }
    createScriptProcessor() { return this.processor; }
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The device handing over `samples` of sound, as loud as `value`. */
const hear = (samples: number, value = 0.25) => made.contexts[0].processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(samples).fill(value) } });
const released = () => tracks.every(track => track.stop.mock.calls.length === 1) && made.contexts[0].close.mock.calls.length === 1;

describe('canRecord', () => {
  it('is whether the browser has a microphone to ask for', () => {
    expect(canRecord()).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(canRecord()).toBe(false);
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(canRecord()).toBe(false);
  });
});

describe('startRecording', () => {
  it('asks for the microphone alone, with the echo and the room\'s noise taken out', async () => {
    await startRecording(() => {});
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } });
    const [context] = made.contexts;
    expect(context.source.connect).toHaveBeenCalledWith(context.processor);
    expect(context.processor.connect).toHaveBeenCalledTimes(1);
  });

  it('hands over what was said as a 16 kHz mono 16-bit WAV, and lets the microphone go', async () => {
    const recording = await startRecording(() => {});
    // A second and a half at the device's 48 kHz.
    for (let piece = 0; piece < 18; piece++) hear(4000);
    expect(recording.level()).toBeGreaterThan(0.5);
    expect(released()).toBe(false);
    const { wav, seconds } = recording.finish();
    expect(seconds).toBe(1.5);
    expect(wav.length).toBe(44 + 1.5 * 16000 * 2);
    expect(String.fromCharCode(...wav.subarray(0, 4), ...wav.subarray(8, 12))).toBe('RIFFWAVE');
    const data = new DataView(wav.buffer);
    expect(data.getUint32(24, true)).toBe(16000);
    expect(data.getInt16(44 + 2000, true)).toBe(Math.round(0.25 * 0x7fff));
    expect(released()).toBe(true);
    expect(made.contexts[0].processor.onaudioprocess).toBeNull();
    expect(recording.level(), 'nothing is heard once it is let go').toBe(0);
  });

  it('copies each piece: the device fills the same buffer again', async () => {
    const recording = await startRecording(() => {});
    const buffer = new Float32Array(4800).fill(0.5);
    made.contexts[0].processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => buffer } });
    buffer.fill(-0.5);
    made.contexts[0].processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => buffer } });
    const data = new DataView(recording.finish().wav.buffer);
    expect(data.getInt16(44 + 2 * 100, true)).toBeGreaterThan(16000);
    expect(data.getInt16(44 + 2 * 3000, true)).toBeLessThan(-16000);
  });

  it('lets the microphone go, and what was said with it, when it is closed', async () => {
    const recording = await startRecording(() => {});
    hear(48000);
    recording.close();
    expect(released()).toBe(true);
    // Closed twice, or finished after: nothing more is stopped, and nothing is handed over twice.
    recording.close();
    recording.finish();
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(made.contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it('says when it has run its longest, and keeps no more than that', async () => {
    const onLimit = vi.fn();
    const recording = await startRecording(onLimit);
    for (let second = 0; second < DICTATION_MAX_SECONDS - 1; second++) hear(48000);
    expect(onLimit).not.toHaveBeenCalled();
    hear(48000);
    expect(onLimit).toHaveBeenCalledTimes(1);
    // What the device hands over after is not kept.
    hear(48000);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(recording.finish().seconds).toBe(DICTATION_MAX_SECONDS);
  });

  it('ends by the clock where the device hands over nothing', async () => {
    vi.useFakeTimers();
    const onLimit = vi.fn();
    const recording = await startRecording(onLimit);
    vi.advanceTimersByTime(DICTATION_MAX_SECONDS * 1000);
    expect(onLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(recording.finish().seconds).toBe(0);
    // And not at all once it is let go.
    const later = vi.fn();
    (await startRecording(later)).close();
    vi.advanceTimersByTime((DICTATION_MAX_SECONDS + 2) * 1000);
    expect(later).not.toHaveBeenCalled();
  });

  it('fails as the browser does when the microphone is refused, with nothing open', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(startRecording(() => {})).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(made.contexts).toHaveLength(0);
  });

  it('lets the microphone go when the sound cannot be read from it', async () => {
    contextFails = true;
    await expect(startRecording(() => {})).rejects.toThrow('No audio device.');
    expect(tracks.every(track => track.stop.mock.calls.length === 1)).toBe(true);
  });
});
