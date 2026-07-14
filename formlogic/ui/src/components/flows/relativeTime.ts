// Small flow-workspace time labels shared by overview and run history.
//
// Timestamps arrive as offsetless MySQL datetimes in UTC ("Y-m-d H:i:s") — parseServerDate
// stamps the missing Z. Feeding them to new Date() directly read them as LOCAL time, so a
// run from last night showed as "21h ago" instead of "11h ago" (UTC+10), and Safari parsed
// the space-separated format as Invalid Date outright.
import { parseServerDate } from '../../lib/utils';

export function formatRelativeTime(value: string | null | undefined, nowMs = Date.now()): string {
  if (!value) return 'Unknown time';
  const at = parseServerDate(value).getTime();
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
  const at = parseServerDate(value);
  if (!Number.isFinite(at.getTime())) return value;
  return at.toLocaleString();
}
