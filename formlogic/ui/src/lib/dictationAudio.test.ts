// What a person said to a hosted app, as the speech server is sent it: brought to 16 kHz and
// written as a mono 16-bit RIFF/WAVE file, with the level a meter shows while they speak.
import { describe, expect, it } from 'vitest';
import {
  DICTATION_MAX_SECONDS, DICTATION_RATE, dictationWav, encodeWav, joinSamples, loudness, meterLevel, microphoneRefusal, resample, smoothLoudness,
} from './dictationAudio';

const text = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
/** A tone at `hertz`, `seconds` long, recorded at `rate`. */
const tone = (hertz: number, seconds: number, rate: number, loud = 0.5) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, index) => loud * Math.sin(2 * Math.PI * hertz * index / rate));

describe('joinSamples', () => {
  it('puts a recording\'s pieces end to end, in order', () => {
    expect([...joinSamples([Float32Array.of(1, 2), Float32Array.of(), Float32Array.of(3)])]).toEqual([1, 2, 3]);
    expect(joinSamples([]).length).toBe(0);
  });

  it('keeps no more than it is told to, cutting the piece that crosses the limit', () => {
    expect([...joinSamples([Float32Array.of(1, 2), Float32Array.of(3, 4), Float32Array.of(5)], 3)]).toEqual([1, 2, 3]);
  });
});

describe('resample', () => {
  it('brings 48 kHz down to 16 kHz as the mean of each three samples', () => {
    const out = resample(Float32Array.of(0, 0.3, 0.6, 1, 1, 1, -0.3, -0.6, -0.9), 48000, 16000);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[2]).toBeCloseTo(-0.6, 6);
  });

  it('gives a second of sound sixteen thousand samples, whatever rate it was recorded at', () => {
    for (const rate of [48000, 44100, 32000, 22050, 16000, 8000]) {
      expect(resample(new Float32Array(rate), rate, DICTATION_RATE).length, `${rate} Hz`).toBe(16000);
    }
    // And a length that does not divide evenly rounds to the nearest sample.
    expect(resample(new Float32Array(44100 + 7), 44100, 16000).length).toBe(Math.round((44100 + 7) * 16000 / 44100));
  });

  it('keeps a tone a tone: a 440 Hz note at 44.1 kHz is still one at 16 kHz, about as loud', () => {
    const out = resample(tone(440, 0.5, 44100), 44100, 16000);
    expect(loudness(out)).toBeCloseTo(0.5 / Math.SQRT2, 1);
    // It crosses zero twice a cycle: 440 cycles a second for half a second.
    let crossings = 0;
    for (let index = 1; index < out.length; index++) if ((out[index - 1] < 0) !== (out[index] < 0)) crossings++;
    expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(2);
  });

  it('draws a straight line between neighbours for a device slower than the server\'s rate', () => {
    const out = resample(Float32Array.of(0, 1, 0), 8000, 16000);
    expect([...out].map(value => Math.round(value * 100) / 100)).toEqual([0, 0.5, 1, 0.5, 0, 0]);
  });

  it('copies a recording already at the rate, and has nothing for no sound or no rate', () => {
    const samples = Float32Array.of(0.1, 0.2);
    const same = resample(samples, 16000, 16000);
    expect([...same]).toEqual([...samples]);
    expect(same).not.toBe(samples);
    expect(resample(new Float32Array(0), 48000, 16000).length).toBe(0);
    expect(resample(samples, 0, 16000).length).toBe(0);
  });
});

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header for one channel of 16-bit PCM at the rate given', () => {
    const wav = encodeWav(new Float32Array(160), 16000);
    const data = view(wav);
    expect(wav.length).toBe(44 + 320);
    expect(text(wav, 0, 4)).toBe('RIFF');
    expect(data.getUint32(4, true)).toBe(wav.length - 8);
    expect(text(wav, 8, 4)).toBe('WAVE');
    expect(text(wav, 12, 4)).toBe('fmt ');
    expect(data.getUint32(16, true), 'the fmt chunk is 16 bytes').toBe(16);
    expect(data.getUint16(20, true), 'PCM').toBe(1);
    expect(data.getUint16(22, true), 'mono').toBe(1);
    expect(data.getUint32(24, true), 'samples a second').toBe(16000);
    expect(data.getUint32(28, true), 'bytes a second').toBe(32000);
    expect(data.getUint16(32, true), 'bytes a sample').toBe(2);
    expect(data.getUint16(34, true), 'bits a sample').toBe(16);
    expect(text(wav, 36, 4)).toBe('data');
    expect(data.getUint32(40, true)).toBe(320);
  });

  it('writes each sample as a signed 16-bit number, low byte first, and holds one past the ends at the end', () => {
    const wav = encodeWav(Float32Array.of(0, 1, -1, 0.5, -0.5, 2, -2, Number.NaN), 16000);
    const data = view(wav);
    const samples = Array.from({ length: 8 }, (_, index) => data.getInt16(44 + index * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
    // Low byte first: 16384 is 0x4000.
    expect([wav[44 + 6], wav[44 + 7]]).toEqual([0x00, 0x40]);
  });

  it('is a header alone for no sound', () => {
    const wav = encodeWav(new Float32Array(0), 16000);
    expect(wav.length).toBe(44);
    expect(view(wav).getUint32(40, true)).toBe(0);
  });
});

describe('dictationWav', () => {
  it('makes a 16 kHz mono 16-bit file of the right length from pieces recorded at the device\'s rate', () => {
    // Two seconds at 48 kHz, as a script processor hands them over: 4,096 samples at a time.
    const whole = tone(220, 2, 48000);
    const pieces: Float32Array[] = [];
    for (let at = 0; at < whole.length; at += 4096) pieces.push(whole.subarray(at, at + 4096));
    const { wav, seconds } = dictationWav(pieces, 48000);
    expect(seconds).toBe(2);
    expect(wav.length).toBe(44 + 2 * 16000 * 2);
    const data = view(wav);
    expect(text(wav, 0, 4) + text(wav, 8, 4)).toBe('RIFFWAVE');
    expect(data.getUint32(24, true)).toBe(16000);
    expect(data.getUint16(22, true)).toBe(1);
    expect(data.getUint16(34, true)).toBe(16);
    expect(data.getUint32(40, true)).toBe(wav.length - 44);
    // And it is the tone, not silence.
    let peak = 0;
    for (let index = 0; index < 32000; index++) peak = Math.max(peak, Math.abs(data.getInt16(44 + index * 2, true)));
    expect(peak).toBeGreaterThan(12000);
  });

  it('holds a recording to its longest, whatever it was handed', () => {
    const rate = 8000;
    const { wav, seconds } = dictationWav([new Float32Array(rate * (DICTATION_MAX_SECONDS + 5))], rate);
    expect(seconds).toBe(DICTATION_MAX_SECONDS);
    expect(wav.length).toBe(44 + DICTATION_MAX_SECONDS * 16000 * 2);
  });

  it('is an empty file of no length for nothing recorded', () => {
    expect(dictationWav([], 48000)).toEqual({ wav: encodeWav(new Float32Array(0), 16000), seconds: 0 });
  });
});

describe('the level', () => {
  it('measures a piece of sound by its root mean square', () => {
    expect(loudness(new Float32Array(0))).toBe(0);
    expect(loudness(new Float32Array(100))).toBe(0);
    expect(loudness(Float32Array.of(0.5, -0.5, 0.5, -0.5))).toBeCloseTo(0.5, 6);
    expect(loudness(tone(300, 0.1, 48000, 1))).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('places it between 0 and 1 by its decibels', () => {
    expect(meterLevel(0)).toBe(0);
    expect(meterLevel(Number.NaN)).toBe(0);
    expect(meterLevel(0.001), '-60 dB and under is nothing').toBe(0);
    expect(meterLevel(0.0001)).toBe(0);
    expect(meterLevel(0.01), '-40 dB').toBeCloseTo(0.4, 3);
    expect(meterLevel(0.1), '-20 dB').toBeCloseTo(0.8, 3);
    expect(meterLevel(1), 'as loud as sound gets').toBe(1);
    expect(meterLevel(5)).toBe(1);
  });

  it('rises at once and falls a part at a time', () => {
    expect(smoothLoudness(0.1, 0.4)).toBe(0.4);
    const fell = smoothLoudness(0.4, 0);
    expect(fell).toBeGreaterThan(0);
    expect(fell).toBeLessThan(0.4);
    expect(smoothLoudness(fell, 0)).toBeLessThan(fell);
  });
});

describe('microphoneRefusal', () => {
  it('reads why the microphone did not open', () => {
    expect(microphoneRefusal(new DOMException('no', 'NotAllowedError'))).toBe('denied');
    expect(microphoneRefusal({ name: 'SecurityError' })).toBe('denied');
    expect(microphoneRefusal(new DOMException('none', 'NotFoundError'))).toBe('no_microphone');
    expect(microphoneRefusal(new DOMException('busy', 'NotReadableError'))).toBe('failed');
    expect(microphoneRefusal(new Error('This browser cannot record sound.'))).toBe('failed');
    expect(microphoneRefusal(null)).toBe('failed');
    expect(microphoneRefusal('NotAllowedError')).toBe('failed');
  });
});
