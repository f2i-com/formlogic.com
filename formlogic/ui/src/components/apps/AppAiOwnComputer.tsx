import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { AppAiOwnChoice, AppAiOwnComputer, AppAiView } from '../../lib/appAi';
import { ConnectOaiyServer } from '../desktop/ConnectOaiyServer';
import { Button } from '../ui/Button';

const ENGINE = 'oaiy-engine';

/**
 * "Use my OAIY" (AppAiPanel): one of the owner's own linked computers, pinned to the key it has
 * published, and the picture model its engines draw with, listed by asking the computer now. Its chat
 * answers with the model chosen in OAIY. A server with no browser links here with a one-time code.
 * `onChange` hears a complete choice, or null while it is not one.
 */
export function AppAiOwnComputer({ appId, computers, current, wantsPictures, onChange, onLinked }: {
  appId: string;
  computers: NonNullable<AppAiView['computers']>;
  current: AppAiOwnComputer | null;
  wantsPictures: boolean;
  onChange: (choice: AppAiOwnChoice | null) => void;
  onLinked: () => void;
}) {
  const [connectionId, setConnectionId] = useState(current?.connectionId ?? '');
  const [pictureModel, setPictureModel] = useState(current?.pictureModel ?? '');
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onChange(connectionId !== '' ? { connectionId, providerId: ENGINE, pictureModel: pictureModel.trim() || null } : null);
  }, [connectionId, pictureModel, onChange]);

  const list = async () => {
    if (connectionId === '') return;
    setListing(true); setError(null);
    const result = await api.getAppAiModels(appId, connectionId, ENGINE);
    setListing(false);
    if (result.error || !result.data) { setError(result.error ?? 'The computer did not list its models.'); return; }
    setModels(result.data.models.filter((m) => m.type === 'image'));
  };

  const field = 'mt-1 block min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white';
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-slate-700" data-testid="app-ai-own">
      {computers.length === 0 ? <p className="text-gray-600 dark:text-slate-300">None of your linked computers has published its chat key yet. Open OAIY on one, or link a server:</p> : (
        <fieldset className="space-y-2">
          <legend className="font-medium">Your computer</legend>
          {computers.map((computer) => (
            <label key={computer.connectionId} className="flex cursor-pointer items-start gap-2">
              <input type="radio" name="app-ai-own-computer" className="mt-1" checked={connectionId === computer.connectionId} onChange={() => { setConnectionId(computer.connectionId); setModels(null); }} />
              <span>
                <span className="font-medium">{computer.deviceName || 'A linked computer'}</span>
                <span className={computer.online ? 'ml-2 text-xs text-green-700 dark:text-green-300' : 'ml-2 text-xs text-gray-400'}>{computer.online ? 'online' : 'offline'}</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400">key {computer.fingerprint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <ConnectOaiyServer compact onLinked={onLinked} />
      {wantsPictures && connectionId !== '' && (
        <label className="block">
          <span className="font-medium">Picture model</span>
          {models && models.length > 0 ? (
            <select className={field} value={pictureModel} onChange={(event) => setPictureModel(event.target.value)}>
              <option value="">None: no pictures</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          ) : (
            <input className={field} value={pictureModel} placeholder="flux-3-image-klein" onChange={(event) => setPictureModel(event.target.value)} />
          )}
          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
            An OAIY Engines picture model on that computer, named exactly.
            <Button size="sm" variant="ghost" isLoading={listing} onClick={() => void list()}>List its picture models</Button>
            {models && models.length === 0 && 'It lists no picture model that is switched on.'}
          </span>
        </label>
      )}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
