/**
 * Friendly "browser · OS" label from a raw User-Agent string, for the response
 * Details panels ("Chrome 138 · Windows"). Heuristic and order-sensitive:
 * Edge/Opera/Samsung embed "Chrome", and nearly everything embeds "Safari",
 * so the more specific tokens must win. Returns null when nothing recognizable
 * matches (API clients, curl, bots) — callers fall back to the raw string.
 */
export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua || !ua.trim()) return null;

  const browsers: Array<{ label: string; re: RegExp }> = [
    { label: 'Edge', re: /\bEdg(?:e|A|iOS)?\/(\d+)/ },
    { label: 'Opera', re: /\bOPR\/(\d+)/ },
    { label: 'Opera', re: /\bOpera[/ ](\d+)/ },
    { label: 'Samsung Internet', re: /\bSamsungBrowser\/(\d+)/ },
    { label: 'Firefox', re: /\bFxiOS\/(\d+)/ },
    { label: 'Firefox', re: /\bFirefox\/(\d+)/ },
    { label: 'Chrome', re: /\bCriOS\/(\d+)/ },
    { label: 'Chrome', re: /\bChrome\/(\d+)/ },
    { label: 'Safari', re: /\bVersion\/(\d+)[.\d]*.*\bSafari\// },
    { label: 'Internet Explorer', re: /\b(?:MSIE |rv:)(\d+)[.\d]*.*?(?:;|\))/ },
  ];

  let browser: string | null = null;
  for (const { label, re } of browsers) {
    // IE's pattern needs Trident/MSIE context so a Firefox "rv:" never matches.
    if (label === 'Internet Explorer' && !/\b(?:MSIE|Trident)\b/.test(ua)) continue;
    const m = ua.match(re);
    if (m) {
      browser = m[1] ? `${label} ${m[1]}` : label;
      break;
    }
  }

  const oses: Array<{ label: string; re: RegExp }> = [
    { label: 'Windows', re: /\bWindows NT\b/ },
    { label: 'iOS', re: /\b(?:iPhone|iPad|iPod)\b/ },
    { label: 'Android', re: /\bAndroid\b/ },
    { label: 'ChromeOS', re: /\bCrOS\b/ },
    { label: 'macOS', re: /\bMac OS X\b/ },
    { label: 'Linux', re: /\bLinux\b/ },
  ];
  const os = oses.find(({ re }) => re.test(ua))?.label ?? null;

  if (!browser && !os) return null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os;
}

/**
 * The primary language tag from an Accept-Language header value
 * ("en-AU,en;q=0.9" → "en-AU"). Null when absent/blank.
 */
export function primaryLanguage(acceptLanguage: string | null | undefined): string | null {
  if (!acceptLanguage) return null;
  const first = acceptLanguage.split(',')[0]?.split(';')[0]?.trim();
  return first || null;
}
