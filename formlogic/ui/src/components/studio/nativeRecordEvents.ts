export function nativeRecordEventLabel(event: string): string | null {
  const match = /^app\.record\.(created|updated|deleted)\.([A-Za-z][A-Za-z0-9_]{0,62})$/.exec(event);
  return match ? `${match[2]} · record ${match[1]}` : null;
}
