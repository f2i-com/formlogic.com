import { describe, expect, it } from 'vitest';
import {
  WEBSITE_AI_ROUTE_MATRIX,
  resolveWebsiteAiRoute,
  type WebsiteAiOperation,
} from './websiteAiRouting';

const EXPECTED_OPERATIONS: WebsiteAiOperation[] = [
  'form.create.text',
  'form.edit.text',
  'form.create.photo',
  'form.create.document',
  'app.plan',
  'app.form.generate',
  'screen.generate',
  'script.generate',
  'script.improve',
];

describe('website AI routing audit', () => {
  it('keeps the reviewed generation surface exhaustive and hosted-capable', () => {
    expect(Object.keys(WEBSITE_AI_ROUTE_MATRIX)).toEqual(EXPECTED_OPERATIONS);
    for (const operation of EXPECTED_OPERATIONS) {
      expect(resolveWebsiteAiRoute(operation, 'hosted')).toBe('hosted');
    }
  });

  it('routes only new text forms to a selected Desktop provider and never silently falls back', () => {
    expect(resolveWebsiteAiRoute('form.create.text', 'desktop-provider')).toBe('desktop-provider');
    for (const operation of EXPECTED_OPERATIONS.filter((item) => item !== 'form.create.text')) {
      expect(resolveWebsiteAiRoute(operation, 'desktop-provider')).toBe('unsupported');
    }
  });
});
