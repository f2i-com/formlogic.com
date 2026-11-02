import { useEffect, useId, useState } from 'react';
import { Switch } from '../ui/Switch';
import { api } from '../../lib/api';
import type { AppRequirement, PassKind, PassStrength } from '../../types/app';

/** What each strength means to the person choosing it. */
const STRENGTHS: { value: PassStrength; label: string; ageLabel: string; hint: string }[] = [
  { value: 'declared', label: 'Their own word', ageLabel: 'They confirm their age', hint: 'Each member says so once on this site. It is their word, not a check.' },
  { value: 'estimated', label: 'An estimate', ageLabel: 'A face check', hint: 'The plugin estimates it.' },
  { value: 'verified', label: 'A check', ageLabel: 'An ID or digital ID check', hint: 'The plugin checks it against a document or a digital ID.' },
];

const keyOf = (r: { plugin: string; kind: string }) => `${r.plugin}|${r.kind}`;

/**
 * What an app asks of its members before it opens: passes from the plugins enabled on this site
 * (Admin → Plugins). The server holds every route of the app to them (AppAccessGateMiddleware);
 * this only edits settings.requires.
 */
export function RequirementsSetting({ value, onChange, disabled, anonymousAccess }: {
  value: AppRequirement[] | undefined;
  onChange: (next: AppRequirement[] | undefined) => void;
  disabled?: boolean;
  /** The app is open to anyone with the link: a requirement makes everyone sign in. */
  anonymousAccess?: boolean;
}) {
  const id = useId();
  const [kinds, setKinds] = useState<PassKind[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(api.getPassKinds()).then((result) => {
      if (cancelled) return;
      if (!result?.data || result.error) setFailed(true);
      else setKinds(result.data.passes);
    }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);
  const requires = value ?? [];
  const set = (next: AppRequirement[]) => onChange(next.length ? next : undefined);
  const put = (requirement: AppRequirement) => set([...requires.filter((r) => keyOf(r) !== keyOf(requirement)), requirement]);
  const drop = (requirement: { plugin: string; kind: string }) => set(requires.filter((r) => keyOf(r) !== keyOf(requirement)));
  // Requirements whose plugin is off or gone: the app stays closed to members until it is back or this goes.
  const orphans = kinds ? requires.filter((r) => !kinds.some((k) => keyOf(k) === keyOf(r))) : [];

  if (failed) return <p className="text-sm text-gray-500 dark:text-slate-400">What this site&apos;s plugins offer could not be loaded. Reload to try again.</p>;
  if (!kinds) return <p role="status" className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>;
  return (
    <div className="space-y-4">
      {kinds.length === 0 && orphans.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-slate-400">
          No plugin on this site asks members for anything yet. A site administrator adds plugins under Admin → Plugins.
        </p>
      )}
      {kinds.map((kind) => {
        const current = requires.find((r) => keyOf(r) === keyOf(kind));
        const age = kind.kind === 'age';
        const minId = `${id}-${kind.plugin}-${kind.kind}`;
        return (
          <div key={keyOf(kind)} className="space-y-3">
            <Switch
              label={age ? 'Only for people over an age' : `Require ${kind.label}`}
              description={`${age ? 'Members confirm their age on this site before the app opens for them.' : 'Members get it on this site before the app opens for them.'} Through ${kind.pluginName}, a plugin on this site. You, as its owner, are never asked.`}
              checked={!!current}
              disabled={disabled}
              onChange={(on) => on
                ? put({ plugin: kind.plugin, kind: kind.kind, min: Math.min(Math.max(age ? 18 : kind.min, kind.min), kind.max), strength: kind.strengths[0] })
                : drop(kind)}
            />
            {current && (
              <>
                <div className="flex items-center gap-2">
                  <label htmlFor={minId} className="text-sm font-medium text-gray-700 dark:text-slate-300">{age ? 'Minimum age' : `Least ${kind.label}`}</label>
                  <input
                    id={minId}
                    type="number"
                    min={kind.min}
                    max={kind.max}
                    value={current.min}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = Math.round(Number(e.target.value));
                      if (Number.isFinite(next) && next >= kind.min && next <= kind.max) put({ ...current, min: next });
                    }}
                    className="w-20 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                  />
                  {kind.unit && !age && <span className="text-sm text-gray-500 dark:text-slate-400">{kind.unit}</span>}
                </div>
                <fieldset className="space-y-1.5" disabled={disabled}>
                  <legend className="text-sm font-medium text-gray-700 dark:text-slate-300">How they show it</legend>
                  {STRENGTHS.map((strength) => {
                    const offered = kind.strengths.includes(strength.value);
                    return (
                      <label key={strength.value} className="flex cursor-pointer gap-2 text-sm">
                        <input
                          type="radio"
                          name={`${minId}-strength`}
                          className="mt-1"
                          checked={current.strength === strength.value}
                          disabled={!offered && current.strength !== strength.value}
                          onChange={() => put({ ...current, strength: strength.value })}
                        />
                        <span>
                          <span className="font-medium text-gray-900 dark:text-white">{age ? strength.ageLabel : strength.label}</span>
                          <span className="block text-xs leading-5 text-gray-500 dark:text-slate-400">{offered ? strength.hint : `${kind.pluginName} doesn't offer this.`}</span>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              </>
            )}
          </div>
        );
      })}
      {orphans.map((orphan) => (
        <div key={keyOf(orphan)} role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          <p>This app requires a pass from <span className="font-medium">{orphan.plugin}</span>, a plugin that is not on this site at the moment, so members can&apos;t open it.</p>
          <button type="button" disabled={disabled} className="mt-2 min-h-11 font-medium underline" onClick={() => drop(orphan)}>Stop requiring it</button>
        </div>
      ))}
      {anonymousAccess && requires.length > 0 && (
        <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
          With a requirement everyone signs in to use this app, even though it is open to anyone with the link: a pass needs someone to belong to.
        </p>
      )}
    </div>
  );
}
