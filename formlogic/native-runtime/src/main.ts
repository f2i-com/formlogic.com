// FormLogic Native Runtime — shell frontend.
//
// The shell holds NO app of its own — just a branded loader and a "no app loaded"
// placeholder. Apps arrive via a deep link / the app's domain and open automatically.
// The runtime remembers the last app and reopens it on launch, so it behaves like a
// dedicated app. There is intentionally no URL entry — links drive everything.
//
// Only an app on a server the runtime knows is remembered and reopened (Rust decides:
// app_may_be_remembered). A link to any other site opens once, after the person agrees in
// a native dialog, and is not reopened at the next launch.

interface NativeBridge {
  available: boolean;
  runtime: {
    getInfo(): Promise<{ name: string; version: string; platform: string }>;
    pendingDeepLink(): Promise<string | null>;
    /** Absent on a bridge that predates it: then nothing is remembered. */
    mayRemember?(url: string): Promise<boolean>;
  };
}

declare global {
  interface Window {
    FormLogicNative?: NativeBridge;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bridge(): NativeBridge | undefined {
  return window.FormLogicNative?.available ? window.FormLogicNative : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const LAST_APP_KEY = "fl.lastApp";
const LAST_BOOT_KEY = "fl.lastBootAt";
// Matches DEEP_LINK_HOME in lib.rs: routes the runtime back to its placeholder.
const HOME_SENTINEL = "\0home";

/** Only http/https URLs are ever navigated to — never javascript:/file:/data:, which
 *  would execute in this privileged shell origin. */
function isOpenable(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Whether the runtime knows the server `url` is on, so the app may be remembered and
 *  reopened at launch. No answer is a no. */
async function mayRemember(b: NativeBridge | undefined, url: string): Promise<boolean> {
  if (!b?.runtime.mayRemember) return false;
  try {
    return (await b.runtime.mayRemember(url)) === true;
  } catch {
    return false;
  }
}

function rememberApp(url: string) {
  try {
    localStorage.setItem(LAST_APP_KEY, url);
  } catch {
    /* ignore */
  }
}
function recallApp(): string | null {
  try {
    return localStorage.getItem(LAST_APP_KEY);
  } catch {
    return null;
  }
}
function forgetApp() {
  try {
    localStorage.removeItem(LAST_APP_KEY);
  } catch {
    /* ignore */
  }
}

/** Open a hosted app in this window. Keeps the loader up through the (blocking)
 *  navigation; the destination page shows a matching loader until it paints. `remember`:
 *  reopen it at the next launch (only for an app on a server the runtime knows). */
function openApp(url: string, remember: boolean, label = "Opening app…") {
  if (!isOpenable(url)) {
    // Refuse anything that isn't a plain web URL; recover to the placeholder.
    forgetApp();
    revealPlaceholder(bridge());
    return;
  }
  $("loading-text").textContent = label;
  $("loading-sub").textContent = hostOf(url);
  $("loading").classList.remove("out");
  $("loading").removeAttribute("hidden");
  if (remember) rememberApp(url); // persist BEFORE navigating so next launch reopens this app
  requestAnimationFrame(() => {
    window.location.href = url;
  });
}

/** The deep-link target the runtime was launched with, if any (retried briefly in case
 *  the launch intent lands just after we boot). */
async function pendingDeepLink(b: NativeBridge | undefined): Promise<string | null> {
  if (!b) return null;
  for (let i = 0; i < 4; i++) {
    try {
      const t = await b.runtime.pendingDeepLink();
      if (t) return t;
    } catch {
      /* ignore */
    }
    await sleep(80);
  }
  return null;
}

/** Reveal the "no app loaded" placeholder (only when nothing has ever been opened). */
function revealPlaceholder(b: NativeBridge | undefined) {
  const label = $("bridge-label");
  const badge = $("bridge-badge");
  if (b) {
    badge.classList.add("ok");
    label.textContent = "connected";
    b.runtime
      .getInfo()
      .then((info) => (label.textContent = `connected · ${info.platform}`))
      .catch(() => {});
  } else {
    badge.classList.add("bad");
    label.textContent = "no bridge";
  }
  $("placeholder").removeAttribute("hidden");
  const el = $("loading");
  el.classList.add("out");
  setTimeout(() => el.setAttribute("hidden", ""), 320);
}

async function boot() {
  const b = bridge();

  // 1) Launched by a deep link.
  const target = await pendingDeepLink(b);
  if (target === HOME_SENTINEL) {
    // formlogic://home — escape a broken remembered app.
    forgetApp();
    revealPlaceholder(b);
    return;
  }
  if (target) {
    // A link to a server the runtime does not know was opened only after the person agreed
    // (lib.rs), and is not remembered: the last known app stays the one reopened.
    openApp(target, await mayRemember(b, target));
    return;
  }

  // 2) Reopen the last app for quick re-entry. Escape hatch: if the runtime was
  //    relaunched within a few seconds (a user trying to get out of a remembered app
  //    that won't load), show the placeholder instead of reopening it again.
  const last = recallApp();
  let bootedRecently = false;
  try {
    const prev = Number(localStorage.getItem(LAST_BOOT_KEY) || 0);
    bootedRecently = prev > 0 && Date.now() - prev < 6000;
    localStorage.setItem(LAST_BOOT_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  if (last && !bootedRecently) {
    if (await mayRemember(b, last)) {
      openApp(last, true, "Reopening app…");
      return;
    }
    // Remembered before the runtime checked what it remembers (any site a link named), or
    // on a server it no longer knows: not reopened.
    forgetApp();
  }
  if (last && bootedRecently) forgetApp(); // double-launch → drop the stuck app

  // 3) Nothing to open — show the placeholder and wait for a link.
  revealPlaceholder(b);
}

window.addEventListener("DOMContentLoaded", boot);

export {};
