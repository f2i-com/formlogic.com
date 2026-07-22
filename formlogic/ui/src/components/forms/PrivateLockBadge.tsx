// E2EE private forms: lock badge shown next to the form name wherever forms are
// listed (FormsList, Dashboard "My Forms"). Driven by the list payload's `isPrivate`.
import { Lock } from 'lucide-react';

export const PRIVATE_FORM_BADGE_TEXT =
  "End-to-end encrypted — responses are sealed in the submitter's browser; the server cannot read them";

export function PrivateLockBadge() {
  return (
    <span className="inline-flex flex-none items-center" role="img" aria-label={PRIVATE_FORM_BADGE_TEXT} title={PRIVATE_FORM_BADGE_TEXT}>
      <Lock className="h-3.5 w-3.5 text-green-600 dark:text-green-400" aria-hidden="true" />
    </span>
  );
}
