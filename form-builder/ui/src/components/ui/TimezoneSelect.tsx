import { useMemo } from 'react';
import { listTimezones, browserTimezone } from '../../lib/timezone';

interface TimezoneSelectProps {
  /** Current IANA value ('' = the "use default" option). */
  value: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Label for the empty option (e.g. "Use my account timezone" / "Auto (browser)"). */
  emptyLabel?: string;
}

/**
 * IANA timezone picker (from Intl.supportedValuesOf, current UTC offset shown).
 * Shared by the app-settings, account-profile and member-profile timezone
 * controls so record times can be displayed in the viewer's chosen zone.
 */
export function TimezoneSelect({
  value,
  onChange,
  disabled,
  id,
  className,
  emptyLabel = 'Use default (UTC)',
}: TimezoneSelectProps) {
  const zones = useMemo(() => listTimezones(), []);
  const browser = useMemo(() => browserTimezone(), []);

  // Ensure the current value and the browser zone are always selectable, even
  // if a future/renamed IANA name isn't in the enumerated list.
  const options = useMemo(() => {
    const set = new Set(zones);
    if (value) set.add(value);
    if (browser) set.add(browser);
    return Array.from(set).sort();
  }, [zones, value, browser]);

  const offset = (tz: string): string => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      }).formatToParts(new Date());
      return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      return '';
    }
  };

  return (
    <select
      id={id}
      className={className}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">
        {emptyLabel}
        {browser ? ` — you appear to be in ${browser}` : ''}
      </option>
      {options.map((tz) => {
        const off = offset(tz);
        return (
          <option key={tz} value={tz}>
            {tz.replace(/_/g, ' ')}
            {off ? ` (${off})` : ''}
          </option>
        );
      })}
    </select>
  );
}
