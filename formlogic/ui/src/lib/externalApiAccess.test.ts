// An app's External API keeps the route prefixes, default path prefix and browser origins its
// owner gives it only as far as the server's rule allows (AppService::sanitizeExternalApi, with
// SessionOriginPolicy::normalizeOrigin), and drops the rest without a word: a blocked prefix with a
// space in it was never blocked, and with every allowed prefix dropped every route was allowed. The
// settings page works out the same answer beforehand to say which and why. Its rule is a copy of
// the server's: the first tests read the PHP and fail when they part.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_LIMIT, HOST_PATTERN, MAX_HOST_LENGTH, MAX_ORIGINS, MAX_PATH_BYTES, MAX_PATHS, MAX_PREFIX_BYTES, MAX_RATE_LIMIT, MIN_RATE_LIMIT, ORIGIN_PATTERN, PREFIX_CHARACTERS, SITE_PREFIX, SITE_ROUTES,
  checkCorsOrigins, checkDefaultPrefix, checkPaths, checkRateLimit, entriesNotStored, isIpv6, namesInWords, normalizeOrigin, prefixNotStored,
} from './externalApiAccess';

const backend = resolve(__dirname, '../../../backend/src');
const apps = readFileSync(resolve(backend, 'Services/AppService.php'), 'utf8');
const origins = readFileSync(resolve(backend, 'Support/SessionOriginPolicy.php'), 'utf8');

/** The server's own text where `pattern` finds it, or a failure that names what is missing. */
function server(source: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(source)?.[1];
  expect(found, `${what} in the PHP`).toBeTruthy();
  return found!;
}
/** The method alone, so that a limit of some other part of AppService is never taken for one of its. */
const sanitize = server(apps, /(public static function sanitizeExternalApi\([\s\S]*?\n {4}\})/, 'sanitizeExternalApi');
const normalize = server(origins, /(public static function normalizeOrigin\([\s\S]*?\n {4}\})/, 'normalizeOrigin');
const kept = (checked: { kept: string[] }) => checked.kept;
const whyNot = (checked: { dropped: { name: string; why: string }[] }) => Object.fromEntries(checked.dropped.map((entry) => [entry.name, entry.why]));

describe('the route prefixes, path prefix and origins an External API keeps', () => {
  it('are decided by the limits and patterns the server holds (AppService::sanitizeExternalApi)', () => {
    // A route prefix: a leading slash put on, then refused by length, "..", a space or control character, or /api/site/.
    expect(sanitize).toContain("if (!str_starts_with($p, '/')) $p = '/' . $p;");
    expect(Number(server(sanitize, /strlen\(\$p\) > (\d+)/, 'the longest prefix'))).toBe(MAX_PATH_BYTES);
    expect(sanitize).toContain("str_contains($p, '..') || preg_match('/[\\x00-\\x1f\\x7f\\s]/', $p) === 1");
    expect(server(sanitize, /str_starts_with\(strtolower\(\$p\), '([^']+)'\)/, 'the routes no prefix names')).toBe(SITE_ROUTES);
    expect(Number(server(sanitize, /count\(\$out\) >= (\d+)/, 'how many prefixes'))).toBe(MAX_PATHS);
    expect(sanitize).toContain('if (!in_array($p, $out, true))');
    // The default path prefix.
    expect(sanitize).toContain("$dp = rtrim($dp, '/');");
    expect(Number(server(sanitize, /strlen\(\$dp\) <= (\d+)/, 'the longest path prefix'))).toBe(MAX_PREFIX_BYTES);
    expect(server(sanitize, /preg_match\('~\^\/\[([^\]]+)\]\+\$~D', \$dp\)/, "the path prefix's characters")).toBe(PREFIX_CHARACTERS);
    expect(server(sanitize, /str_starts_with\(strtolower\(\$dp\), '([^']+)'\)/, 'the routes no path prefix names')).toBe(SITE_PREFIX);
    // A browser origin: "*" as it is, any other with its trailing slashes taken off and normalized.
    expect(sanitize).toContain("if ($o === '*')");
    expect(sanitize).toContain("SessionOriginPolicy::normalizeOrigin(rtrim($o, '/'))");
    expect(Number(server(sanitize, /count\(\$corsOrigins\) >= (\d+)/, 'how many origins'))).toBe(MAX_ORIGINS);
  });

  it('read an origin as the server does (SessionOriginPolicy::normalizeOrigin)', () => {
    expect(server(normalize, /preg_match\('~(.+?)~iD', \$origin\)/, 'the origin pattern')).toBe(ORIGIN_PATTERN.source.replaceAll('\\/', '/'));
    expect(ORIGIN_PATTERN.flags).toBe('i');
    expect(server(normalize, /preg_match\('\/(.+?)\/D', \$host\)/, 'the host pattern')).toBe(HOST_PATTERN.source);
    expect(Number(server(normalize, /strlen\(\$host\) > (\d+)/, 'the longest host'))).toBe(MAX_HOST_LENGTH);
    expect(normalize).toContain('FILTER_VALIDATE_IP, FILTER_FLAG_IPV6');
    expect(normalize).toContain("$defaultPort = $scheme === 'https' ? 443 : 80;");
    expect(normalize).toContain('if ($port < 1 || $port > 65535)');
  });

  // The server's own example (ExternalAppApiPolicyTest::testSanitizeExternalApiNormalizesAndClampsSettings).
  it('keep and drop what the server keeps and drops', () => {
    const allowed = checkPaths(['api/products', '/api/orders', '/api/site/internal', '/api/../secret'].join('\n'));
    expect(kept(allowed)).toEqual(['/api/products', '/api/orders']);
    expect(whyNot(allowed)).toEqual({ '/api/site/internal': 'routes under /api/site/ are FormLogic’s own to call', '/api/../secret': 'it holds “..”' });
    const blocked = checkPaths('/api/admin\nbad path');
    expect(kept(blocked)).toEqual(['/api/admin']);
    expect(whyNot(blocked)).toEqual({ 'bad path': 'it has a space or a control character' });
    expect(checkDefaultPrefix('api/')).toEqual({ sent: 'api/', kept: '/api', dropped: [] });
    const cors = checkCorsOrigins(['https://Shop.Example.com:443/', '*', 'javascript:alert(1)', 'not-an-origin'].join('\n'));
    expect(kept(cors)).toEqual(['https://shop.example.com', '*']);
    expect(Object.keys(whyNot(cors))).toEqual(['javascript:alert(1)', 'not-an-origin']);
    // What is sent is every entry as typed: the server is the one that decides.
    expect(cors.sent).toEqual(['https://Shop.Example.com:443/', '*', 'javascript:alert(1)', 'not-an-origin']);
  });

  it('hold a route prefix to its bytes, its characters and the first thirty', () => {
    expect(kept(checkPaths(`/${'a'.repeat(199)}`))).toHaveLength(1);
    expect(whyNot(checkPaths(`/${'a'.repeat(200)}`))[`/${'a'.repeat(200)}`]).toBe('it is longer than 200 bytes');
    // Bytes, as the server counts them, the leading slash among them: 100 two-byte letters are 201.
    expect(whyNot(checkPaths('é'.repeat(100)))['é'.repeat(100)]).toBe('it is longer than 200 bytes');
    expect(kept(checkPaths('/api/café'))).toEqual(['/api/café']);
    expect(whyNot(checkPaths('/api/a\tb'))['/api/a\tb']).toBe('it has a space or a control character');
    expect(whyNot(checkPaths('/api/a\u007fb'))['/api/a\u007fb']).toBe('it has a space or a control character');
    // A space that is not ASCII is no space to PCRE without UTF-8, as the server matches it.
    expect(kept(checkPaths('/api/a b'))).toEqual(['/api/a b']);
    // /API/SITE/ is /api/site/, as strtolower reads it.
    expect(whyNot(checkPaths('/API/Site/x'))['/API/Site/x']).toBe('routes under /api/site/ are FormLogic’s own to call');
    expect(kept(checkPaths('/api/sites'))).toEqual(['/api/sites']);
    // The same prefix twice is one, and not named: nothing the owner meant is missing.
    const twice = checkPaths('api/x\n/api/x');
    expect(twice).toEqual({ sent: ['api/x', '/api/x'], kept: ['/api/x'], dropped: [] });
    const many = checkPaths(['/bad path', ...Array.from({ length: 32 }, (_, index) => `/p${index + 1}`), '/p1'].join('\n'));
    // One the server drops anyway does not use up a place; one that comes again after the thirtieth is kept.
    expect(kept(many)).toEqual(Array.from({ length: 30 }, (_, index) => `/p${index + 1}`));
    expect(many.dropped).toEqual([
      { name: '/bad path', why: 'it has a space or a control character' },
      { name: '/p31', why: 'only the first 30 are kept' },
      { name: '/p32', why: 'only the first 30 are kept' },
    ]);
    // One a line, or between commas, as the page sends them.
    expect(checkPaths(' /a, /b \n\n,/c').sent).toEqual(['/a', '/b', '/c']);
  });

  it('hold the default path prefix to its characters, its length and /api/site', () => {
    expect(checkDefaultPrefix('')).toEqual({ sent: '', kept: '', dropped: [] });
    // A slash is no prefix, as an empty box is.
    expect(checkDefaultPrefix(' // ')).toEqual({ sent: '//', kept: '', dropped: [] });
    expect(checkDefaultPrefix('/v1/public/')).toEqual({ sent: '/v1/public/', kept: '/v1/public', dropped: [] });
    expect(checkDefaultPrefix(`/${'a'.repeat(63)}`).kept).toBe(`/${'a'.repeat(63)}`);
    expect(checkDefaultPrefix(`/${'a'.repeat(64)}`).dropped).toEqual([{ name: `/${'a'.repeat(64)}`, why: 'it is longer than 64 characters' }]);
    for (const typed of ['/api/v1.2', '/my prefix', '/../x', '/café', '/a?b']) {
      expect(checkDefaultPrefix(typed), typed).toEqual({ sent: typed, kept: '', dropped: [{ name: typed, why: 'a prefix is letters, digits, “/”, “_” and “-”' }] });
    }
    // Any prefix that begins /api/site, as strtolower reads it.
    for (const typed of ['/api/site', '/API/Site/x', 'api/sites']) {
      expect(checkDefaultPrefix(typed).dropped, typed).toEqual([{ name: typed, why: 'routes under /api/site are FormLogic’s own to call' }]);
    }
  });

  it('read an origin as a scheme, a host and a port, and keep the first twenty', () => {
    expect(normalizeOrigin('HTTP://Example.COM:80')).toEqual({ origin: 'http://example.com' });
    expect(normalizeOrigin('https://example.com:8443')).toEqual({ origin: 'https://example.com:8443' });
    expect(normalizeOrigin('https://example.com:00443')).toEqual({ origin: 'https://example.com' });
    expect(normalizeOrigin('http://localhost:5173')).toEqual({ origin: 'http://localhost:5173' });
    expect(normalizeOrigin('https://example.com.')).toEqual({ origin: 'https://example.com.' });
    expect(normalizeOrigin('http://[::1]:8080')).toEqual({ origin: 'http://[::1]:8080' });
    expect(normalizeOrigin('http://[2001:DB8::1]')).toEqual({ origin: 'http://[2001:db8::1]' });
    const why = (origin: string) => ('why' in normalizeOrigin(origin) ? (normalizeOrigin(origin) as { why: string }).why : null);
    for (const origin of ['ftp://example.com', 'https://example.com/path', 'https://example.com?q', 'https://user@example.com', 'example.com', 'https://exa_mple.com', 'https://example.com:']) {
      expect(why(origin), origin).toBe('an origin is http:// or https://, a host and at most a port, and nothing after it');
    }
    for (const origin of ['https://-example.com', 'https://a..b', `https://${'a'.repeat(64)}.com`, `https://${Array.from({ length: 64 }, () => 'abc').join('.')}`, 'http://[::1::2]', 'http://[1.2.3.4]']) {
      expect(why(origin), origin).toBe('its host is not a domain name or an IP address');
    }
    for (const origin of ['https://example.com:0', 'https://example.com:65536', 'https://example.com:99999']) {
      expect(why(origin), origin).toBe('its port is not between 1 and 65535');
    }
    // Trailing slashes come off first, as rtrim takes them; "*" stays as it is, once.
    expect(checkCorsOrigins('https://a.example///\n*\n*\nhttps://A.example')).toEqual({ sent: ['https://a.example///', '*', '*', 'https://A.example'], kept: ['https://a.example', '*'], dropped: [] });
    const many = checkCorsOrigins(Array.from({ length: 22 }, (_, index) => `https://o${index + 1}.example`).join('\n'));
    expect(kept(many)).toHaveLength(20);
    expect(many.dropped).toEqual([
      { name: 'https://o21.example', why: 'only the first 20 are kept' },
      { name: 'https://o22.example', why: 'only the first 20 are kept' },
    ]);
  });

  // The page sent 120 for a 0 (`Number(x) || 120`), which the server would have kept as 1.
  it('hold the rate limit to whole requests from 1 to 600 a minute, and say so', () => {
    expect(Number(server(sanitize, /\$rateLimit = (\d+);/, 'the rate limit kept when none is given'))).toBe(DEFAULT_RATE_LIMIT);
    expect(sanitize).toContain("if (isset($value['rateLimitPerMinute']) && is_numeric($value['rateLimitPerMinute']))");
    expect(server(sanitize, /\$rateLimit = (max\([^;]+\));/, 'the rate limit rule')).toBe(`max(${MIN_RATE_LIMIT}, min(${MAX_RATE_LIMIT}, (int) $value['rateLimitPerMinute']))`);

    for (const typed of ['1', '120', '600', ' 42 ']) {
      expect(checkRateLimit(typed), typed).toEqual({ sent: Number(typed), kept: Number(typed), dropped: [] });
    }
    // Sent as typed, for the server to decide, and what it keeps named beside it.
    expect(checkRateLimit('0')).toEqual({ sent: 0, kept: 1, dropped: [{ name: '0', why: 'a rate limit is from 1 to 600 requests a minute, so 1 is kept' }] });
    expect(checkRateLimit('-5').kept).toBe(1);
    expect(checkRateLimit('601')).toEqual({ sent: 601, kept: 600, dropped: [{ name: '601', why: 'a rate limit is from 1 to 600 requests a minute, so 600 is kept' }] });
    expect(checkRateLimit('1e3').kept).toBe(600);
    // (int) drops what follows the point.
    expect(checkRateLimit('2.9')).toEqual({ sent: 2.9, kept: 2, dropped: [{ name: '2.9', why: 'a rate limit is a whole number of requests, so 2 is kept' }] });
    expect(checkRateLimit('0.5').kept).toBe(1);
    // An empty box is no number: the server keeps its default.
    expect(checkRateLimit('')).toEqual({ sent: 120, kept: 120, dropped: [{ name: '(empty)', why: 'no number is given, so the default, 120, is kept' }] });
  });

  it('read an IPv6 address as PHP\'s filter does', () => {
    for (const address of ['::1', '::', '1::', '2001:db8::1', '1:2:3:4:5:6:7:8', '1::8', '::ffff:1.2.3.4', '1:2:3:4:5:6:1.2.3.4', 'fe80::1:2']) {
      expect(isIpv6(address), address).toBe(true);
    }
    for (const address of ['', '1', '1.2.3.4', ':1', '1:', '1::2::3', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', '12345::', '::ffff:1.2.3', '::ffff:1.2.3.256', '::ffff:01.2.3.4', '1:2:3:4:5:6:7:1.2.3.4', ':::']) {
      expect(isIpv6(address), address).toBe(false);
    }
  });
});

describe('what the server says it stored', () => {
  it('names the entries sent that are not in it, by the form it stores them in', () => {
    const sent = ['api/a', '/api/b', '/api/c d'];
    expect(entriesNotStored('paths', sent, ['/api/a', '/api/b'])).toEqual(['/api/c d']);
    expect(entriesNotStored('paths', sent, ['/api/a'])).toEqual(['/api/b', '/api/c d']);
    // With none kept the server answers an empty list; with no answer, nothing is stored.
    expect(entriesNotStored('paths', sent, [])).toEqual(sent);
    expect(entriesNotStored('paths', sent, undefined)).toEqual(sent);
    expect(entriesNotStored('origins', ['https://A.example/', '*', 'nope'], ['https://a.example', '*'])).toEqual(['nope']);
    expect(entriesNotStored('origins', ['https://a.example'], ['*'])).toEqual(['https://a.example']);
  });

  it('says whether the path prefix sent is not the one stored', () => {
    expect(prefixNotStored('api/', '/api')).toBe(false);
    expect(prefixNotStored('api/', '')).toBe(true);
    expect(prefixNotStored('/my prefix', '')).toBe(true);
    // Nothing to keep is nothing lost.
    expect(prefixNotStored('', '')).toBe(false);
    expect(prefixNotStored('/', '')).toBe(false);
  });

  it('names up to four, and counts the rest', () => {
    expect(namesInWords(['a', 'b'])).toBe('a, b');
    expect(namesInWords(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c, d and 2 more');
  });
});
