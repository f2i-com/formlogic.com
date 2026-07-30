import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityReview } from './TrustBadge';
import { isConnectorGrant } from '../../lib/packTrust';
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
    // Each grant now leads with a plain-language sentence; the raw id stays visible as
    // secondary detail, so it must appear either way.
    expect(html).toContain('Answer incoming calls on your connected phone');
    expect(html).toContain('connector.aokie.call.answer');
    // The ticked grant does not repeat its "if you leave this off" consequence.
    expect(html).not.toContain('Calls will not be answered for you.');
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
    expect(html).toContain('1 screen modified after signing');
  });

  it('SAFE-002: a fully-modified package still warns when the verified count is zero', () => {
    // The worst case — EVERY signed screen edited after signing — must stay visible.
    // The old render skipped the whole verdict line unless something verified.
    const vendorSigning: PackVendorSigning = {
      signed: true,
      keyId: 'fl-packs-2026a',
      verified: [],
      modified: ['form:tampered', 'app:tampered'],
    };
    const html = renderToStaticMarkup(<CapabilityReview caps={caps} vendorSigning={vendorSigning} />);
    expect(html).toContain('2 screens modified after signing');
  });

  it('an unsigned pack shows no vendor-verified line', () => {
    const html = renderToStaticMarkup(<CapabilityReview caps={caps} vendorSigning={{ signed: false }} />);
    expect(html).not.toContain('verified from the vendor');
  });

  it('SAFE-002: flows, triggers, and App Features render from the restored summary fields', () => {
    const withRestored: PackCapabilitySummary = {
      ...caps,
      flows: 3,
      flowBindings: 1,
      services: [
        { id: 'aokie.receptionist', title: 'Receptionist', description: 'Answers calls', defaultEnabled: true },
        { id: 'aokie.sms', title: 'SMS follow-ups', description: '', defaultEnabled: false },
      ],
    };
    const html = renderToStaticMarkup(<CapabilityReview caps={withRestored} trust="community" />);
    expect(html).toContain('3 flows');
    expect(html).toContain('1 trigger');
    // App Features are labelled as such — NOT as Desktop services (reserved for Package v2).
    expect(html).toContain('App features');
    expect(html).toContain('Receptionist');
    expect(html).toContain('SMS follow-ups (off by default)');
  });

  it('a summary without the restored fields renders no flow/feature chips', () => {
    const html = renderToStaticMarkup(<CapabilityReview caps={caps} trust="community" />);
    expect(html).not.toContain('trigger');
    expect(html).not.toContain('App features');
  });

  it('ADR-010: an Application Package v2 summary renders package meta, nodes, and slots instead of Pack counts', () => {
    const v2: PackCapabilitySummary = {
      forms: 0,
      apps: 0,
      hasScreens: false,
      hasCustomLogic: false,
      logicScripts: 0,
      connectors: [],
      permissions: [],
      connectorGrants: [],
      packageV2: {
        id: 'com.acme.media-tools',
        kind: 'extension',
        version: '1.4.0',
        publisherId: 'com.acme',
        displayName: 'Acme Media Tools',
        description: '',
        nodes: [{ type: 'com.acme.media.generate-image', label: 'Generate image', version: '1.2.0', handlerKind: 'service-action', sideEffects: 'external-write', inline: true }],
        requirementSlots: ['imageGenerator'],
        dependencyCount: 0,
        distributionCount: 0,
      },
    };
    const html = renderToStaticMarkup(<CapabilityReview caps={v2} trust="official" />);
    expect(html).toContain('Acme Media Tools');
    expect(html).toContain('extension');
    expect(html).toContain('Generate image v1.2.0');
    expect(html).toContain('imageGenerator');
    // The zero Pack v1 counts are hidden for a v2 aggregate.
    expect(html).not.toContain('0 forms');
  });
});
