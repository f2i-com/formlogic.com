import { describe, expect, it } from 'vitest';
import { OUTSIDE_LINK_LIMIT, outsideLinkOf, shownName } from './outsideLink';

describe('outsideLinkOf: what a hosted app hands its page when a link in it goes elsewhere', () => {
  it('reads a web page, a mail address and a phone number, as the browser reads each', () => {
    expect(outsideLinkOf('https://example.com/a?b=1#c')).toEqual({ href: 'https://example.com/a?b=1#c', kind: 'web', name: 'example.com' });
    expect(outsideLinkOf('http://example.com:8080')).toEqual({ href: 'http://example.com:8080/', kind: 'web', name: 'example.com:8080' });
    expect(outsideLinkOf('mailto:someone@example.com?subject=Hi')).toEqual({ href: 'mailto:someone@example.com?subject=Hi', kind: 'mail', name: 'someone@example.com' });
    expect(outsideLinkOf('tel:+61400000000')).toEqual({ href: 'tel:+61400000000', kind: 'phone', name: '+61400000000' });
  });

  it('names a host as the browser reads it, so one made to look like another site\'s is seen as itself', () => {
    expect(outsideLinkOf('https://bücher.example/')?.name).toBe('xn--bcher-kva.example');
    expect(outsideLinkOf('https://example.com.evil.example/login')?.name).toBe('example.com.evil.example');
    // A mail address's domain too: a Cyrillic "а" in "apple.com" is not shown as an "a".
    expect(outsideLinkOf('mailto:support@%D0%B0pple.com')?.name).toBe('support@xn--pple-43d.com');
    // Every address a mail goes to is named, however many.
    const many = Array.from({ length: 12 }, (_, i) => `person${i}@example.com`).join(',');
    expect(outsideLinkOf(`mailto:${many},hidden@evil.example`)?.name).toContain('hidden@evil.example');
  });

  it('shows a long name by its end, which says where it goes', () => {
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.example.com`;
    expect(shownName(host)).toMatch(/^….*\.example\.com$/);
    expect(shownName(host).length).toBe(80);
    expect(shownName('example.com')).toBe('example.com');
  });

  it('takes nothing else', () => {
    for (const value of [
      undefined, null, 7, {}, '', 'not an address', '/about.html', '//example.com/x',
      'javascript:alert(1)', 'data:text/html,x', 'blob:null/1', 'file:///C:/x', 'ftp://example.com/',
      'https://bank.example.com@evil.example/', 'https://user:pass@example.com/', 'mailto:', 'tel:',
      `https://example.com/${'a'.repeat(OUTSIDE_LINK_LIMIT)}`, 'https://example.com/\u0007', 'mailto:%0Asomeone@example.com',
      // What turns text round, takes no space, or is a control of the second range, written or %-encoded.
      'mailto:moc.elppa@%E2%80%AEevil.example', 'mailto:support@app%E2%80%8Ble.com', 'mailto:a%C2%85b@example.com', 'tel:+61%E2%80%AE400',
      'mailto:support@ex­ample.com', 'mailto:not-an-address', 'mailto:@example.com', 'mailto:someone@',
      // A host longer than a name server answers for.
      `https://${'a.'.repeat(130)}example/`,
    ]) {
      expect(outsideLinkOf(value), String(value).slice(0, 40)).toBeNull();
    }
  });
});
