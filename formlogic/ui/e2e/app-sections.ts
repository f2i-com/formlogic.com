import type { Page } from '@playwright/test';

/** Resolve the active dock or open the section picker when the workspace is narrow. */
export async function appSections(page: Page) {
  const shortcuts = page.getByRole('navigation', { name: 'App shortcuts', exact: true });
  const sections = page.getByRole('navigation', { name: 'App sections', exact: true });
  const trigger = page.getByRole('button', { name: 'Sections', exact: true });
  await shortcuts.or(sections).or(trigger).first().waitFor();
  if (await trigger.isVisible() && await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
  // Closing and reopening an editor can register its horizontal dock on the next paint.
  return shortcuts.or(sections).first();
}

export async function openAppSection(page: Page, name: string) {
  await (await appSections(page)).getByRole('link', { name, exact: true }).click();
}
