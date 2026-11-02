import { useId } from 'react';
import { Switch } from '../ui/Switch';
import type { AgeAssurance, AgeGateSetting as AgeGate } from '../../types/app';

/** What each strength means to the person choosing it, and whether this site can check it yet. */
const STRENGTHS: { value: AgeAssurance; label: string; hint: string; offered: boolean }[] = [
  { value: 'declared', label: 'They confirm their age', hint: 'Each member confirms it once on this site. It is their word, not a check.', offered: true },
  { value: 'estimated', label: 'A face check', hint: 'Needs the age verifier, which this site does not have yet.', offered: false },
  { value: 'verified', label: 'An ID or digital ID check', hint: 'Needs a verifier, which this site does not have yet.', offered: false },
];

/**
 * The owner's age gate for an app: off, or a minimum age and how it must be shown. The server holds
 * every route of the app to it (AppAccessGateMiddleware); this only edits settings.ageGate.
 */
export function AgeGateSetting({ value, onChange, disabled, anonymousAccess }: {
  value: AgeGate | undefined;
  onChange: (next: AgeGate | undefined) => void;
  disabled?: boolean;
  /** The app is open to anyone with the link: the gate makes everyone sign in. */
  anonymousAccess?: boolean;
}) {
  const ageId = useId();
  const gate = value;
  return (
    <div className="space-y-3">
      <Switch
        label="Only for people over an age"
        description="Members confirm their age on this site before the app opens for them. You, as its owner, are never asked."
        checked={!!gate}
        disabled={disabled}
        onChange={(on) => onChange(on ? { minimumAge: gate?.minimumAge ?? 18, assurance: gate?.assurance ?? 'declared' } : undefined)}
      />
      {gate && (
        <>
          <div className="flex items-center gap-2">
            <label htmlFor={ageId} className="text-sm font-medium text-gray-700 dark:text-slate-300">Minimum age</label>
            <input
              id={ageId}
              type="number"
              min={13}
              max={120}
              value={gate.minimumAge}
              disabled={disabled}
              onChange={(e) => {
                const age = Math.round(Number(e.target.value));
                if (Number.isFinite(age) && age >= 13 && age <= 120) onChange({ ...gate, minimumAge: age });
              }}
              className="w-20 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>
          <fieldset className="space-y-1.5" disabled={disabled}>
            <legend className="text-sm font-medium text-gray-700 dark:text-slate-300">How they show it</legend>
            {STRENGTHS.map((strength) => (
              <label key={strength.value} className="flex cursor-pointer gap-2 text-sm">
                <input
                  type="radio"
                  name={`${ageId}-strength`}
                  className="mt-1"
                  checked={gate.assurance === strength.value}
                  disabled={!strength.offered && gate.assurance !== strength.value}
                  onChange={() => onChange({ ...gate, assurance: strength.value })}
                />
                <span>
                  <span className="font-medium text-gray-900 dark:text-white">{strength.label}</span>
                  <span className="block text-xs leading-5 text-gray-500 dark:text-slate-400">{strength.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {anonymousAccess && (
            <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
              With an age gate everyone signs in to use this app, even though it is open to anyone with the link: a check needs someone to belong to.
            </p>
          )}
        </>
      )}
    </div>
  );
}
