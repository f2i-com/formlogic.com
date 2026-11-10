import { Sparkles } from 'lucide-react';
import type { AiTestRun } from './useAiTest';

/**
 * What an app's owner can try for each way their test fails, after what the AI itself said. The
 * administrator's own test is no app's: the server words all of it (`advice`), and none of these is added.
 */
const FAILURE_HINTS: Record<string, string> = {
  model_disabled: 'Turn the model on in OAIY (Engines) and check its files have downloaded, or choose another model.',
  model_unknown: 'That computer has no model by this name. Choose one from its list.',
  timeout: 'The AI did not answer in time. Check the computer is on and OAIY is running.',
  expired: 'Nothing took the request in half an hour. Check the computer is on and OAIY is running.',
  engine_failed: 'OAIY could not make it. Look at OAIY on the computer for why.',
  ai_unavailable: 'The AI was switched off or changed while the test waited. Set it up again, then test.',
};

/**
 * A test as it goes (useAiTest): waiting, and what for; working; then its picture or reply with the
 * time it took, or why it failed. `computer` names the computer it waits for, where there is one.
 */
export function AiTestResult({ test, computer }: { test: AiTestRun; computer?: string }) {
  const result = test.result;
  const picture = test.kind !== 'chat';
  const waited = result?.waitedSeconds != null && result.waitedSeconds >= 3 ? ` ${result.waitedSeconds} s` : '';
  const state = !result || result.status === 'queued'
    ? (result?.waiting === 'worker' ? 'Waiting for the AI worker' : result?.waiting === 'computer' ? `Waiting for ${computer || 'the computer'} to come online…${waited}` : `Waiting for its turn…${waited}`)
    : result.status === 'running' ? `${picture ? 'Drawing' : 'Answering'}…${waited}`
    : result.status === 'done' ? 'It works' : 'It failed';
  const facts = result?.status === 'done'
    ? [result.seconds != null ? `${picture ? 'Made' : 'Answered'} in ${result.seconds.toFixed(1)} s` : '', result.model ? `with ${result.model}` : '', result.seed != null ? `seed ${result.seed}` : ''].filter(Boolean)
    : [];
  const advice = result?.status !== 'failed' ? '' : result.advice !== undefined ? result.advice : (result.code && FAILURE_HINTS[result.code]) || '';
  return (
    <div className="rounded-lg border border-gray-200 p-3 text-sm dark:border-slate-700" data-testid="ai-test" aria-live="polite">
      <p className="font-medium"><Sparkles className="mr-1 inline h-4 w-4" aria-hidden="true" />{picture ? 'Test picture' : 'Test chat'}: {state}</p>
      {result?.waiting === 'worker' && (
        <p className="mt-2 text-amber-800 dark:text-amber-200">
          {result.workerMessage || 'The AI worker isn\'t running.'} The test starts by itself once a fresh worker runs.
        </p>
      )}
      {result?.picture && <img src={result.picture} alt="The test picture" className="mt-2 max-h-64 rounded" />}
      {result?.text && <p className="mt-2 whitespace-pre-wrap">{result.text}</p>}
      {facts.length > 0 && <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">{facts.join(' · ')}</p>}
      {result?.status === 'failed' && (
        <p className="mt-2 text-red-600 dark:text-red-400" role="alert">
          {result.message || 'The AI gave no reason.'}{advice ? ` ${advice}` : ''}
        </p>
      )}
    </div>
  );
}
