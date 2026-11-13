// The value this browser keeps for one hosted JavaScript app's frame.
//
// A JavaScript app's files are served from an address that admits whoever holds it (its page has
// no origin, so its requests carry no session). The server writes this value into that address
// (NativeAppService::siteTicket), which makes the address this browser's own: someone else who
// opens the same app gets another, and what their page is told to prove itself to the page that
// frames it is of no use here. Kept, so the address stays the same from one opening to the next
// and the browser keeps the files it has fetched. It is kept in this site's own storage, which a
// hosted app cannot read.

/** What the server takes as a frame's value (NativeAppService::SITE_FRAME_VALUE). */
const FRAME_VALUE = /^[a-f0-9]{32}$/;

/** The value for one app, by the name in its address: the one kept, or one made now and kept. */
export function siteFrameValue(slug: string): string {
  const key = `formlogic-site-frame:${slug}`;
  try {
    const kept = window.localStorage.getItem(key);
    if (kept && FRAME_VALUE.test(kept)) return kept;
  } catch { /* No storage to read: made afresh below, for this opening. */ }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const made = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  try { window.localStorage.setItem(key, made); } catch { /* Not kept: the next opening makes another. */ }
  return made;
}
