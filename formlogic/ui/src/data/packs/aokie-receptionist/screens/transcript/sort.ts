/**
 * True conversation order for transcript turns — the SAME rule the compiled screen used:
 *  1. `spokenAt` (the plugin's speech-START stamp, ISO-8601 UTC — string compare is
 *     chronological): a caller line spoken OVER a bot reply sorts where it was SAID,
 *     not where it was committed;
 *  2. `turnIndex` orders rows from older plugins that predate the timestamp;
 *  3. `submittedAt` breaks the remaining ties.
 *
 * This file ships INSIDE the sandboxed screen (customScreen.files) and is ALSO imported
 * directly by the pack unit tests — the tested function IS the shipped code.
 */
export interface TurnOrderKeys {
  spokenAt?: string | null;
  turnIndex?: number | null;
  submittedAt?: string | null;
}

export function compareTurns(a: TurnOrderKeys, b: TurnOrderKeys): number {
  if (a.spokenAt && b.spokenAt && a.spokenAt !== b.spokenAt) return a.spokenAt.localeCompare(b.spokenAt);
  if (a.turnIndex != null && b.turnIndex != null && a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
  return String(a.submittedAt || '').localeCompare(String(b.submittedAt || ''));
}
