/**
 * A full page load of a public form, for its route in the service worker (vite.config.ts).
 *
 * Other sites frame /form/*, which only that path's own response headers allow, so online the
 * network's answer has to stand: the precached index.html says the page must never be framed, and
 * a returning visitor's embed served from it was refused. Offline there is no such answer, and the
 * app shell is what opens a form kept on this device.
 *
 * The function is written into the service worker as its source text (vite-plugin-pwa serialises
 * `urlPattern`), so it must not use anything from outside its own body.
 */
export function isPublicFormNavigation({ request, url }: { request: { mode: string }; url: { pathname: string } }): boolean {
  return request.mode === 'navigate' && url.pathname.startsWith('/form/')
}
