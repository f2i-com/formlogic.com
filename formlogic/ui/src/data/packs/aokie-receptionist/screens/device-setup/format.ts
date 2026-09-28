// Shared value/timestamp helpers for the Device Setup console.
//
// Zone-less 'YYYY-MM-DD HH:MM:SS' timestamps are stored UTC -> stamp the Z
// before parsing. Character checks (not a regex) keep the rule obvious and
// byte-for-byte equivalent to the original embedded-JS implementation.

/** Coerce an unknown value to a plain object (never an array), else {}. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function utcify(s: string): string {
  if (s.length === 19 && s.charAt(4) === '-' && s.charAt(10) === ' ' && s.charAt(13) === ':') {
    return s.slice(0, 10) + 'T' + s.slice(11) + 'Z';
  }
  return s;
}

export interface WhenLabel {
  short: string;
  full: string;
}

/** Locale short label + full tooltip for a stored timestamp, or null when unparsable. */
export function whenLabel(iso: string | null | undefined): WhenLabel | null {
  const ms = Date.parse(utcify(iso || ''));
  if (isNaN(ms)) return null;
  const d = new Date(ms);
  return {
    short: d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    full: d.toLocaleString(),
  };
}

export interface ResetNote {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
  /** The plugin does not know dongle.reset yet (an older Aokie). */
  needsUpdate?: boolean;
}

/** An older plugin, or a host that has not declared the command: any of the
 *  ways "I don't know dongle.reset" comes back. */
function unknownCommand(code: string, message: string): boolean {
  return /unknown[ _-]?command|unsupported[ _-]?command|command[ _-]?not[ _-]?(found|declared|supported)|not declared|undeclared|no such command|method not found|not supported/i
    .test(code + ' ' + message);
}

/**
 * What a dongle.reset outcome means for the operator. The command answers
 * `{accepted, via: 'software', phoneReconnected}`; during a call the plugin
 * refuses with command_failed "a call is in progress: reset the dongle after
 * it ends"; an older plugin answers with an unknown-command error.
 */
export function resetOutcome(out: { status: string; result?: unknown; error?: unknown }): ResetNote {
  if (out.status === 'done') {
    const r = asRecord(out.result);
    if (r.accepted === false) return { tone: 'bad', text: 'Aokie did not accept the reset. Try again, or unplug the dongle and plug it back in.' };
    return r.phoneReconnected === true
      ? { tone: 'ok', text: 'The dongle was reset in software and the phone reconnected.' }
      : { tone: 'warn', text: 'The dongle was reset in software. The phone has not reconnected yet: give it a moment, then press Refresh, or Reconnect it below.' };
  }
  const e = asRecord(out.error);
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (unknownCommand(code, message)) {
    return {
      tone: 'warn',
      needsUpdate: true,
      text: "This version of the Aokie plugin can't reset the dongle from here. Update Aokie in OAIY > Plugins to add it; until then, unplug the dongle and plug it back in.",
    };
  }
  if (/call is in progress/i.test(message)) {
    return { tone: 'warn', text: 'A call is in progress: reset the dongle after it ends.' };
  }
  if (code === 'connector_unavailable' || code === 'connector_missing') {
    return { tone: 'bad', text: "OAIY or Aokie can't be reached, so the dongle was not reset. Connect OAIY above, then try again." };
  }
  if (out.status === 'expired') return { tone: 'bad', text: 'OAIY did not pick up the reset within a minute, so the dongle was not reset.' };
  if (out.status === 'uncertain') return { tone: 'warn', text: 'Sent, but OAIY has not confirmed the reset. Press Refresh in a moment to see the dongle.' };
  return { tone: 'bad', text: 'The dongle was not reset' + (message ? ': ' + message : '.') };
}

/** Coarse relative-age label ('just now' / 'N min ago' / ...), or null when unparsable. */
export function agoLabel(iso: string | null | undefined): string | null {
  const ms = Date.parse(utcify(iso || ''));
  if (isNaN(ms)) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
