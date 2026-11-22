// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  buildFormLogicGuideContext,
  classifyGuideRoute,
  isGuideHiddenPath,
} from './formlogicAiml';

describe('formlogicAiml', () => {
  it('classifies public and workspace routes accurately', () => {
    expect(classifyGuideRoute('/', false)).toBe('landing');
    expect(classifyGuideRoute('/', true)).toBe('dashboard');
    expect(classifyGuideRoute('/dashboard', false)).toBe('dashboard');
    expect(classifyGuideRoute('/packs', false)).toBe('marketplace');
    expect(classifyGuideRoute('/apps', true)).toBe('apps');
    expect(classifyGuideRoute('/apps/abc/settings', true)).toBe('app-settings');
    expect(classifyGuideRoute('/apps/abc/studio/data', true)).toBe('app-studio');
    expect(classifyGuideRoute('/apps/abc/web/edit', true)).toBe('softn-workspace');
    expect(classifyGuideRoute('/builder/form-1', true)).toBe('form-builder');
    expect(classifyGuideRoute('/responses/form-1', true)).toBe('responses');
    expect(classifyGuideRoute('/analytics/form-1', true)).toBe('responses');
    expect(classifyGuideRoute('/forms', true)).toBe('forms');
    expect(classifyGuideRoute('/flows', true)).toBe('flows');
    expect(classifyGuideRoute('/diagrams', true)).toBe('flows');
    expect(classifyGuideRoute('/settings', true)).toBe('settings');
  });

  it('hides the platform guide on customer-facing public forms and live app runtimes', () => {
    expect(isGuideHiddenPath('/form/xyz')).toBe(true);
    expect(isGuideHiddenPath('/app/my-crm')).toBe(true);
    expect(isGuideHiddenPath('/app/my-crm/records')).toBe(true);
    expect(isGuideHiddenPath('/preview/xyz')).toBe(true);
    expect(isGuideHiddenPath('/')).toBe(false);
    expect(isGuideHiddenPath('/packs')).toBe(false);
    expect(isGuideHiddenPath('/builder/form-1')).toBe(false);
    expect(isGuideHiddenPath('/apps/abc/settings')).toBe(false);
  });

  it('emits well-formed AIML 2.0 XML with route-aware tours across every FormLogic route', () => {
    const parser = new DOMParser();
    const cases: Array<[string, boolean, string]> = [
      ['/', false, 'hero'],
      ['/packs', false, 'marketplace-catalog'],
      ['/builder/form-1', true, 'builder-palette'],
      ['/apps/abc/studio/data', true, 'studio-nav'],
      ['/apps/abc/settings', true, 'app-icon-picker'],
      ['/flows', true, 'flows-canvas'],
      ['/settings', true, 'settings-guide'],
      ['/apps', true, 'apps-toolbar'],
      ['/dashboard', true, 'sidebar-nav'],
    ];

    for (const [path, signedIn, expectedTarget] of cases) {
      const ctx = buildFormLogicGuideContext(path, signedIn, 'Aria');
      const doc = parser.parseFromString(ctx.aimlXml, 'application/xml');
      expect(doc.querySelector('parsererror'), `XML parse error on ${path}`).toBeNull();
      expect(ctx.aimlXml).toContain(`<stop target="${expectedTarget}">`);
    }
  });

  it('covers comprehensive FormLogic topics and safely merges custom AIML', () => {
    const ctx = buildFormLogicGuideContext(
      '/builder/form-1',
      true,
      'Chloe',
      '<aiml version="2.0"><category><pattern>HELLO CUSTOM</pattern><template>Hi there!</template></category></aiml>',
    );
    expect(ctx.greeting).toContain('Form Builder');
    expect(ctx.aimlXml).toContain('<pattern>HELLO CUSTOM</pattern>');
    expect(ctx.aimlXml.match(/<aiml /g)?.length).toBe(1);
    for (const topic of ['ZIPP', 'AOKIE', 'OAIY', 'MCP', 'LIBSODIUM', 'BLUEPRINT', 'MODULAR PLUGIN', 'FIELD TYPES']) {
      expect(ctx.aimlXml).toContain(topic);
    }

    // Reject script injection inside custom AIML
    const blocked = buildFormLogicGuideContext('/settings', true, 'Aria', '<script>alert(1)</script>');
    expect(blocked.aimlXml).not.toContain('<script>');
  });
});
