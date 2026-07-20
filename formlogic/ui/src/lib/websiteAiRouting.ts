/**
 * Audited website-generation routing policy.
 *
 * A Desktop provider is not a drop-in replacement for hosted endpoints that
 * perform file extraction or validate executable scripts/screens. Keep this
 * table exhaustive so adding a new website AI surface requires an explicit
 * transport decision instead of accidentally sending it to the default route.
 */
export const WEBSITE_AI_ROUTE_MATRIX = {
  'form.create.text': { hosted: true, desktopProvider: true },
  'form.edit.text': { hosted: true, desktopProvider: false },
  'form.create.photo': { hosted: true, desktopProvider: false },
  'form.create.document': { hosted: true, desktopProvider: false },
  'app.plan': { hosted: true, desktopProvider: false },
  'app.form.generate': { hosted: true, desktopProvider: false },
  'screen.generate': { hosted: true, desktopProvider: false },
  'script.generate': { hosted: true, desktopProvider: false },
  'script.improve': { hosted: true, desktopProvider: false },
} as const;

export type WebsiteAiOperation = keyof typeof WEBSITE_AI_ROUTE_MATRIX;
export type WebsiteAiRequestedRoute = 'hosted' | 'desktop-provider';
export type WebsiteAiResolvedRoute = WebsiteAiRequestedRoute | 'unsupported';

/**
 * Resolve only an explicitly selected route. A failed or unsupported Desktop
 * selection never silently spends hosted quota (or runs the request twice).
 */
export function resolveWebsiteAiRoute(
  operation: WebsiteAiOperation,
  requested: WebsiteAiRequestedRoute,
): WebsiteAiResolvedRoute {
  const policy = WEBSITE_AI_ROUTE_MATRIX[operation];
  if (requested === 'desktop-provider') {
    return policy.desktopProvider ? 'desktop-provider' : 'unsupported';
  }
  return policy.hosted ? 'hosted' : 'unsupported';
}
