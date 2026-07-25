import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, AlertTriangle } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { api, type PackageServiceSlot } from '../../lib/api';
import { useServiceCatalog } from '../../hooks/useServiceCatalog';
import { useProviderProfiles } from '../../hooks/useProviderProfiles';
import { toast } from '../../stores/toastStore';

/**
 * SRV-405 service slot bindings for one installed extension.
 *
 * A contributed `service-action` node names a SLOT ("imageGenerator") and the action it
 * needs — never a concrete service. This is where the owner answers which service fills
 * that slot, on which connection. Until they do, the compiler refuses those nodes with
 * `binding_unresolved` rather than producing a run that could only fail.
 *
 * The service list comes from the paired Desktop's v3 catalog, filtered to definitions that
 * actually offer every action the slot requires — an unusable choice is never offered. With
 * no paired Desktop the ids stay typeable, so a slot can be prepared ahead of pairing.
 */
export function ServiceSlotBindings({ installationId }: { installationId: string }) {
  const [slots, setSlots] = useState<PackageServiceSlot[] | null>(null);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ definitionId: string; connection: string }>({ definitionId: '', connection: '' });
  const [saving, setSaving] = useState(false);
  const catalog = useServiceCatalog();
  const profiles = useProviderProfiles();

  useEffect(() => {
    let cancelled = false;
    void api.getPackageServiceBindings(installationId).then((response) => {
      if (cancelled) return;
      if (response.data?.slots) setSlots(response.data.slots);
      else setError(typeof response.error === 'string' && response.error !== '' ? response.error : 'Could not load the service slots.');
    });
    return () => {
      cancelled = true;
    };
  }, [installationId, reloadToken]);

  const reload = useCallback(() => {
    setSlots(null);
    setError('');
    setReloadToken((token) => token + 1);
  }, []);

  const save = useCallback(async (slot: string) => {
    if (draft.definitionId.trim() === '' || draft.connection.trim() === '') return;
    setSaving(true);
    const response = await api.bindPackageServiceSlot(installationId, slot, {
      definitionId: draft.definitionId.trim(),
      connection: draft.connection.trim(),
    });
    setSaving(false);
    if (response.data) {
      setEditing(null);
      reload();
      toast.success('Service bound', `Flows using this extension’s “${slot}” actions can run now.`);
    } else {
      toast.error('Could not bind the service', response.error || 'Unknown error');
    }
  }, [draft, installationId, reload]);

  const clear = useCallback(async (slot: string) => {
    const response = await api.unbindPackageServiceSlot(installationId, slot);
    if (response.data) {
      reload();
      toast.info('Service unbound', 'Flows using this slot will refuse to compile until it is bound again.');
    } else {
      toast.error('Could not unbind', response.error || 'Unknown error');
    }
  }, [installationId, reload]);

  if (error) {
    return (
      <p className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        {error}
      </p>
    );
  }
  if (slots === null) {
    return (
      <p className="flex items-center gap-1.5 text-gray-500 dark:text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading service slots…
      </p>
    );
  }
  if (slots.length === 0) return null;

  return (
    <section>
      <h4 className="flex items-center gap-1.5 font-semibold text-gray-700 dark:text-slate-200">
        <Plug className="h-3.5 w-3.5" aria-hidden="true" />
        Services this extension needs ({slots.length})
      </h4>
      <ul className="mt-1 space-y-2">
        {slots.map((slot) => {
          // Only definitions offering EVERY required action can fill this slot.
          const usable = (catalog?.definitions ?? []).filter((definition) =>
            slot.requiredActions.every((action) => definition.actions.some((a) => a.id === action)),
          );
          return (
            <li key={slot.slot} className="rounded-md border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-gray-700 dark:text-slate-200">{slot.slot}</span>
                {slot.required
                  ? <Badge variant={slot.binding ? 'success' : 'warning'} size="sm">{slot.binding ? 'bound' : 'required'}</Badge>
                  : <Badge variant="default" size="sm">optional</Badge>}
                {slot.requiredActions.length > 0 && (
                  <span className="text-gray-400 dark:text-slate-500">needs {slot.requiredActions.join(', ')}</span>
                )}
              </div>

              {slot.binding && editing !== slot.slot ? (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-gray-600 dark:text-slate-300">
                  <span className="font-mono text-[11px]">{slot.binding.definitionId}</span>
                  <span className="text-gray-400 dark:text-slate-500">on {slot.binding.connection}</span>
                  <Button variant="outline" size="sm" onClick={() => { setDraft({ definitionId: slot.binding!.definitionId, connection: slot.binding!.connection }); setEditing(slot.slot); }}>
                    Change
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void clear(slot.slot)}>Unbind</Button>
                </div>
              ) : editing === slot.slot ? (
                <div className="mt-1 space-y-1.5">
                  {usable.length > 0 ? (
                    <select
                      value={draft.definitionId}
                      onChange={(e) => setDraft((d) => ({ ...d, definitionId: e.target.value }))}
                      aria-label={`Service for ${slot.slot}`}
                      className="w-full rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs text-gray-900 dark:text-slate-100"
                    >
                      <option value="">Choose a service…</option>
                      {usable.map((definition) => (
                        <option key={definition.id} value={definition.id}>
                          {/* Say where a service came from: a plugin-supplied service and a
                              built-in should not look identical when you are choosing one. */}
                          {definition.name || definition.id}
                          {definition.provider ? ` — from ${definition.provider}` : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={draft.definitionId}
                      onChange={(e) => setDraft((d) => ({ ...d, definitionId: e.target.value }))}
                      placeholder="Service definition id (e.g. openai-api)"
                      aria-label={`Service for ${slot.slot}`}
                      className="w-full rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs text-gray-900 dark:text-slate-100"
                    />
                  )}
                  {/* The connection is an opaque provider-profile id — offer the real list
                      rather than making the user go and find one. */}
                  {profiles && profiles.length > 0 ? (
                    <select
                      value={draft.connection}
                      onChange={(e) => setDraft((d) => ({ ...d, connection: e.target.value }))}
                      aria-label={`Connection for ${slot.slot}`}
                      className="w-full rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs text-gray-900 dark:text-slate-100"
                    >
                      <option value="">Choose a connection…</option>
                      {profiles.map((profile) => (
                        <option key={profile.refId} value={profile.refId}>{profile.name}</option>
                      ))}
                      {/* A stored id that is no longer listed stays selectable, not silently dropped. */}
                      {draft.connection !== '' && !profiles.some((p) => p.refId === draft.connection) && (
                        <option value={draft.connection}>{draft.connection} (not currently available)</option>
                      )}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={draft.connection}
                      onChange={(e) => setDraft((d) => ({ ...d, connection: e.target.value }))}
                      placeholder="Connection (Desktop provider profile id)"
                      aria-label={`Connection for ${slot.slot}`}
                      className="w-full rounded border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs text-gray-900 dark:text-slate-100"
                    />
                  )}
                  <p className="text-gray-400 dark:text-slate-500">
                    The connection is the Desktop AI provider profile holding the credential — an opaque id, never a key or URL.
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button variant="primary" size="sm" onClick={() => void save(slot.slot)} isLoading={saving} disabled={!draft.definitionId.trim() || !draft.connection.trim()}>
                      Save
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
                  </div>
                  {catalog === null && (
                    <p className="text-gray-400 dark:text-slate-500">
                      No paired Desktop right now — you can still type the ids, and they take effect when it reconnects.
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-1 space-y-1.5">
                  <span className="block text-amber-600 dark:text-amber-400">
                    Not bound — nodes using this slot refuse to compile until a service is chosen.
                  </span>
                  {/* The picker is the point of this row, so it is here rather than behind a
                      button. With exactly one usable service (and one connection) the obvious
                      choice is pre-selected — the user confirms rather than hunts. */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDraft({
                        definitionId: usable.length === 1 ? usable[0].id : '',
                        connection: profiles && profiles.length === 1 ? profiles[0].refId : '',
                      });
                      setEditing(slot.slot);
                    }}
                  >
                    {usable.length === 1 ? `Use ${usable[0].name || usable[0].id}` : 'Choose a service'}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
