// Saving the recovery kit outside the page (docs/E2EE_PRIVATE_FORMS_PLAN.md D5, §5).
//
// The kit is shown once, so besides copying it the setup wizard offers a text file and a
// print view. Both are built from the same sheet — the FLRK1 kit exactly as displayed
// (prefix, groups of four, checksum group), the date it was made, and a plain warning —
// so what is downloaded, printed and displayed can never drift apart.
//
// Nothing here touches the network or any storage. The download leaves through the
// browser's own download mechanism (a Blob URL that is revoked right afterwards) and the
// print view is a temporary same-origin iframe that is removed when printing ends. All
// text is set with textContent: no markup is ever built from strings.

/** The kit as a document: one structure feeding both the file and the print view. */
export interface RecoveryKitSheet {
  title: string;
  /** The user's local calendar date, YYYY-MM-DD. */
  created: string;
  /** FLRK1-… exactly as displayed, checksum group included. */
  kit: string;
  kitNote: string;
  warningHeading: string;
  warnings: string[];
  usageHeading: string;
  usage: string;
}

/** How long a Blob URL is kept after the click: some browsers only read it once click() has returned. */
export const BLOB_URL_REVOKE_DELAY_MS = 10_000;
/** Upper bound on how long the print iframe may linger if the browser never fires afterprint. */
export const PRINT_FRAME_MAX_LIFETIME_MS = 5 * 60_000;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The user's own calendar date (not UTC): a kit made at 8am on the 30th says the 30th. */
function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function recoveryKitSheet(kit: string, created: Date): RecoveryKitSheet {
  return {
    title: 'FormLogic vault recovery kit',
    created: localIsoDate(created),
    kit,
    kitNote:
      'The last group of four characters is a checksum: it lets FormLogic catch a typing mistake '
      + 'before it does any work. Enter the kit exactly as shown.',
    warningHeading: 'Keep this private and safe',
    warnings: [
      'Anyone who has this kit can open your encrypted vault. Treat it like a password.',
      'If you lose your vault passphrase AND this kit, your encrypted responses are gone for '
        + 'good. FormLogic cannot recover them for you.',
      'Keep it somewhere other than this browser, and not next to your passphrase: a password '
        + 'manager, or a printout in a safe place. Do not email it to yourself.',
      'The kit stays valid when you change your passphrase.',
    ],
    usageHeading: 'How to use it',
    usage:
      'On the vault unlock screen choose "Use recovery kit", enter the kit exactly as shown '
      + 'above, and choose a new vault passphrase.',
  };
}

export function recoveryKitFileName(sheet: RecoveryKitSheet): string {
  return `formlogic-vault-recovery-kit-${sheet.created}.txt`;
}

/** The downloadable file. Plain ASCII, so any editor opens it. */
export function recoveryKitText(sheet: RecoveryKitSheet): string {
  return [
    sheet.title.toUpperCase(),
    '='.repeat(sheet.title.length),
    '',
    `Created: ${sheet.created}`,
    '',
    'Your recovery kit:',
    '',
    `    ${sheet.kit}`,
    '',
    sheet.kitNote,
    '',
    sheet.warningHeading.toUpperCase(),
    ...sheet.warnings.map((warning) => `- ${warning}`),
    '',
    sheet.usageHeading.toUpperCase(),
    sheet.usage,
    '',
  ].join('\n');
}

/**
 * Hands the kit to the browser as a text file. The Blob URL is revoked shortly after the
 * click, whatever happens, so the kit never stays reachable behind a URL.
 */
export function downloadRecoveryKit(kit: string, created: Date): void {
  const sheet = recoveryKitSheet(kit, created);
  const blob = new Blob([recoveryKitText(sheet)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = recoveryKitFileName(sheet);
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_DELAY_MS);
  }
}

/** The static shell of the print document; every dynamic string is added with textContent. */
const PRINT_SHELL = '<!doctype html><html><head><meta charset="utf-8"><title>FormLogic vault recovery kit</title></head><body></body></html>';

function fillPrintDocument(doc: Document, sheet: RecoveryKitSheet): void {
  doc.title = sheet.title;
  Object.assign(doc.body.style, {
    margin: '2cm',
    color: '#000',
    background: '#fff',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: '11pt',
    lineHeight: '1.5',
  });
  const add = (tag: 'h1' | 'h2' | 'p' | 'pre' | 'ul', text: string | null, style: Partial<CSSStyleDeclaration> = {}): HTMLElement => {
    const el = doc.createElement(tag);
    if (text !== null) el.textContent = text;
    Object.assign(el.style, style);
    doc.body.appendChild(el);
    return el;
  };

  add('h1', sheet.title, { fontSize: '20pt', margin: '0 0 4pt' });
  add('p', `Created: ${sheet.created}`, { margin: '0 0 18pt' });
  add('p', 'Your recovery kit:', { margin: '0 0 4pt', fontWeight: '600' });
  // Wraps at the hyphens when the page is narrower than the kit (a group is never split
  // unless it has to be) — a printed kit is copied back by eye.
  add('pre', sheet.kit, {
    fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
    fontSize: '12pt',
    fontWeight: '600',
    border: '1.5pt solid #000',
    padding: '10pt',
    margin: '0 0 6pt',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  });
  add('p', sheet.kitNote, { fontSize: '10pt', margin: '0 0 18pt' });
  add('h2', sheet.warningHeading, { fontSize: '13pt', margin: '0 0 4pt' });
  const list = add('ul', null, { margin: '0 0 18pt', paddingLeft: '18pt' });
  for (const warning of sheet.warnings) {
    const item = doc.createElement('li');
    item.textContent = warning;
    item.style.marginBottom = '3pt';
    list.appendChild(item);
  }
  add('h2', sheet.usageHeading, { fontSize: '13pt', margin: '0 0 4pt' });
  add('p', sheet.usage, { margin: '0' });
}

/**
 * Opens the browser's print dialog for a minimal one-page view of the kit: a temporary
 * same-origin iframe, filled with textContent and removed once printing ends (or after a
 * generous cap for browsers that never say so). Returns false when it cannot be started.
 */
export function printRecoveryKit(kit: string, created: Date): boolean {
  if (typeof document === 'undefined') return false;
  const sheet = recoveryKitSheet(kit, created);
  const frame = document.createElement('iframe');
  frame.title = sheet.title;
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Rendered but invisible: some browsers print a blank page from a display:none frame.
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0', pointerEvents: 'none' });

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    frame.remove();
  };

  frame.addEventListener('load', () => {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) {
      remove();
      return;
    }
    try {
      fillPrintDocument(doc, sheet);
      win.addEventListener('afterprint', remove);
      win.focus();
      win.print();
    } catch {
      remove();
      return;
    }
    setTimeout(remove, PRINT_FRAME_MAX_LIFETIME_MS);
  }, { once: true });

  frame.srcdoc = PRINT_SHELL;
  document.body.appendChild(frame);
  return true;
}
