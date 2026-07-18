// Row shapes shared by the Device Setup cards. Every row is normalized from
// the untyped connector/service results at LOAD time (see index.tsx loaders)
// with the same field checks the original embedded JS applied inline.

export interface DesktopRow {
  deviceName: string | null;
  lastSeenAt: string | null;
}

export interface DongleRow {
  id: string;
  name: string;
  vid: number;
  pid: number;
  usbId: string;
  driverInstalled: boolean;
  matchesCatalog: boolean;
  preferred: boolean;
}

export interface PhoneRow {
  address: string;
  name: string | null;
  connected: boolean;
}

export interface CompanionDevice {
  id: string;
  displayName: string | null;
  role: string | null;
  /** Non-empty revocation stamp = the endpoint is revoked. */
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface CompanionState {
  /** The policy.get admission ticket was refused -> the whole section hides. */
  hidden: boolean;
  policy: Record<string, unknown> | null;
  /** null = the devices list was refused (audit rights) - section omitted. */
  devices: CompanionDevice[] | null;
  /** Edit rights are probed by attempting a save only when the user acts; the
   *  controls show for everyone the DEVICES list admits (audit is not a subset
   *  of manage, so a save may still refuse - surfaced honestly then). */
  canEdit: boolean;
}

/** The remote-access policy checkboxes, in display order: [key, label]. */
export const POLICY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['remoteMonitoring', 'Monitor live calls'],
  ['remoteConsult', 'Consult (talk to Aokie privately)'],
  ['remoteTakeover', 'Take over calls'],
  ['remoteCaptions', 'Live captions'],
  ['remoteAssistance', 'Assistance requests'],
];
