import { usePublicConfig } from './usePublicConfig';

/**
 * Whether this instance is running in public-beta mode (BETA_MODE=true): Cloud is free and payments
 * are disabled. Thin wrapper over the shared public config so beta + email flags share one fetch.
 */
export function useBetaMode(): boolean {
  return usePublicConfig().betaMode;
}
