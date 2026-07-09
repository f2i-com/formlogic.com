// Small flow-workspace time labels shared by overview and run history.
//
// Kept dependency-free so table rows can render compact relative labels while retaining an
// absolute timestamp in title= for audit/debugging.
export function formatRelativeTime(value: string | null | undefined, nowMs = Date.now()): string {
  if (!value) return 'Unknown time';
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return value;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(at).toLocaleDateString();
}

export function formatAbsoluteTimeTitle(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return value;
  return at.toLocaleString();
}
