// Passes an app requires, as pages show them (AccessGateService on the server).
import type { PassRequirement, RequirementsStatus } from '../types/app';

/** The first requirement the member does not meet yet, or null. */
export function unmetRequirement(status: RequirementsStatus | null | undefined): PassRequirement | null {
  return status?.requirements?.find((requirement) => !requirement.satisfied) ?? null;
}

/** What the button that takes the member to a requirement's plugin says. */
export function passAction(requirement: Pick<PassRequirement, 'kind' | 'pluginName'>): string {
  return requirement.kind === 'age' ? 'Confirm your age' : `Continue with ${requirement.pluginName}`;
}

/** A requirement in words: "Age 18 or over, declared". */
export function describeRequirement(requirement: Pick<PassRequirement, 'kind' | 'label' | 'unit' | 'min' | 'strength'>): string {
  const strength = requirement.strength === 'declared' ? 'their own word' : requirement.strength === 'estimated' ? 'an estimate' : 'a check';
  if (requirement.kind === 'age') return `Aged ${requirement.min} or over, by ${strength}`;
  return `${requirement.label} ${requirement.min}${requirement.unit ? ` ${requirement.unit}` : ''} or more, by ${strength}`;
}
