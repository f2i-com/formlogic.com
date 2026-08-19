/**
 * Routes that own the bottom edge of a phone screen: inside them, nothing floats
 * over the content except the global MobileNav and transient modal layers.
 *
 * This replaces `uiStore.fixedBottomBar`, a flag that no component set any more —
 * the App Studio stopped setting it when its fixed Previous/Next footer was
 * removed, so its two consumers (the chat launcher and the desktop chip) sat
 * permanently at the bottom of the studio, stacked over the mobile nav and over
 * whatever the section's last control happened to be.
 *
 * A route predicate is used rather than a store flag because it is pure, cannot
 * leak on an abnormal unmount, and is unit-testable without a DOM.
 */
export function pathClaimsBottomEdge(pathname: string): boolean {
  return /^\/apps\/[^/]+\/studio(\/|$)/.test(pathname);
}
