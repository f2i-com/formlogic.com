// Passes an app requires, as pages show them (AccessGateService on the server). The words are the
// plugin's own, from its manifest; nothing here knows what a plugin checks.
import type { PassRequirement, PassStrength, RequirementsStatus } from '../types/app';

/** The first requirement the member does not meet yet, or null. */
export function unmetRequirement(status: RequirementsStatus | null | undefined): PassRequirement | null {
  return status?.requirements?.find((requirement) => !requirement.satisfied) ?? null;
}

/** What the button that takes the member to a requirement's plugin says. */
export function passAction(requirement: Pick<PassRequirement, 'action' | 'pluginName'>): string {
  return requirement.action || `Continue with ${requirement.pluginName}`;
}

/** The site's own words for each strength, where a plugin gives none. */
export const STRENGTH_WORDS: Record<PassStrength, { label: string; hint: string; held: string }> = {
  declared: { label: 'Their own word', hint: 'Each member says so once on this site. It is their word, not a check.', held: 'your word' },
  estimated: { label: 'An estimate', hint: 'The plugin estimates it, with what this site gives it.', held: 'estimated' },
  verified: { label: 'A check', hint: 'The plugin checks it against a document or a digital ID.', held: 'checked' },
};
