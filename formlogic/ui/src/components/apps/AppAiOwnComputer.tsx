import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { suggestedPictureModel, type AppAiOwnChoice, type AppAiOwnComputer as OwnComputer, type AppAiView } from '../../lib/appAi';
import { ConnectOaiyServer } from '../desktop/ConnectOaiyServer';
import { PictureModelField } from './PictureModelField';
import { useLinkWatch, useModelList } from './useAiTest';

const ENGINE = 'oaiy-engine';

/**
 * "Use my OAIY" (AppAiPanel): one of the owner's own linked computers, pinned to the key it has
 * published, and the picture model it draws with, picked from the list the computer gives now. With
 * no computer linked yet, one links right here with a one-time code. Its chat is answered by the
 * model chosen in OAIY. `onChange` hears a complete choice, or null while it is not one.
 */
export function AppAiOwnComputer({ appId, computers, current, wantsPictures, onChange, onLinked }: {
  appId: string;
  computers: NonNullable<AppAiView['computers']>;
  current: OwnComputer | null;
  wantsPictures: boolean;
  onChange: (choice: AppAiOwnChoice | null) => void;
  /** Read the app's AI again: a computer was linked, or may have started since. */
  onLinked: () => void | Promise<void>;
}) {
  const [picked, setPicked] = useState(current?.connectionId ?? '');
  const [draft, setDraft] = useState<string | null>(null);
  const { watching, start: linked } = useLinkWatch(computers.length, onLinked);

  // The only computer there is needs no choosing.
  const connectionId = picked !== '' && computers.some((computer) => computer.connectionId === picked) ? picked : computers.length === 1 ? computers[0].connectionId : picked;
  const computer = computers.find((candidate) => candidate.connectionId === connectionId) ?? null;
  // (the signal is aborted once the list is not wanted: another computer, a retry, the panel closed)
  const list = useModelList(computer?.online && wantsPictures ? connectionId : null, (signal) => api.getAppAiModels(appId, connectionId, ENGINE, signal));
  const models = list.models ? list.models.filter((model) => model.type === 'image') : null;
  const saved = current && current.connectionId === connectionId ? current.pictureModel : null;
  const suggestion = models ? suggestedPictureModel(models) : null;
  const pictureModel = draft ?? saved ?? suggestion ?? '';

  useEffect(() => {
    onChange(connectionId !== '' ? { connectionId, providerId: ENGINE, pictureModel: pictureModel || null } : null);
  }, [connectionId, pictureModel, onChange]);

  const name = computer?.deviceName || 'that computer';
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-slate-700" data-testid="app-ai-own">
      {computers.length === 0 ? (
        <p className="text-gray-600 dark:text-slate-300">No computer of yours can answer yet. Link the one that runs OAIY:</p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="font-medium">Your computer</legend>
          {computers.map((candidate) => (
            <label key={candidate.connectionId} className="flex cursor-pointer items-start gap-2">
              <input type="radio" name="app-ai-own-computer" className="mt-1" checked={connectionId === candidate.connectionId} onChange={() => { setPicked(candidate.connectionId); setDraft(null); }} />
              <span>
                <span className="font-medium">{candidate.deviceName || 'A linked computer'}</span>
                <span className={candidate.online ? 'ml-2 text-xs text-green-700 dark:text-green-300' : 'ml-2 text-xs text-amber-700 dark:text-amber-300'}>{candidate.online ? 'online' : 'offline'}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {wantsPictures && computer && (
        <div className="space-y-1">
          <label htmlFor="app-ai-own-picture-model" className="font-medium">Picture model</label>
          <PictureModelField
            id="app-ai-own-picture-model"
            models={models}
            listing={list.listing}
            error={list.error}
            noList={computer.online ? null : 'offline'}
            value={pictureModel}
            onChange={setDraft}
            onRetry={list.retry}
          />
          {saved === null && suggestion !== null && pictureModel === suggestion && <p className="text-xs text-gray-500 dark:text-slate-400">Suggested: {suggestion}. Save to use it.</p>}
        </div>
      )}
      {computer && <p className="text-xs text-gray-500 dark:text-slate-400">Chat is answered by the model chosen in OAIY on {name}.</p>}
      <div className="space-y-2">
        {computers.length > 0 && <p className="text-xs text-gray-500 dark:text-slate-400">Is it another computer? Link it here:</p>}
        <ConnectOaiyServer compact onLinked={linked} />
        {watching && <p className="text-xs text-gray-500 dark:text-slate-400" role="status">Looking for the new computer. It appears here once OAIY has started on it.</p>}
        {computers.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Using OAIY on your own desktop? Link it in <Link className="font-medium text-primary-600 underline underline-offset-2 dark:text-primary-300" to="/settings#local-runtime">Settings → AI &amp; devices</Link>; it then shows here.
          </p>
        )}
      </div>
    </div>
  );
}
