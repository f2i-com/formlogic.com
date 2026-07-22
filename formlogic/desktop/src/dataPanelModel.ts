// Pure presentation logic for the Data workspace (DataPanel.tsx), split out so
// the node test runner can cover it (desktop UI tests only cover pure .ts
// modules). Status vocabulary: data-nodes plan §19.5.

import type { DataDatasetView, DataStatusSnapshot } from './api';

export type BadgeTone = 'ok' | 'err' | 'neutral' | 'pending';

/** Health chip label + tone for a dataset row. */
export function healthBadge(health: string): { label: string; tone: BadgeTone } {
  switch (health) {
    case 'current':
      return { label: 'Current', tone: 'ok' };
    case 'configured':
      return { label: 'Configured', tone: 'neutral' };
    case 'provenance_unverified':
      return { label: 'Provenance unverified', tone: 'pending' };
    case 'rollback_detected':
      return { label: 'Rollback detected', tone: 'err' };
    case 'history_diverged':
      return { label: 'History diverged', tone: 'err' };
    case 'integrity_failed':
      return { label: 'Integrity failed', tone: 'err' };
    default:
      return { label: health || 'Unknown', tone: 'neutral' };
  }
}

/** Human summary of the independent high-water comparison (plan §10.3). */
export function headComparisonLabel(head: string): string {
  switch (head) {
    case 'current':
      return 'Matches the independent high-water anchor';
    case 'ahead_unacknowledged':
      return 'Ahead of the anchor by locally committed, unacknowledged work';
    case 'rollback_detected':
      return 'BEHIND the independent anchor — an older copy was swapped in';
    case 'history_diverged':
      return 'Same sequence as the anchor but different history';
    case 'no_anchor':
      return 'No independent anchor reachable — rollback detection unavailable';
    default:
      return head;
  }
}

export interface DataSummary {
  datasets: number;
  records: number;
  operations: number;
  sizeBytes: number;
  unhealthy: number;
}

export function summarize(status: DataStatusSnapshot | null): DataSummary {
  const datasets = status?.datasets ?? [];
  return {
    datasets: datasets.length,
    records: datasets.reduce((n, d) => n + d.records, 0),
    operations: datasets.reduce((n, d) => n + d.operations, 0),
    sizeBytes: datasets.reduce((n, d) => n + d.sizeBytes, 0),
    unhealthy:
      datasets.filter((d) => d.health !== 'current' && d.health !== 'configured').length
      + (status?.datasetErrors.length ?? 0),
  };
}

/** Display name for a dataset row — samples are labelled as such. */
export function datasetLabel(d: DataDatasetView): string {
  return d.isSample ? `Sample dataset ${d.datasetId.slice(0, 8)}` : d.formId;
}

/** The fail-closed banner message, or null when hosting is available. */
export function keyStoreBanner(status: DataStatusSnapshot | null): string | null {
  if (!status) return null;
  if (!status.keyStoreAvailable || status.nodeError === 'data_key_store_unavailable') {
    return 'No secure OS key store is available. Data hosting is disabled — there is no plaintext fallback.';
  }
  if (status.nodeError) {
    return `Node identity unavailable (${status.nodeError}).`;
  }
  return null;
}
