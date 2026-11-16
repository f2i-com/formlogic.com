import { useEffect, useRef } from 'react';

/**
 * FormLogic's own question, the first time an app asks to listen in this browser (its
 * `formlogicDictate` bridge: useNativeDictation). Over the app, in this page, which the app cannot
 * draw over or answer for: the browser's own question says only that this site wants the
 * microphone, never which app it is for. Allow is kept on this device; Not now, Escape or a press
 * beside it is a no for this once.
 *
 * The keyboard comes to the question itself, not to Allow: the person was pressing a button in the
 * app, and a key meant for it must not answer this.
 */
export function ListenQuestion({ appName, onAnswer }: { appName: string; onAnswer: (choice: 'allow' | 'deny') => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onAnswer('deny'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAnswer]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={(event) => { if (event.target === event.currentTarget) onAnswer('deny'); }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="native-listen-title" aria-describedby="native-listen-words" tabIndex={-1}
        className="w-full max-w-md rounded-t-2xl border border-slate-200 bg-white p-6 shadow-xl outline-none dark:border-slate-700 dark:bg-slate-900 sm:rounded-2xl" data-testid="listen-question">
        <h2 id="native-listen-title" className="text-lg font-semibold text-slate-900 dark:text-white">Let {appName} hear you?</h2>
        <p id="native-listen-words" className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">FormLogic listens while you speak and gives {appName} only the words. The sound is not kept.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="min-h-11 rounded-lg bg-primary-600 px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900" onClick={() => onAnswer('allow')}>Allow</button>
          <button type="button" className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-600 dark:text-slate-200" onClick={() => onAnswer('deny')}>Not now</button>
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">Your browser may ask about the microphone too. While it is on, FormLogic says so at the top of the app, where you can stop it.</p>
      </section>
    </div>
  );
}

/**
 * FormLogic's own sign that an app is listening, over the top of the app and outside its frame, so
 * the app can neither hide it nor draw one of its own in its place. `listening`: the microphone is
 * open; otherwise the browser is still opening it, or asking. Stop ends it either way, and the app
 * is handed what was said so far.
 */
export function ListeningBar({ appName, listening, onStop }: { appName: string; listening: boolean; onStop: () => void }) {
  return (
    <div role="group" aria-label="Microphone" data-testid="listening-bar"
      className="absolute inset-x-0 top-2 z-30 mx-auto flex w-fit max-w-[calc(100%-1rem)] items-center gap-2.5 rounded-full border border-slate-200 bg-white/95 py-1 pl-3.5 pr-1 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
      <span className="relative flex h-2.5 w-2.5 flex-none" aria-hidden="true">
        {listening && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-60 motion-reduce:animate-none" />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${listening ? 'bg-red-600' : 'bg-amber-500'}`} />
      </span>
      <p role="status" className="min-w-0 truncate text-sm font-medium text-slate-800 dark:text-slate-100">{listening ? `${appName} is listening` : `Opening the microphone for ${appName}`}</p>
      <button type="button" aria-label="Stop listening" onClick={onStop}
        className="inline-flex min-h-9 flex-none items-center rounded-full bg-slate-900 px-3.5 text-xs font-semibold text-white hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 max-sm:min-h-11 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 dark:focus-visible:ring-offset-slate-900">Stop</button>
    </div>
  );
}
