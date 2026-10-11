import { expect, type FrameLocator } from '@playwright/test';

/**
 * Show AI Studio's chat panel and wait for its message box.
 *
 * The rail's "AI" button is a toggle, and whether the panel is open once Studio
 * has taken a project depends on the Softn release it came from. Through
 * v0.0.18 Studio closed the panel as it imported the project, so a click
 * opened it; from v0.0.19 the import leaves it open, and the same click closes
 * it. The button says which way it is with aria-pressed in both, so it is
 * pressed only when it is not already.
 *
 * Call it once Studio has finished taking the project (the host's "Review
 * changes" or "Save changes" is enabled): the panel's state moves while the
 * import runs.
 */
export async function openStudioAiPanel(frame: FrameLocator): Promise<void> {
  const ai = frame.getByRole('button', { name: 'AI', exact: true });
  await expect(ai).toBeVisible();
  if ((await ai.getAttribute('aria-pressed')) !== 'true') await ai.click();
  await expect(frame.getByRole('textbox', { name: 'Message to AI' })).toBeVisible();
}
