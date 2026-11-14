import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AiModel, AppAiTestResult } from '../../lib/appAi';

/** A test of an app's AI, or of the site's: a real small picture or chat, followed until it ends. */
export interface AiTestRun { kind: 'picture' | 'chat'; id: string; result: AppAiTestResult | null }

type Answer<T> = { data?: T; error?: string };

/**
 * Start a test and follow it: `start` queues it and answers its id, `read` says how it is getting on.
 * It is asked again every two seconds until it is done or has failed; `onFinished` hears the end.
 */
export function useAiTest(
  start: (kind: 'picture' | 'chat') => Promise<Answer<{ jobId: string }>>,
  read: (jobId: string) => Promise<Answer<AppAiTestResult>>,
  onFinished?: (result: AppAiTestResult) => void,
) {
  const [test, setTest] = useState<AiTestRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const calls = useRef({ start, read, onFinished });
  useLayoutEffect(() => { calls.current = { start, read, onFinished }; });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const run = useCallback(async (kind: 'picture' | 'chat') => {
    if (timer.current) clearTimeout(timer.current);
    setError(null);
    setStarting(true);
    const started = await calls.current.start(kind);
    setStarting(false);
    if (started.error || !started.data) { setError(started.error ?? 'The test could not start.'); return; }
    const id = started.data.jobId;
    setTest({ kind, id, result: null });
    const follow = async () => {
      const answer = await calls.current.read(id);
      const result = answer.data;
      if (result) setTest((current) => (current && current.id === id ? { ...current, result } : current));
      if (result && (result.status === 'done' || result.status === 'failed')) { calls.current.onFinished?.(result); return; }
      timer.current = setTimeout(() => void follow(), 2000);
    };
    timer.current = setTimeout(() => void follow(), 1500);
  }, []);

  const running = starting || (test !== null && (test.result === null || test.result.status === 'queued' || test.result.status === 'running'));
  return { test, error, run, running };
}

/**
 * A computer linked with a one-time code shows among the linked computers once OAIY has started on it
 * and published its key. After `start`, `reload` is called every few seconds until `count` (how many
 * computers are listed) grows, for three minutes.
 */
export function useLinkWatch(count: number, reload: () => void | Promise<void>) {
  const [watch, setWatch] = useState<{ until: number; count: number } | null>(null);
  const latest = useRef({ count, reload });
  useLayoutEffect(() => { latest.current = { count, reload }; });
  useEffect(() => {
    if (!watch) return;
    const timer = setInterval(() => {
      if (Date.now() > watch.until || latest.current.count > watch.count) { setWatch(null); return; }
      void latest.current.reload();
    }, 4000);
    return () => clearInterval(timer);
  }, [watch]);
  const start = useCallback(() => {
    setWatch({ until: Date.now() + 180_000, count: latest.current.count });
    void latest.current.reload();
  }, []);
  return { watching: watch !== null, start };
}

/**
 * A computer's models, asked of it now. `key` names what is asked (a computer and a provider); null
 * asks nothing (the computer is offline, or none is chosen). Asked again when the key changes, or on
 * `retry`. `models` is null until it has answered, and when it did not; `listing` is true meanwhile.
 *
 * `list` asks the computer and reads its answer back until it comes (the API's followListing: a
 * read every 750 ms for up to 22 seconds, no request waiting on the computer). It is given a signal
 * that is aborted once its answer is not wanted (another key, a retry, or the page closed), so a
 * list asked for nobody stops being read.
 */
export function useModelList(key: string | null, list: (signal: AbortSignal) => Promise<Answer<{ models: AiModel[] }>>) {
  const [attempt, setAttempt] = useState(0);
  const [listed, setListed] = useState<{ key: string; models: AiModel[] | null; error: string | null } | null>(null);
  const call = useRef(list);
  useLayoutEffect(() => { call.current = list; });
  const wanted = key === null ? null : `${key}#${attempt}`;
  useEffect(() => {
    if (wanted === null) return;
    const unwanted = new AbortController();
    void call.current(unwanted.signal).then((result) => {
      if (unwanted.signal.aborted) return;
      setListed({ key: wanted, models: result.data?.models ?? null, error: result.data ? null : result.error ?? 'The computer did not list its models.' });
    });
    // The page closing or reloading ends no effect: the listing is let go then too (its letGo is sent with keepalive,
    // which outlives the page), or it would hold one of the owner's places on the computer until its time ran out.
    const leaving = () => unwanted.abort();
    window.addEventListener('pagehide', leaving);
    return () => {
      window.removeEventListener('pagehide', leaving);
      unwanted.abort();
    };
  }, [wanted]);
  const current = wanted !== null && listed?.key === wanted ? listed : null;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { models: current?.models ?? null, error: current?.error ?? null, listing: wanted !== null && current === null, retry };
}
