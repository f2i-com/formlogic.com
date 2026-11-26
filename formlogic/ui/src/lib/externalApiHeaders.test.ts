// An app's External API sends the owner's custom response headers, but only the names the server
// knows to speak for the one answer they are on (AppService::sanitizeExternalApi). The rest it
// drops without a word, so the settings page works out the same answer beforehand to say which and
// why. Its lists are a copy of the server's: the first test reads the PHP and fails when they part.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTED_ON_HEADERS, ACTED_ON_PREFIXES, MAX_HEADER_NAME, MAX_HEADER_VALUE_BYTES, MAX_HEADERS, RESPONSE_HEADERS,
  checkCustomHeaders, headersNotStored,
} from './externalApiHeaders';

const php = readFileSync(resolve(__dirname, '../../../backend/src/Services/AppService.php'), 'utf8');

/** The strings of the list the server's method assigns to `$name`. */
function serverList(name: string): string[] {
  const body = new RegExp(`\\$${name} = \\[([^\\]]*)\\];`).exec(php)?.[1];
  expect(body, `$${name} in AppService.php`).toBeTruthy();
  return [...body!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}
const serverNumber = (pattern: RegExp) => Number(pattern.exec(php)?.[1]);

const names = (text: string) => Object.keys(checkCustomHeaders(text).kept);
const whyNot = (text: string) => Object.fromEntries(checkCustomHeaders(text).dropped.map((header) => [header.name, header.why]));

describe('the custom headers an External API keeps', () => {
  it('are decided by the lists and limits the server holds (AppService::sanitizeExternalApi)', () => {
    expect(serverList('responseHeaders')).toEqual([...RESPONSE_HEADERS]);
    expect(serverList('actedOnHeaders')).toEqual([...ACTED_ON_HEADERS]);
    expect(serverList('actedOnPrefixes')).toEqual([...ACTED_ON_PREFIXES]);
    expect(serverNumber(/strlen\(\$hk\) > (\d+)/)).toBe(MAX_HEADER_NAME);
    expect(serverNumber(/strlen\(\$hv\) > (\d+)/)).toBe(MAX_HEADER_VALUE_BYTES);
    expect(serverNumber(/count\(\$customHeaders\) >= (\d+)/)).toBe(MAX_HEADERS);
  });

  // The server's own examples (ExternalAppApiPolicyTest::testCustomHeadersKeepOnlyNamesThatSpeakForTheOneResponse).
  it('are the ones that speak for the one answer, and no header a browser keeps for the whole site', () => {
    const kept = ['Cache-Control: public, max-age=60', 'Expires: 0', 'Content-Language: en', 'Sunset: Sat, 31 Dec 2027 23:59:59 GMT', 'X-API-Version: 2.1', 'X-Robots-Tag: noindex'];
    const refused = [
      'Clear-Site-Data: "*"', 'NEL: {"report_to":"t","max_age":86400}', 'Report-To: {"group":"t"}', 'Reporting-Endpoints: t="https://tenant.example/r"',
      'Link: </sw.js>; rel="serviceworker"', 'Alt-Svc: h3="tenant.example:443"', 'Service-Worker-Allowed: /', 'Refresh: 0;url=https://tenant.example',
      'Location: https://tenant.example', 'Content-Security-Policy: default-src *', 'Content-Security-Policy-Report-Only: default-src *',
      'Strict-Transport-Security: max-age=0', 'Permissions-Policy: camera=*', 'Cross-Origin-Opener-Policy: unsafe-none', 'Origin-Agent-Cluster: ?0',
      'Accept-CH: Sec-CH-UA-Model', 'Critical-CH: Sec-CH-UA-Model', 'Vary: Accept', 'Retry-After: 0', 'Keep-Alive: timeout=600', 'Trailer: X-A', 'TE: trailers',
      'Speculation-Rules: "/r.json"', 'SourceMap: https://tenant.example/m', 'Server: x', 'Set-Login: logged-out',
      'X-Frame-Options: ALLOWALL', 'X-Accel-Redirect: /internal/secret', 'X-Sendfile: /etc/passwd', 'X-LiteSpeed-Location: /internal',
      'X-Forwarded-Host: tenant.example', 'X-RateLimit-Remaining: 9999', 'X-Content-Security-Policy: default-src *', 'X-: empty',
    ];
    const checked = checkCustomHeaders([...refused, ...kept].join('\n'));
    expect(Object.keys(checked.kept)).toEqual(kept.map((line) => line.slice(0, line.indexOf(':'))));
    expect(checked.dropped.map((header) => header.name)).toEqual(refused.map((line) => line.slice(0, line.indexOf(':'))));
    // Everything that reads as a header is still sent: the server is the one that decides.
    expect(Object.keys(checked.sent)).toHaveLength(refused.length + kept.length);
    expect(checked.sent['Cache-Control']).toBe('public, max-age=60');
  });

  it('says why each of the others is not kept', () => {
    const why = whyNot(['Clear-Site-Data: "*"', 'X-Frame-Options: DENY', 'X-FormLogic-Trace: 1', 'X Bad Name: 1', `X-${'a'.repeat(63)}: 1`, 'no colon here', ': no name', 'X-Empty:'].join('\n'));
    expect(why['Clear-Site-Data']).toContain('only Cache-Control, Expires, Pragma, Content-Language, Deprecation, Sunset and your own X- headers are sent');
    expect(why['X-Frame-Options']).toBe('browsers or the web server act on this X- header, or FormLogic sets it itself');
    expect(why['X-FormLogic-Trace']).toBe(why['X-Frame-Options']);
    expect(why['X Bad Name']).toBe('a header’s name is letters, digits and hyphens, 64 at most');
    expect(why[`X-${'a'.repeat(63)}`]).toBe(why['X Bad Name']);
    for (const line of ['no colon here', ': no name', 'X-Empty:']) expect(why[line], line).toBe('it is not written as “Header: Value”');
  });

  it('holds a value to 256 bytes and to no control character but a tab', () => {
    expect(names(`X-Note: ${'a'.repeat(256)}`)).toEqual(['X-Note']);
    expect(whyNot(`X-Note: ${'a'.repeat(257)}`)['X-Note']).toBe('its value is longer than 256 bytes');
    // Bytes, as the server counts them: 129 two-byte letters are 258.
    expect(whyNot(`X-Note: ${'é'.repeat(129)}`)['X-Note']).toBe('its value is longer than 256 bytes');
    expect(names(`X-Note: ${'é'.repeat(128)}`)).toEqual(['X-Note']);
    expect(whyNot('X-Note: a\u0007b')['X-Note']).toBe('its value has a control character');
    expect(names('X-Note: a\tb')).toEqual(['X-Note']);
    // A line typed on Windows ends in a carriage return, which is not part of the value.
    expect(checkCustomHeaders('X-Note: a\r\nX-Other: b\r\n').kept).toEqual({ 'X-Note': 'a', 'X-Other': 'b' });
  });

  it('keeps the first twelve, and says so of the rest', () => {
    const lines = Array.from({ length: 14 }, (_, index) => `X-H${index + 1}: v`);
    const checked = checkCustomHeaders(['Clear-Site-Data: "*"', ...lines].join('\n'));
    // One the server would drop anyway does not use up a place.
    expect(Object.keys(checked.kept)).toEqual(lines.slice(0, 12).map((line) => line.slice(0, line.indexOf(':'))));
    expect(checked.dropped.slice(1)).toEqual([
      { name: 'X-H13', why: 'only the first 12 headers are kept' },
      { name: 'X-H14', why: 'only the first 12 headers are kept' },
    ]);
  });

  it('reads a name given twice as one header with the later value', () => {
    const checked = checkCustomHeaders('X-Version: 1\nCache-Control: no-store\nX-Version: 2');
    expect(checked.sent).toEqual({ 'X-Version': '2', 'Cache-Control': 'no-store' });
    expect(checked.dropped).toEqual([]);
  });

  it('has nothing to say of an empty box', () => {
    expect(checkCustomHeaders(' \n\n')).toEqual({ sent: {}, kept: {}, dropped: [] });
  });
});

describe('what the server says it stored', () => {
  it('names the headers sent that are not in it', () => {
    const sent = { 'X-API-Version': '1', 'Clear-Site-Data': '"*"', Link: '</a>' };
    expect(headersNotStored(sent, { 'X-API-Version': '1' })).toEqual(['Clear-Site-Data', 'Link']);
    // With none kept the server answers an empty list, not an object.
    expect(headersNotStored(sent, [])).toEqual(['X-API-Version', 'Clear-Site-Data', 'Link']);
    expect(headersNotStored(sent, undefined)).toEqual(['X-API-Version', 'Clear-Site-Data', 'Link']);
    expect(headersNotStored({}, { 'X-API-Version': '1' })).toEqual([]);
    // A name is not found by what every object has.
    expect(headersNotStored({ toString: 'x' }, {})).toEqual(['toString']);
  });
});
