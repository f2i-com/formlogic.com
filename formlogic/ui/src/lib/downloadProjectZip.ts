export function downloadProjectZip(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (name.trim().replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'app') + '.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
