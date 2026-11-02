import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import type { CameraCheckState } from '../../types/app';

type Phase = 'intro' | 'starting' | 'capturing' | 'sending' | 'checking' | 'result';

/** The arrow for a step's hint. The preview is a mirror, so "left" points the way the person turns. */
const ARROW: Record<string, string> = { center: '●', left: '←', right: '→', up: '↑', down: '↓' };
/** One picture, as the server takes it: 360 pixels wide at most, under 40 KB. */
const MAX_WIDTH = 360;
const MAX_BYTES = 40_000;
/** Outcomes the site itself knows: a check that did not run, or was stopped, may be tried again. */
const SITE_RETRY = ['unavailable', 'cancelled'];
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const dataUrlBytes = (url: string) => Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);

/** One picture from the camera, as taken (not mirrored), as a JPEG data URL. */
function captureFrame(video: HTMLVideoElement): string {
  const width = Math.min(MAX_WIDTH, video.videoWidth || MAX_WIDTH);
  const height = Math.round((video.videoHeight || width * 0.75) * width / (video.videoWidth || MAX_WIDTH));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
  let quality = 0.85;
  let url = canvas.toDataURL('image/jpeg', quality);
  while (dataUrlBytes(url) > MAX_BYTES && quality > 0.35) {
    quality -= 0.1;
    url = canvas.toDataURL('image/jpeg', quality);
  }
  return url;
}

/**
 * The camera check, in the site's own page: a plugin's frame cannot have the camera, so a plugin
 * that uses it hands the member here. The member agrees, the camera shows them a mirror, and each
 * step the plugin asked for is shown in its words, with a countdown, and one picture taken. The
 * camera stops as soon as the last is taken; the pictures go to the server, which seals them to the
 * site's OAIY, and the page asks where it stands until the plugin has decided. Nothing here knows
 * what the plugin checks. `mode` trial: the administrator on themselves, shown what the model said.
 */
export function CameraCheckPanel({ start, mode = 'member', pluginName, onPassed, onClose }: {
  start: () => Promise<{ data?: CameraCheckState; error?: string }>;
  mode?: 'member' | 'trial';
  pluginName: string;
  onPassed?: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('intro');
  const [check, setCheck] = useState<CameraCheckState | null>(null);
  const [step, setStep] = useState(0);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);
  const unsent = useRef<string | null>(null);

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopCamera();
      // Left before sending: the started check is ended, and was never a try.
      if (unsent.current) void api.cancelCameraCheck(unsent.current);
    };
  }, [stopCamera]);

  const poll = async (id: string, until: number) => {
    setPhase('checking');
    while (alive.current) {
      await sleep(2500);
      if (!alive.current) return;
      const result = await api.getCameraCheck(id);
      if (result.data && result.data.status === 'done') {
        setCheck(result.data);
        setPhase('result');
        if (result.data.outcome === 'passed' && mode === 'member') onPassed?.();
        return;
      }
      if (Date.now() > until) {
        setError('The check is taking too long. Try again later.');
        setPhase('result');
        return;
      }
    }
  };

  const begin = async () => {
    setError(null);
    setCheck(null);
    setPhase('starting');
    const started = await start();
    if (!alive.current) return;
    if (started.error || !started.data?.steps) {
      setError(started.error ?? 'The camera check could not start.');
      setPhase('result');
      return;
    }
    const current = started.data;
    const steps = current.steps ?? [];
    unsent.current = current.id;
    setCheck(current);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch {
      setError('The camera could not be opened. Allow this site to use it, and try again.');
      setPhase('result');
      return;
    }
    if (!alive.current || !video.current) { stopCamera(); return; }
    video.current.srcObject = stream.current;
    await video.current.play().catch(() => undefined);
    setPhase('capturing');
    await sleep(1200);
    const frames: string[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (!alive.current || !video.current) { stopCamera(); return; }
      setStep(i);
      for (let n = 3; n > 0; n -= 1) {
        setCount(n);
        await sleep(800);
      }
      setCount(0);
      frames.push(captureFrame(video.current));
      await sleep(300);
    }
    stopCamera();
    setPhase('sending');
    const sent = await api.sendCameraCheckPictures(current.id, frames);
    unsent.current = null;
    if (!alive.current) return;
    if (sent.error || !sent.data) {
      setError(sent.error ?? 'The pictures could not be sent.');
      setPhase('result');
      return;
    }
    setCheck(sent.data);
    if (sent.data.status === 'done') { setPhase('result'); return; }
    await poll(current.id, Date.parse(current.expiresAt.replace(' ', 'T') + 'Z') || Date.now() + 660_000);
  };

  const steps = check?.steps ?? [];
  const asked = steps[step];
  const outcome = check?.outcome ?? null;
  const triesLeft = check?.attemptsLeft ?? 1;
  // A plugin's own outcomes may be tried again while tries are left, but for its last word on it.
  const canRetry = !!error || (outcome !== null && outcome !== 'passed' && outcome !== 'not_confirmed' && (SITE_RETRY.includes(outcome) || triesLeft > 0));

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="camera-check-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id="camera-check-title" className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
            <Camera className="h-5 w-5" aria-hidden="true" />{mode === 'trial' ? `Try ${pluginName}'s camera check` : 'Check with your camera'}
          </h2>
          <button type="button" aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-800" onClick={onClose}>
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className={phase === 'capturing' || phase === 'starting' ? 'relative mb-4 overflow-hidden rounded-xl bg-black' : 'hidden'}>
          <video ref={video} muted playsInline className="aspect-[4/3] w-full -scale-x-100 object-cover" />
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-3/4 w-1/2 rounded-[50%] border-4 border-white/70" />
          </div>
          {phase === 'capturing' && asked && (
            <div className="absolute inset-x-0 bottom-0 bg-black/60 p-3 text-center text-white">
              {asked.hint && <p className="text-3xl leading-none" aria-hidden="true">{ARROW[asked.hint]}</p>}
              <p className="mt-1 text-base font-medium">{asked.say}</p>
              <p className="text-sm text-white/80">{count > 0 ? `Picture in ${count}` : 'Hold still'}</p>
            </div>
          )}
        </div>
        <p role="status" aria-live="polite" className="sr-only">{phase === 'capturing' && asked ? `${asked.say}. Step ${step + 1} of ${steps.length}.` : ''}</p>

        {phase === 'intro' && (
          <div className="space-y-3 text-sm text-gray-600 dark:text-slate-300">
            <p>This takes about 20 seconds. {pluginName} asks you to look at the camera and move a few ways, and a picture is taken at each step.</p>
            <p>The pictures go to an AI on the site administrator's own computer, which describes them for {pluginName} to decide. They are not kept: only the result is. {pluginName} never sees them.</p>
            <p>Use good light, with only you in view.</p>
            <Button className="w-full" onClick={() => void begin()}>Start</Button>
          </div>
        )}
        {phase === 'starting' && <p role="status" className="text-sm text-gray-500">Opening the camera…</p>}
        {phase === 'sending' && <p role="status" className="text-sm text-gray-500">Sending the pictures…</p>}
        {phase === 'checking' && <p role="status" className="text-sm text-gray-500">Checking… This can take a minute.</p>}
        {phase === 'result' && (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-gray-900 dark:text-white">{error ?? check?.message ?? 'The check ended.'}</p>
            {check?.attemptsLeft !== null && check?.attemptsLeft !== undefined && outcome !== 'passed' && (
              <p className="text-xs text-gray-500 dark:text-slate-400">Tries left today: {check.attemptsLeft}</p>
            )}
            {mode === 'trial' && check?.answer && (
              <details open className="rounded-lg bg-gray-50 p-3 text-xs dark:bg-slate-800">
                <summary className="cursor-pointer font-medium">What the model answered, and what {pluginName} decided</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(check.answer, null, 2)}</pre>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              {canRetry && <Button onClick={() => void begin()}>Try again</Button>}
              <Button variant="outline" onClick={onClose}>{outcome === 'passed' && mode === 'member' ? 'Continue' : 'Close'}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
