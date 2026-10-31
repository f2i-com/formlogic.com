import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPublicFormNavigation } from './swRoutes';

const at = (path: string, mode = 'navigate') => ({ request: { mode }, url: new URL(path, 'https://forms.example.test') });

describe('isPublicFormNavigation', () => {
  it('is a page load of a public form', () => {
    expect(isPublicFormNavigation(at('/form/f1'))).toBe(true);
    expect(isPublicFormNavigation(at('/form/f1?embed=1'))).toBe(true);
  });

  it('is not a request a form page makes, or another page', () => {
    expect(isPublicFormNavigation(at('/form/f1', 'cors'))).toBe(false);
    expect(isPublicFormNavigation(at('/forms'))).toBe(false);
    expect(isPublicFormNavigation(at('/app/cafe/form/f1'))).toBe(false);
  });

  it('survives being written into the service worker as text', () => {
    const rebuilt = new Function(`return (${isPublicFormNavigation.toString()})`)() as typeof isPublicFormNavigation;
    expect(rebuilt(at('/form/f1'))).toBe(true);
  });
});

// The route only does its work with both halves: left to the navigation fallback, an embed gets the
// precached page and is refused; without the precache fallback, /form/* has no page offline.
describe('the service worker configuration', () => {
  const config = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

  it('keeps /form/* out of the navigation fallback', () => {
    const allowlist = /navigateFallbackAllowlist: \[\/(.+)\/\]/.exec(config)?.[1] ?? '';
    const matches = new RegExp(allowlist);
    expect(matches.test('/forms')).toBe(true);
    expect(matches.test('/form/f1')).toBe(false);
  });

  it('answers /form/* from the network, and from the precached shell offline', () => {
    const route = /\{\s*urlPattern: isPublicFormNavigation,[\s\S]*?\n {10}\},/.exec(config)?.[0] ?? '';
    expect(route).toContain("handler: 'NetworkOnly'");
    expect(route).toMatch(/precacheFallback: \{ fallbackURL: 'index\.html' \}/);
  });
});
