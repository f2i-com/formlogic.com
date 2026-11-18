import { expect, test } from '@playwright/test';

test('presentation controls leave the form title visible on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route('**/api/public/forms/workshop', route => route.fulfill({
    json: {
      form: {
        id: 'workshop', title: 'Workshop registration', status: 'published',
        description: 'Reserve a place at the workshop.',
        fields: [{ id: 'name', type: 'short_text', label: 'Your name', required: true }],
        settings: { presentationMode: 'both', showNigoDashboard: true }, theme: {},
      },
    },
  }));
  await page.goto('/form/workshop');
  const mode = page.getByRole('group', { name: 'Presentation mode' });
  const title = page.getByRole('heading', { name: 'Workshop registration' });
  for (const label of ['One at a time', 'All questions']) {
    await mode.getByRole('button', { name: label }).click();
    await expect(title).toBeInViewport();
    const controls = await mode.boundingBox();
    const heading = await title.boundingBox();
    expect(controls!.y + controls!.height).toBeLessThanOrEqual(heading!.y);
    await expect(page.getByRole('textbox', { name: /Your name/ })).toBeVisible();
  }
});
