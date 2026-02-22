import { COUNTRY_BY_ISO, COUNTRIES_BY_DIAL_CODE } from '../data/countries';

// Timezone-to-country mapping for common timezones
const TIMEZONE_COUNTRY: Record<string, string> = {
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
  'America/Phoenix': 'US', 'America/Detroit': 'US', 'America/Indiana/Indianapolis': 'US',
  'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/St_Johns': 'CA',
  'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Rome': 'IT', 'Europe/Madrid': 'ES',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU', 'Europe/Bucharest': 'RO',
  'Europe/Sofia': 'BG', 'Europe/Athens': 'GR', 'Europe/Istanbul': 'TR',
  'Europe/Moscow': 'RU', 'Europe/Kiev': 'UA', 'Europe/Lisbon': 'PT',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN',
  'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Singapore': 'SG',
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Mumbai': 'IN',
  'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Bangkok': 'TH',
  'Asia/Jakarta': 'ID', 'Asia/Manila': 'PH', 'Asia/Kuala_Lumpur': 'MY',
  'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Tehran': 'IR',
  'Asia/Baghdad': 'IQ', 'Asia/Jerusalem': 'IL', 'Asia/Beirut': 'LB',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU', 'Australia/Hobart': 'AU',
  'Pacific/Auckland': 'NZ', 'Pacific/Fiji': 'FJ',
  'Africa/Cairo': 'EG', 'Africa/Lagos': 'NG', 'Africa/Nairobi': 'KE',
  'Africa/Johannesburg': 'ZA', 'Africa/Casablanca': 'MA',
  'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR',
  'America/Bogota': 'CO', 'America/Lima': 'PE', 'America/Santiago': 'CL',
};

export function detectUserCountry(): string {
  // Try navigator.language region subtag
  try {
    const lang = navigator.language;
    if (lang.includes('-')) {
      const region = lang.split('-').pop()!.toUpperCase();
      if (region.length === 2 && COUNTRY_BY_ISO[region]) {
        return region;
      }
    }
  } catch { /* ignore */ }

  // Try timezone
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && TIMEZONE_COUNTRY[tz]) {
      return TIMEZONE_COUNTRY[tz];
    }
  } catch { /* ignore */ }

  return 'US';
}

export function toE164(dialCode: string, nationalNumber: string): string {
  const digits = nationalNumber.replace(/\D/g, '');
  if (!digits) return '';
  return dialCode + digits;
}

export function parseE164(value: string): { countryIso: string; dialCode: string; nationalNumber: string } | null {
  if (!value || !value.startsWith('+')) return null;

  const digits = value.slice(1); // remove leading +
  if (!digits) return null;

  // Try longest dial code first (e.g., +1684 before +1)
  // Collect all known dial codes sorted by length descending
  const dialCodes = Object.keys(COUNTRIES_BY_DIAL_CODE).sort((a, b) => b.length - a.length);

  for (const code of dialCodes) {
    const codeDigits = code.slice(1); // remove +
    if (digits.startsWith(codeDigits)) {
      const countries = COUNTRIES_BY_DIAL_CODE[code];
      return {
        countryIso: countries[0].iso,
        dialCode: code,
        nationalNumber: digits.slice(codeDigits.length),
      };
    }
  }

  return null;
}

export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}
