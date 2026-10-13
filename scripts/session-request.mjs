import { pathToFileURL } from 'node:url';

/** Origin for a non-browser session client, taken only from its configured SPA URL. */
export function frontendOrigin(frontendBaseUrl) {
  if (typeof frontendBaseUrl !== 'string' || !frontendBaseUrl.trim()) {
    throw new Error('Configure the frontend base URL before creating a session');
  }
  const url = new URL(frontendBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The frontend base URL must be an HTTP(S) URL without credentials');
  }
  return url.origin;
}

export function sessionJsonHeaders(frontendBaseUrl) {
  return { 'Content-Type': 'application/json', Origin: frontendOrigin(frontendBaseUrl) };
}

// The release workflow uses the same normalization as the Node/Playwright clients.
// This CLI only prints an origin; it never contacts the URL or creates a session.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(frontendOrigin(process.argv[2]));
}
