import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityReview, isConnectorGrant } from './TrustBadge';
import type { PackCapabilitySummary, PackVendorSigning } from '../../lib/api';

// APP-502 install review: connector grants become an approve/deny checklist
// when the selection props are supplied; low-risk effect permissions stay
// display-only; the vendor-signing verdict is surfaced.

const caps: PackCapabilitySummary = {
  forms: 2,
  apps: 1,
  hasScreens: true,
  hasCustomLogic: true,
  logicScripts: 1,
  connectors: ['aokie'],
  permissions: [
    'formlogic.responses.write',
    'ui.toast',
    'connector.aokie.call.answer',
    'connector.aokie.sms.send',
    // A flow-declared connector command: in permissions (informational) but
    // NOT reviewable (not in connectorGrants) → must not be a checkbox.
    'connector.aokie.call.dial',
  ],
  connectorGrants: ['connector.aokie.call.answer', 'connector.aokie.sms.send'],
};

describe('isConnectorGrant', () => {
  it('separates powered connector grants from effect permissions', () => {
    expect(isConnectorGrant('connector.aokie.call.answer')).toBe(true);
    expect(isConnectorGrant('ui.toast')).toBe(false);
    expect(isConnectorGrant('formlogic.responses.write')).toBe(false);
  });
});

describe('CapabilityReview', () => {
  it('read-only mode: connector grants render as chips, no checkboxes', () => {
    const html = renderToStaticMarkup(<CapabilityReview caps={caps} trust="community" />);
    expect(html).toContain('connector.aokie.call.answer');
    expect(html).not.toContain('type="checkbox"');
  });

  it('interactive mode: only REVIEWABLE connector grants become checkboxes', () => {
    const selected = new Set(['connector.aokie.call.answer']);
    const html = renderToStaticMarkup(
      <CapabilityReview caps={caps} trust="community" selectedGrants={selected} onToggleGrant={vi.fn()} />,
    );
    // Exactly the two reviewable grants get checkboxes — NOT the flow-declared
    // connector.aokie.call.dial (offering a control that can't be enforced).
    expect(html.match(/type="checkbox"/g)?.length).toBe(2);
    expect(html).toMatch(/checked[^>]*>\s*<span[^>]*>connector\.aokie\.call\.answer/);
    // Effect permissions are shown but never as approve/deny.
    expect(html).toContain('formlogic.responses.write');
    expect(html).toContain('ui.toast');
  });

  it('falls back to permission-filtering when the server sends no connectorGrants', () => {
    const legacy = { ...caps, connectorGrants: undefined };
    const html = renderToStaticMarkup(
      <CapabilityReview caps={legacy} selectedGrants={new Set()} onToggleGrant={vi.fn()} />,
    );
    // Old server: every connector-prefixed permission (incl. call.dial) is reviewable.
    expect(html.match(/type="checkbox"/g)?.length).toBe(3);
  });

  it('surfaces the vendor-signing verdict when screens are vendor-verified', () => {
    const vendorSigning: PackVendorSigning = {
      signed: true,
      keyId: 'fl-packs-2026a',
      verified: ['form:calls', 'app:aokie'],
      modified: ['form:tampered'],
    };
    const html = renderToStaticMarkup(<CapabilityReview caps={caps} vendorSigning={vendorSigning} />);
    expect(html).toContain('2 screens verified');
    expect(html).toContain('1 modified');
  });

  it('an unsigned pack shows no vendor-verified line', () => {
    const html = renderToStaticMarkup(<CapabilityReview caps={caps} vendorSigning={{ signed: false }} />);
    expect(html).not.toContain('verified from the vendor');
  });
});
