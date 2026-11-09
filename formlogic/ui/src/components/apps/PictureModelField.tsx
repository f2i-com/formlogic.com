import type { AiModel } from '../../lib/appAi';

const field = 'block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
const link = 'font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-300';

/**
 * The picture model for an app's AI, or the site's: a pick-list of the computer's own picture models
 * where it listed them (useModelList), and a box to type the name in where it could not: it is
 * offline, it did not answer, or the AI is not on a computer at all.
 */
export function PictureModelField({ id, models, listing, error, noList, value, onChange, onRetry }: {
  id: string;
  /** The computer's picture models, or null when there is no list. */
  models: AiModel[] | null;
  listing: boolean;
  error: string | null;
  /** Why no list is asked for: the computer is offline, or the AI is a provider and not a computer. */
  noList?: 'offline' | 'provider' | null;
  value: string;
  onChange: (value: string) => void;
  onRetry?: () => void;
}) {
  const listed = models !== null && models.length > 0;
  const unlisted = listed && value !== '' && !models.some((model) => model.id === value);
  return (
    <div className="space-y-1">
      {listed ? (
        <select id={id} className={field} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">None: no pictures</option>
          {/* Its name, and the id it is saved and reported by where they differ. */}
          {models.map((model) => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id}</option>)}
          {unlisted && <option value={value}>{value} (not on the computer&apos;s list)</option>}
        </select>
      ) : (
        <input id={id} className={field} value={value} placeholder="flux-3-image-klein" autoComplete="off" spellCheck={false} onChange={(event) => onChange(event.target.value.trim())} />
      )}
      <p className="text-xs text-gray-500 dark:text-slate-400" role={error ? 'alert' : undefined}>
        {listing ? 'Asking the computer for its picture models…'
          : unlisted ? `The computer does not list ${value}. Pictures fail until it has it.`
          : listed ? 'These are the picture models switched on in OAIY on that computer.'
          : models !== null ? <>The computer lists no picture model. Turn one on in OAIY (Engines). {onRetry && <button type="button" className={link} onClick={onRetry}>Check again</button>}</>
          : error ? <>The computer did not list its models ({error}). Type the model&apos;s name, or {onRetry && <button type="button" className={link} onClick={onRetry}>try the list again</button>}.</>
          : noList === 'offline' ? 'The computer is offline, so it cannot list its models now. Type the model\'s name exactly as OAIY shows it.'
          : noList === 'provider' ? 'Type the picture model\'s name exactly as your provider names it.'
          : 'Type the model\'s name exactly as OAIY shows it.'}
      </p>
    </div>
  );
}
