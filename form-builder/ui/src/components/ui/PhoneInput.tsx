import { useState, useEffect, useRef, useMemo } from 'react';
import { COUNTRIES, COUNTRY_BY_ISO } from '../../data/countries';
import { detectUserCountry, toE164, parseE164 } from '../../lib/phoneUtils';
import type { CountryData } from '../../data/countries';

// Example national numbers (without country code) for placeholder hints
const EXAMPLE_NUMBERS: Record<string, string> = {
  US: '(201) 555-0123', CA: '(204) 555-0123',
  GB: '7911 123456', AU: '412 345 678',
  NZ: '21 123 4567', IE: '85 012 3456',
  DE: '151 23456789', FR: '6 12 34 56 78',
  IT: '312 345 6789', ES: '612 34 56 78',
  NL: '6 12345678', BE: '470 12 34 56',
  CH: '78 123 45 67', AT: '664 1234567',
  SE: '70 123 45 67', NO: '406 12 345',
  DK: '20 12 34 56', FI: '40 1234567',
  PL: '512 345 678', CZ: '601 123 456',
  PT: '912 345 678', GR: '691 234 5678',
  IN: '98765 43210', PK: '300 1234567',
  BD: '1712 345678', JP: '90 1234 5678',
  KR: '10 1234 5678', CN: '131 2345 6789',
  HK: '5123 4567', TW: '912 345 678',
  SG: '8123 4567', MY: '12 345 6789',
  PH: '917 123 4567', TH: '81 234 5678',
  ID: '812 345 6789', VN: '91 234 56 78',
  AE: '50 123 4567', SA: '50 123 4567',
  IL: '50 123 4567', TR: '501 234 56 78',
  ZA: '71 123 4567', NG: '802 123 4567',
  KE: '712 345678', EG: '100 123 4567',
  BR: '11 91234-5678', MX: '55 1234 5678',
  AR: '11 1234-5678', CO: '310 1234567',
  CL: '9 1234 5678', PE: '912 345 678',
  RU: '912 345-67-89', UA: '50 123 4567',
};

function getPlaceholder(iso: string): string {
  return EXAMPLE_NUMBERS[iso] || 'Phone number';
}

interface PhoneInputProps {
  value: string;
  onChange: (val: string) => void;
  primaryColor?: string;
  textColor?: string;
  className?: string;
  autoFocus?: boolean;
}

export function PhoneInput({
  value,
  onChange,
  primaryColor,
  textColor,
  className,
  autoFocus,
}: PhoneInputProps) {
  const [selectedCountry, setSelectedCountry] = useState<CountryData>(() => {
    // Try to parse existing value
    const parsed = parseE164(value || '');
    if (parsed && COUNTRY_BY_ISO[parsed.countryIso]) {
      return COUNTRY_BY_ISO[parsed.countryIso];
    }
    return COUNTRY_BY_ISO[detectUserCountry()] || COUNTRY_BY_ISO['US'];
  });

  const [nationalNumber, setNationalNumber] = useState(() => {
    const parsed = parseE164(value || '');
    if (parsed) return parsed.nationalNumber;
    // If value exists but isn't E.164, show it as-is
    if (value && !value.startsWith('+')) return value;
    return '';
  });

  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const numberInputRef = useRef<HTMLInputElement>(null);

  // Track what we last emitted so we don't re-sync our own onChange calls
  const lastEmittedRef = useRef(value || '');

  // Sync from external value changes (e.g. form reset, programmatic set)
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const parsed = parseE164(value || '');
    if (parsed && COUNTRY_BY_ISO[parsed.countryIso]) {
      setSelectedCountry(COUNTRY_BY_ISO[parsed.countryIso]);
      setNationalNumber(parsed.nationalNumber);
      lastEmittedRef.current = value || '';
    }
  }, [value]);

  // Focus search input and scroll to selected country when dropdown opens
  useEffect(() => {
    if (!isOpen) return;
    searchInputRef.current?.focus();
    // Scroll to currently selected country
    requestAnimationFrame(() => {
      const selected = dropdownRef.current?.querySelector('[data-selected="true"]');
      if (selected) {
        selected.scrollIntoView({ block: 'nearest' });
      }
    });
  }, [isOpen]);

  // Close dropdown on click outside or Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSearch('');
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsOpen(false);
        setSearch('');
        numberInputRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const filteredCountries = useMemo(() => {
    if (!search) return COUNTRIES;
    const q = search.toLowerCase();
    return COUNTRIES.filter(
      c => c.name.toLowerCase().includes(q) || c.dialCode.includes(q)
    );
  }, [search]);

  const emitChange = (dialCode: string, num: string) => {
    const e164 = toE164(dialCode, num);
    lastEmittedRef.current = e164;
    onChange(e164);
  };

  const handleCountrySelect = (country: CountryData) => {
    setSelectedCountry(country);
    setIsOpen(false);
    setSearch('');
    emitChange(country.dialCode, nationalNumber);
    // Focus the number input after selection
    setTimeout(() => numberInputRef.current?.focus(), 0);
  };

  const handleNumberChange = (raw: string) => {
    // If the user typed/pasted the dial code at the start, strip it
    // Only for codes with 2+ digits to avoid false positives (e.g. +1)
    let num = raw;
    const codeDigits = selectedCountry.dialCode.slice(1); // e.g. "61" for +61
    if (codeDigits.length >= 2) {
      const rawDigits = raw.replace(/\D/g, '');
      if (rawDigits.startsWith(codeDigits) && rawDigits.length > codeDigits.length + 4) {
        num = rawDigits.slice(codeDigits.length);
      }
    }
    setNationalNumber(num);
    emitChange(selectedCountry.dialCode, num);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').trim();
    if (pasted.startsWith('+')) {
      e.preventDefault();
      const parsed = parseE164(pasted);
      if (parsed && COUNTRY_BY_ISO[parsed.countryIso]) {
        setSelectedCountry(COUNTRY_BY_ISO[parsed.countryIso]);
        setNationalNumber(parsed.nationalNumber);
        const clean = pasted.replace(/[^\d+]/g, '');
        lastEmittedRef.current = clean;
        onChange(clean);
      } else {
        lastEmittedRef.current = pasted;
        onChange(pasted);
      }
    }
  };

  const borderColor = primaryColor || 'currentColor';

  return (
    <div className={`flex items-end gap-0 ${className || ''}`}>
      {/* Country selector button */}
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1 py-2 pr-2 border-b-2 text-lg transition-colors cursor-pointer whitespace-nowrap"
          style={{
            borderColor: nationalNumber ? `${borderColor}60` : `${borderColor}30`,
            color: textColor,
          }}
        >
          <span className="text-xl leading-none">{selectedCountry.flag}</span>
          <span className="text-base opacity-70">{selectedCountry.dialCode}</span>
          <svg className="w-3 h-3 opacity-50 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Dropdown */}
        {isOpen && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 mt-1 w-72 max-h-64 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg shadow-lg z-50 flex flex-col overflow-hidden"
          >
            {/* Search */}
            <div className="sticky top-0 p-2 bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search countries..."
                className="w-full px-3 py-2 text-sm bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-md outline-none focus:border-blue-400 dark:focus:border-blue-500 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
              />
            </div>

            {/* Country list */}
            <div className="overflow-y-auto flex-1">
              {filteredCountries.length === 0 ? (
                <div className="px-3 py-4 text-sm text-gray-400 dark:text-slate-500 text-center">No countries found</div>
              ) : (
                filteredCountries.map((country) => (
                  <button
                    key={country.iso}
                    type="button"
                    data-selected={country.iso === selectedCountry.iso || undefined}
                    onClick={() => handleCountrySelect(country)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700 ${
                      country.iso === selectedCountry.iso ? 'bg-blue-50 dark:bg-slate-700' : ''
                    }`}
                    style={{ minHeight: '44px' }}
                  >
                    <span className="text-lg leading-none flex-shrink-0">{country.flag}</span>
                    <span className="flex-1 text-gray-900 dark:text-white truncate">{country.name}</span>
                    <span className="text-gray-400 dark:text-slate-500 flex-shrink-0">{country.dialCode}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* National number input */}
      <input
        ref={numberInputRef}
        type="tel"
        inputMode="tel"
        value={nationalNumber}
        onChange={(e) => handleNumberChange(e.target.value)}
        onPaste={handlePaste}
        placeholder={getPlaceholder(selectedCountry.iso)}
        autoFocus={autoFocus}
        className="flex-1 bg-transparent border-b-2 outline-none py-2 text-xl transition-colors min-w-0"
        style={{
          borderColor: nationalNumber ? `${borderColor}60` : `${borderColor}30`,
          color: textColor,
        }}
      />
    </div>
  );
}
