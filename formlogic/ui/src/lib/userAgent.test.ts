import { describe, it, expect } from 'vitest';
import { describeUserAgent, primaryLanguage } from './userAgent';

describe('describeUserAgent', () => {
  it('identifies Chrome on Windows', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
    )).toBe('Chrome 138 · Windows');
  });

  it('prefers Edge over its embedded Chrome token', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0'
    )).toBe('Edge 138 · Windows');
  });

  it('identifies Safari on macOS (Version/x token)', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
    )).toBe('Safari 17 · macOS');
  });

  it('identifies Firefox on Linux', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
    )).toBe('Firefox 128 · Linux');
  });

  it('identifies Chrome on iOS (CriOS)', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1'
    )).toBe('Chrome 126 · iOS');
  });

  it('identifies Android WebView-ish Chrome', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36'
    )).toBe('Chrome 125 · Android');
  });

  it('returns null for non-browser agents and blanks', () => {
    expect(describeUserAgent('curl/8.14.1')).toBeNull();
    expect(describeUserAgent('mcp')).toBeNull();
    expect(describeUserAgent('')).toBeNull();
    expect(describeUserAgent(undefined)).toBeNull();
  });

  it('does not misread a Firefox rv: token as Internet Explorer', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0'
    )).toBe('Firefox 128 · Windows');
  });
});

describe('primaryLanguage', () => {
  it('takes the first tag and drops quality weights', () => {
    expect(primaryLanguage('en-AU,en;q=0.9,en-US;q=0.8')).toBe('en-AU');
    expect(primaryLanguage('fr')).toBe('fr');
  });
  it('handles absent values', () => {
    expect(primaryLanguage(null)).toBeNull();
    expect(primaryLanguage('')).toBeNull();
  });
});
