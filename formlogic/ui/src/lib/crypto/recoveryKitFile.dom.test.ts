// @vitest-environment jsdom
// Download and print of the recovery kit (plan D5): the browser is handed a text file
// through a Blob URL that is revoked afterwards, or a minimal print view in a temporary
// iframe that is removed when printing ends — and the kit goes nowhere else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLOB_URL_REVOKE_DELAY_MS,
  PRINT_FRAME_MAX_LIFETIME_MS,
  downloadRecoveryKit,
  printRecoveryKit,
  recoveryKitSheet,
  recoveryKitText,
} from './recoveryKitFile';

const KIT = 'FLRK1-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST-UVWX';
const CREATED = new Date(2026, 8, 29, 12, 0, 0);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Only setTimeout is faked: Blob.text() and friends need the real event loop.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('downloadRecoveryKit', () => {
  let blobs: Blob[];
  let clicks: { href: string; download: string; inDocument: boolean }[];
  let createObjectURL: ReturnType<typeof vi.spyOn>;
  let revokeObjectURL: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    blobs = [];
    clicks = [];
    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return `blob:kit-test/${blobs.length}`;
    });
    revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download, inDocument: this.isConnected });
    });
  });

  it('hands the browser a text file with the kit, the date and a warning', async () => {
    downloadRecoveryKit(KIT, CREATED);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(blobs[0].type).toBe('text/plain;charset=utf-8');
    const content = await blobs[0].text();
    expect(content).toBe(recoveryKitText(recoveryKitSheet(KIT, CREATED)));
    expect(content).toContain(`    ${KIT}\n`);
    expect(content).toContain('Created: 2026-09-29');
    expect(content).toContain('FormLogic cannot recover them for you.');
    expect(clicks).toEqual([{
      href: 'blob:kit-test/1',
      download: 'formlogic-vault-recovery-kit-2026-09-29.txt',
      inDocument: true,
    }]);
    // The temporary link does not stay in the page.
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('revokes the Blob URL afterwards — once, and not before the browser has had time to read it', () => {
    downloadRecoveryKit(KIT, CREATED);

    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BLOB_URL_REVOKE_DELAY_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:kit-test/1');
    vi.advanceTimersByTime(BLOB_URL_REVOKE_DELAY_MS * 10);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('revokes the URL even when the click fails', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked'); });

    expect(() => downloadRecoveryKit(KIT, CREATED)).toThrow('blocked');
    vi.advanceTimersByTime(BLOB_URL_REVOKE_DELAY_MS);

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:kit-test/1');
  });

  it('sends the kit nowhere: no request is made', () => {
    downloadRecoveryKit(KIT, CREATED);
    vi.advanceTimersByTime(BLOB_URL_REVOKE_DELAY_MS);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('printRecoveryKit', () => {
  // The iframe's own window/document stand-ins: a real (jsdom) Document to be filled, and a
  // window whose print() is observable.
  let printDoc: Document;
  let win: { focus: ReturnType<typeof vi.fn>; print: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> };
  const frame = () => document.querySelector('iframe');
  const finishLoading = () => frame()!.dispatchEvent(new Event('load'));
  const afterPrint = () => (win.addEventListener.mock.calls.find(([type]) => type === 'afterprint')![1] as () => void)();

  beforeEach(() => {
    printDoc = document.implementation.createHTMLDocument('');
    win = { focus: vi.fn(), print: vi.fn(), addEventListener: vi.fn() };
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(win as unknown as Window);
    vi.spyOn(HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(printDoc);
  });

  it('opens the print dialog for a minimal view holding the kit, the date and the warning', () => {
    expect(printRecoveryKit(KIT, CREATED)).toBe(true);
    // The frame starts as a static shell — the kit is never part of any markup string.
    expect(frame()).not.toBeNull();
    expect(frame()!.srcdoc).not.toContain(KIT);
    expect(win.print).not.toHaveBeenCalled();

    finishLoading();

    expect(win.print).toHaveBeenCalledTimes(1);
    const text = printDoc.body.textContent ?? '';
    expect(text).toContain('FormLogic vault recovery kit');
    expect(text).toContain('Created: 2026-09-29');
    expect(text).toContain(KIT);
    expect(text).toContain('FormLogic cannot recover them for you.');
    expect(text).toContain('choose "Use recovery kit"');
    expect(printDoc.querySelector('pre')?.textContent).toBe(KIT);
    expect(printDoc.title).toBe('FormLogic vault recovery kit');
    expect(printDoc.querySelectorAll('script, link, img, iframe')).toHaveLength(0);
  });

  it('removes the frame — and with it the kit — when printing ends', () => {
    printRecoveryKit(KIT, CREATED);
    finishLoading();
    expect(frame()).not.toBeNull();

    afterPrint();

    expect(frame()).toBeNull();
  });

  it('removes the frame after a cap when a browser never reports the end of printing', () => {
    printRecoveryKit(KIT, CREATED);
    finishLoading();

    vi.advanceTimersByTime(PRINT_FRAME_MAX_LIFETIME_MS - 1);
    expect(frame()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(frame()).toBeNull();
  });

  it('removes the frame when the print dialog cannot be opened', () => {
    win.print.mockImplementation(() => { throw new Error('print blocked'); });

    expect(printRecoveryKit(KIT, CREATED)).toBe(true);
    finishLoading();

    expect(frame()).toBeNull();
  });

  it('renders text, never markup: a hostile string cannot inject anything into the view', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

    printRecoveryKit(hostile, CREATED);
    finishLoading();

    expect(printDoc.querySelector('img, script')).toBeNull();
    expect(printDoc.querySelector('pre')?.textContent).toBe(hostile);
  });

  it('sends the kit nowhere: no request is made', () => {
    printRecoveryKit(KIT, CREATED);
    finishLoading();
    afterPrint();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
