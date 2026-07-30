/**
 * Plain-language descriptions for the connector grants an installer is asked to approve.
 *
 * The install review listed grants as monospace ids — `connector.aokie.sms.send`,
 * `connector.aokie.dongle.installDriver` — under the heading "Device & connector access".
 * That is the single most consequential decision in the whole install flow (these let a
 * third-party template act on a connected device), and it was asked in a vocabulary the
 * person answering does not have. So the question was answered by clicking, not deciding.
 *
 * Matched longest-prefix-first, so a family can be described once and a specific,
 * higher-stakes action can override it. `ifOff` says what stops working if the grant is
 * declined, because "leave it off to be safe" is only advice if the cost is stated.
 */
export interface GrantLabel {
  /** What allowing it lets the template do, in the owner's words. */
  sentence: string;
  /** What breaks if it is left unticked. */
  ifOff: string;
}

const GRANT_LABELS: Array<[string, GrantLabel]> = [
  ['connector.aokie.call.dial', {
    sentence: 'Place outgoing phone calls from your connected phone',
    ifOff: 'It will not be able to call people back automatically.',
  }],
  ['connector.aokie.call.answer', {
    sentence: 'Answer incoming calls on your connected phone',
    ifOff: 'Calls will not be answered for you.',
  }],
  ['connector.aokie.call.hangup', {
    sentence: 'End a call in progress',
    ifOff: 'It will not be able to hang up on its own.',
  }],
  ['connector.aokie.call.reject', {
    sentence: 'Decline incoming calls',
    ifOff: 'Unwanted calls will not be screened out.',
  }],
  ['connector.aokie.call', {
    sentence: 'See and control calls on your connected phone',
    ifOff: 'Call features in this template will not work.',
  }],
  ['connector.aokie.sms.send', {
    sentence: 'Send text messages from your phone number',
    ifOff: 'It will not be able to text customers — for example a booking confirmation.',
  }],
  ['connector.aokie.sms', {
    sentence: 'Read the text-message conversations on your phone',
    ifOff: 'It will not be able to follow up by text.',
  }],
  ['connector.aokie.phone.startPairing', {
    sentence: 'Pair a phone with this computer',
    ifOff: 'You will need to pair your phone yourself in Desktop.',
  }],
  ['connector.aokie.phone', {
    sentence: 'See which phone is connected, and connect or disconnect it',
    ifOff: 'You will manage the phone connection yourself in Desktop.',
  }],
  ['connector.aokie.dongle.installDriver', {
    sentence: 'Install a device driver on this computer',
    ifOff: 'You will need to install the Bluetooth adapter driver yourself.',
  }],
  ['connector.aokie.dongle', {
    sentence: 'See and choose which Bluetooth adapter to use',
    ifOff: 'You will pick the adapter yourself in Desktop.',
  }],
  ['connector.aokie.settings.set', {
    sentence: 'Change this template’s own settings on your desktop',
    ifOff: 'Its settings screens will not be able to save.',
  }],
  ['connector.aokie.settings', {
    sentence: 'Read this template’s settings from your desktop',
    ifOff: 'Its settings screens may not load.',
  }],
  ['connector.aokie.driver.demo', {
    sentence: 'Run a simulated phone line for testing, with no real calls',
    ifOff: 'You will not be able to try it without a real phone connected.',
  }],
  ['connector.aokie.outbox', {
    sentence: 'Retry messages that failed to send',
    ifOff: 'Failed messages will need retrying by hand.',
  }],
  ['connector.aokie', {
    sentence: 'Use your connected phone through FormLogic Desktop',
    ifOff: 'The phone features in this template will not work.',
  }],
  ['connector.request', {
    sentence: 'Send requests to the outside services this app connects to',
    ifOff: 'Steps that talk to another service will not run.',
  }],
];

/**
 * The conservative fallback: never imply a grant is harmless just because this map has
 * not been taught about it.
 */
const FALLBACK: GrantLabel = {
  sentence: 'Access a connected device',
  ifOff: 'Some features may not work. Only allow this if you trust the publisher.',
};

export function grantLabel(grant: string): GrantLabel {
  let best: GrantLabel | null = null;
  let bestLength = -1;
  for (const [prefix, label] of GRANT_LABELS) {
    if ((grant === prefix || grant.startsWith(prefix + '.')) && prefix.length > bestLength) {
      best = label;
      bestLength = prefix.length;
    }
  }
  return best ?? FALLBACK;
}
