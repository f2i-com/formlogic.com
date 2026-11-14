/**
 * A link a hosted app hands its page, from SoftN's frame (`{ type: 'link', href }`, `links: 1`):
 * the person clicked a link in the app to another site, a mail address or a phone number. The
 * frame can open nothing itself (it is sandboxed with scripts alone), and before it handed such a
 * link on, following one took the frame off the app and the app was stopped.
 *
 * The page shows the address and opens it only when the person says so (HostedAppFrame): the app
 * is anyone's code, and what it links to is shown as the browser reads it, host first, so that an
 * address made to look like another site's is seen for what it is. This is the reading: the frame
 * checked the address too, and it is checked again here, because it is the frame's word.
 */

/** The most characters an address may have, as the frame sends them (SoftN's links.ts). */
export const OUTSIDE_LINK_LIMIT = 2000;

/** The longest host a name server answers for (253 characters): a longer one is no site's. */
const HOST_LIMIT = 253;

/** A link to the outside, as the page shows and opens it. */
export interface OutsideLink {
  /** The address, as the browser reads it. */
  href: string;
  /** What it is to: a web page, a mail address or a phone number. */
  kind: 'web' | 'mail' | 'phone';
  /**
   * What the page names it by: a web page's host (as the browser reads it, so punycode stays
   * punycode), the mail addresses (each domain the same way) or the number.
   */
  name: string;
}

/**
 * Text a person sees all of: no control character (C0 or C1), nothing that turns the text's
 * direction round (so `moc.elppa` cannot read as `apple.com`), and nothing that takes no space
 * (a zero-width space or joiner, a soft hyphen), each of which can make one address read as
 * another, or hide part of it.
 */
function printable(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
    if (code === 0x00ad || code === 0x034f || code === 0x061c || code === 0x115f || code === 0x1160 || code === 0x180e) return false;
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x206f)) return false;
    if (code === 0x3164 || code === 0xfeff || code === 0xffa0 || (code >= 0xfff0 && code <= 0xfffb)) return false;
  }
  return true;
}

/**
 * The mail addresses a `mailto:` names, each domain as the browser reads a host (so a letter of
 * another alphabet that looks like a Latin one shows as the `xn--` it is), or null where one is
 * no address.
 */
function mailNames(target: string): string | null {
  const names: string[] = [];
  for (const address of target.split(',')) {
    const trimmed = address.trim();
    if (trimmed === '') continue;
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1) return null;
    let domain: string;
    try {
      domain = new URL(`http://${trimmed.slice(at + 1)}/`).hostname;
    } catch {
      return null;
    }
    if (domain === '' || domain.length > HOST_LIMIT) return null;
    names.push(`${trimmed.slice(0, at)}@${domain}`);
  }
  return names.length ? names.join(', ') : null;
}

/**
 * What the frame handed on, read as a link to the outside, or null for anything that is not one:
 * not text, longer than the limit, a character a person cannot see all of (above; in a mail
 * address or number also where it was written `%E2%80%AE`), another scheme, a web address with no
 * host, a host longer than any site's, or a name and password before it
 * (`https://bank.example@evil.example/`), a mail address that is none, a mail address or number
 * that is empty.
 *
 * The bar shows the whole address besides the name (OutsideLinkBar), so what follows the name in
 * it (a mail's copies, `cc` and `bcc`, its words) is seen too.
 */
export function outsideLinkOf(value: unknown): OutsideLink | null {
  if (typeof value !== 'string' || value === '' || value.length > OUTSIDE_LINK_LIMIT || !printable(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // (`url.href` itself is ASCII, everything else in it written `%XX`, and the bar shows it so: only
  // what is shown decoded, a host, a mail address or a number, is read for what a person would see)
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.username !== '' || url.password !== '' || url.hostname === '' || url.hostname.length > HOST_LIMIT) return null;
    return { href: url.href, kind: 'web', name: url.host };
  }
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
    let target: string;
    try {
      target = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    // A line break written into the address (`%0A`) is a way to add to the mail's headers: refused, not trimmed away.
    if (!printable(target)) return null;
    target = target.trim();
    if (target === '') return null;
    if (url.protocol === 'tel:') return { href: url.href, kind: 'phone', name: target };
    const names = mailNames(target);
    return names === null ? null : { href: url.href, kind: 'mail', name: names };
  }
  return null;
}

/**
 * A name as the bar shows it on one line: whole, or, where it is longer than `most`, its end, which
 * is what says where it goes (a host's own domain is its last part).
 */
export function shownName(name: string, most = 80): string {
  return name.length <= most ? name : `…${name.slice(name.length - (most - 1))}`;
}
