// Runtime environment detection (spec §56).
//
// Tells the app which surface it is running on so it can light up the right
// affordances: the platform host (formlogic.local / formlogic.com), a customer
// custom domain, or inside FormLogic Native Runtime (native bridge present).
// Custom-domain routing itself is a later milestone; today this mainly drives
// `nativeAvailable` and connector status. Kept dependency-free and SSR-safe.

export type HostMode = 'platform' | 'custom-domain' | 'native';

export interface RuntimeEnvironment {
  hostMode: HostMode;
  domain?: string;
  nativeAvailable: boolean;
}

// Hosts that are always "the FormLogic platform", never a customer domain.
const PLATFORM_HOST_SUFFIXES = ['formlogic.com', 'formlogic.local', 'localhost', '127.0.0.1'];

function publicDomain(): string | undefined {
  // Vite exposes VITE_* at build; guard for non-Vite/SSR contexts.
  try {
    return (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_PUBLIC_DOMAIN;
  } catch {
    return undefined;
  }
}

export function isFormLogicMainHost(host: string): boolean {
  const h = host.toLowerCase().split(':')[0];
  const configured = publicDomain()?.toLowerCase().split(':')[0];
  if (configured && (h === configured || h.endsWith('.' + configured))) return true;
  return PLATFORM_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

export function detectRuntimeEnvironment(): RuntimeEnvironment {
  const nativeAvailable =
    typeof window !== 'undefined' && !!window.FormLogicNative?.available;

  if (typeof window === 'undefined') {
    return { hostMode: 'platform', nativeAvailable: false };
  }

  const host = window.location.host;
  if (nativeAvailable) {
    return { hostMode: 'native', domain: host, nativeAvailable: true };
  }
  if (!isFormLogicMainHost(host)) {
    return { hostMode: 'custom-domain', domain: host, nativeAvailable: false };
  }
  return { hostMode: 'platform', nativeAvailable: false };
}
