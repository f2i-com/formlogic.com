import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RemoteAccessPolicySection } from './AokieCompanionAdminSections';

const policy = {
  configured: true,
  remoteMonitoring: true,
  remoteConsult: true,
  remoteTakeover: false,
  remoteCaptions: true,
  remoteAssistance: false,
};

describe('RemoteAccessPolicySection', () => {
  it('renders the versioned disclosure and truthful read-only member state', () => {
    const html = renderToStaticMarkup(
      <RemoteAccessPolicySection
        policy={policy}
        draft={policy}
        canManage={false}
        saving={false}
        disclosureAccepted={false}
        advertisedFeatures={['monitor', 'consult', 'captions']}
        onChange={vi.fn()}
        onDisclosureAccepted={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(html).toContain('Aokie remote-access policy v2');
    expect(html).toContain('Remote monitoring');
    expect(html).toContain('Typed assistance');
    expect(html).toContain('Private voice consultation');
    expect(html).toContain('Consult microphones are never routed to the caller');
    expect(html).toContain('Advertised by signed discovery');
    expect(html).toContain('does not include Manage Aokie Companion access');
    expect(html).not.toContain('Save remote policy');
  });

  it('requires explicit disclosure acknowledgement before an enabled policy can be saved', () => {
    const html = renderToStaticMarkup(
      <RemoteAccessPolicySection
        policy={{ ...policy, remoteTakeover: false }}
        draft={{ ...policy, remoteTakeover: true }}
        canManage
        saving={false}
        disclosureAccepted={false}
        advertisedFeatures={['monitor', 'consult', 'captions']}
        onChange={vi.fn()}
        onDisclosureAccepted={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(html).toContain('Save remote policy');
    expect(html).toContain('disabled=""');
    expect(html).toContain('may expose live caller audio');
  });
});
