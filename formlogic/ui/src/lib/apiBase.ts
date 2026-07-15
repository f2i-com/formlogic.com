/** Backend API base selected at build time (same-origin by default). */
export const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

/** Join a base and API-relative endpoint without assuming they share an origin. */
export function joinBackendApiUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

/** Resolve an endpoint against the backend base selected for this build. */
export function resolveBackendApiUrl(endpoint: string): string {
  return joinBackendApiUrl(API_BASE_URL, endpoint);
}
