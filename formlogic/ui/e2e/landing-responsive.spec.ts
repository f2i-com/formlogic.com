import { expect, test } from '@playwright/test';

test('landing navigation fits phone widths and keeps signup reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'FormLogic primary navigation' });
  await expect(nav).toBeVisible();

  // Resize the mounted desktop header: a fresh mobile load alone misses
  // responsive layout and open-menu state changes.
  for (const width of [390, 375, 320, 640, 899]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    const bounds = await nav.locator('.lv2-nav__actions').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 16);
    const menu = nav.getByRole('button', { name: 'Open navigation' });
    await menu.click();
    await expect(nav.getByRole('link', { name: 'Start free', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
  }

  await nav.getByRole('button', { name: 'Open navigation' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(nav.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  await expect(nav.getByRole('link', { name: 'Product', exact: true })).toBeVisible();
});
