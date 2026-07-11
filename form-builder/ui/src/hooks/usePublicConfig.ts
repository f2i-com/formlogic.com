import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * Public, pre-auth instance configuration read once from /api/health (so it works on the
 * landing / signup / forgot-password screens before login). Cached at module scope so every
 * consumer shares a single fetch.
 */
export interface PublicConfig {
  /** BETA_MODE=true: Cloud is free and payments are disabled. */
  betaMode: boolean;
  /** Whether transactional email can actually be sent (MAIL_FROM_ADDRESS + a delivery path). */
  emailConfigured: boolean;
  /** Address to contact for manual help when email isn't configured. */
  supportEmail: string;
  /** The admin closed the site for maintenance (file-backed flag on the server). */
  maintenanceMode: boolean;
  /** The admin's visitor-facing maintenance message (shown on embeds + the app shell). */
  maintenanceMessage: string | null;
}

// Defaults are the "don't scare anyone" values: assume email works (so we don't wrongly tell users
// to email support on an instance that can send mail, e.g. when /health is unreachable or old).
const DEFAULTS: PublicConfig = {
  betaMode: false,
  emailConfigured: true,
  supportEmail: 'hello@formlogic.com',
  maintenanceMode: false,
  maintenanceMessage: null,
};

let cached: PublicConfig | null = null;

export function usePublicConfig(): PublicConfig {
  const [cfg, setCfg] = useState<PublicConfig>(cached ?? DEFAULTS);
  useEffect(() => {
    if (cached !== null) return; // already known — initial state is correct
    let active = true;
    api.healthCheck()
      .then((res) => {
        if (!active) return;
        cached = {
          betaMode: !!res.data?.betaMode,
          // Only treat email as unconfigured when the backend explicitly says so.
          emailConfigured: res.data?.emailConfigured !== false,
          supportEmail: res.data?.supportEmail || DEFAULTS.supportEmail,
          maintenanceMode: !!res.data?.maintenanceMode,
          maintenanceMessage: res.data?.maintenanceMessage || null,
        };
        setCfg(cached);
      })
      .catch(() => { /* health unreachable — keep safe defaults */ });
    return () => { active = false; };
  }, []);
  return cfg;
}
