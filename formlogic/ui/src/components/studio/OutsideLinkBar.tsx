import { useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";
import { ExternalLink, Mail, Phone, X } from "lucide-react";
import { shownName, type OutsideLink } from "../../lib/outsideLink";

/**
 * How long after an address is shown its Open does nothing: a press meant for the app (an Enter, a
 * double click, a run of taps) that lands on the bar as it appears opens nothing the person has not
 * read. A press begun before then starts it over.
 */
export const OPEN_SETTLE_MS = 600;

/**
 * A link in a hosted app to another site, a mail address or a phone number, shown over the app
 * (HostedAppFrame, from SoftN's `{ type: 'link', href }`). The app's frame can open nothing: it is
 * sandboxed with scripts alone. So the page says where the link goes, the host as the browser reads
 * it and the whole address, and opens it in a new tab only when the person presses Open: the app is
 * anyone's code, and nothing it does on its own sends anyone elsewhere. Escape, the close button or
 * Stay here put it away; a newer link takes its place.
 *
 * Open is a button, not a link: a link is followed by a middle click, a drag to the tab bar or its
 * context menu too, none of which wait. It waits OPEN_SETTLE_MS from when the address is shown, armed
 * before the bar is painted and again for each newer address, and a press that began before then
 * starts the wait over, so a run of presses meant for the app never reaches it. Every kind opens in a
 * tab of its own, a mail address and a number too: with a web mail handler, the browser took this
 * page to it.
 *
 * The keyboard comes to the bar itself, never to Open, and only from the app's frame (where the
 * link was clicked): a key meant for the app opens nothing, and a page typing elsewhere is not
 * taken from.
 */
export function OutsideLinkBar({ link, onClose }: { link: OutsideLink; onClose: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  /** When Open may next be pressed. */
  const readyAt = useRef(Number.POSITIVE_INFINITY);
  /** When the press under way began, if it began once Open was ready. */
  const pressedAt = useRef<number | null>(null);
  // Armed before the bar, or the newer address in it, is painted: armed in an effect after, a
  // press already on its way was timed from the address before, or from nothing.
  useLayoutEffect(() => {
    readyAt.current = performance.now() + OPEN_SETTLE_MS;
    pressedAt.current = null;
    const at = document.activeElement;
    if (at === null || at === document.body || at.tagName === "IFRAME") bar.current?.focus();
  }, [link.href]);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  /** A pointer's press of Open beginning: timed from now once Open is ready; one before starts the wait over and opens nothing. */
  const begin = () => {
    const now = performance.now();
    if (now < readyAt.current) {
      readyAt.current = now + OPEN_SETTLE_MS;
      pressedAt.current = Number.NEGATIVE_INFINITY;
    } else {
      pressedAt.current = now;
    }
  };
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const now = performance.now();
    // A pointer's click is timed from when its press began. One from the keyboard (Enter, Space), or
    // one that came with no press this bar saw (a screen reader's), is its own press.
    const began = event.detail === 0 ? now : (pressedAt.current ?? now);
    pressedAt.current = null;
    if (began < readyAt.current) {
      readyAt.current = Math.max(readyAt.current, now + OPEN_SETTLE_MS);
      return;
    }
    // A tab of its own, which cannot reach back into this one; this page stays.
    window.open(link.href, "_blank", "noopener,noreferrer");
    closeRef.current();
  };
  const Icon = link.kind === "mail" ? Mail : link.kind === "phone" ? Phone : ExternalLink;
  const lead = link.kind === "mail" ? "This app wants to write to" : link.kind === "phone" ? "This app wants to call" : "This app links to";
  const action = link.kind === "mail" ? "Write email" : link.kind === "phone" ? "Call" : "Open link";
  return (
    <div
      ref={bar}
      role="dialog"
      aria-label="A link out of the app"
      tabIndex={-1}
      className="absolute inset-x-0 top-3 z-20 mx-auto w-[min(32rem,calc(100%-1.5rem))] rounded-xl border border-slate-200 bg-white p-3 shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 flex-none text-slate-500 dark:text-slate-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-800 dark:text-slate-100">
            {lead} <strong className="break-all font-semibold" title={link.name}>{shownName(link.name)}</strong>
          </p>
          {/* The whole address, whatever it is to: a mail's copies and words are in it. It scrolls, so Open and Stay here stay in view. */}
          <p className="mt-0.5 max-h-16 overflow-y-auto break-all font-mono text-xs text-slate-500 dark:text-slate-400">
            {link.href}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onPointerDown={begin}
              onClick={open}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary-600 px-3 text-xs font-semibold text-primary-foreground hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {action}
              {link.kind === "web" && <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={() => closeRef.current()}
              className="inline-flex h-8 items-center rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Stay here
            </button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => closeRef.current()}
          className="-m-1 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
