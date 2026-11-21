// Which page an address belongs to. The app remounts everything when the page changes (its error
// boundary is keyed by it), so the addresses inside one app shell must share a place:
//  - A SoftN app's sections and open tables (`/apps/:id/web/*`) stay mounted as one place.
//  - An app's Studio steps and management tools (`/apps/:id/studio/*`, `/apps/:id/settings`,
//    `/apps/:id/records`, `/apps/:id/forms`, `/apps/:id/users`, `/apps/:id/roles`,
//    `/apps/:id/relations`, `/apps/:id/deploy`) share one place so switching sections never
//    remounts the sidebar or studio shell.
//  - A live Form App's internal screens (`/app/:slug`, `/app/:slug/form/*`, `/app/:slug/records`,
//    `/app/:slug/reports`, `/app/:slug/profile`, `/app/:slug/aokie`) share one place so clicking
//    menu items loads only that section's data via AJAX without reloading the app.
// Kept apart from lib/softnApps so the first screen's code does not take that module's imports with it.

export function pagePlace(pathname: string): string {
  if (/^\/apps\/[^/]+\/web(?:\/|$)/.test(pathname)) {
    return pathname.replace(/^(\/apps\/[^/]+\/web)(?:\/.*)?$/, '$1');
  }
  if (/^\/apps\/(?!new(?:\/|$))[^/]+\/(?:studio|settings|records|forms|users|roles|relations|deploy)(?:\/|$)/.test(pathname)) {
    return pathname.replace(/^(\/apps\/[^/]+)\/.*$/, '$1/manage');
  }
  if (/^\/app\/[^/]+(?:\/(?!native(?:\/|$)|project(?:\/|$)).*)?$/.test(pathname)) {
    return pathname.replace(/^(\/app\/[^/]+)(?:\/.*)?$/, '$1');
  }
  return pathname;
}
