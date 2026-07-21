// Pure helpers for the "Run on" execution location (plan §5.7): the configured-location
// reader (absent/unknown = 'auto', the zero-change default), the run-history Location
// cell label ('—' for rows that predate the column), and the option copy.
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_LOCATION_DESCRIPTIONS,
  flowExecutionLocation,
  runLocationLabel,
} from './executionLocation';

describe('flowExecutionLocation', () => {
  it('defaults to auto when the field is absent, null, or unknown (pre-Phase-5 rows)', () => {
    expect(flowExecutionLocation(undefined)).toBe('auto');
    expect(flowExecutionLocation(null)).toBe('auto');
    expect(flowExecutionLocation({})).toBe('auto');
    expect(flowExecutionLocation({ executionLocation: null })).toBe('auto');
    expect(flowExecutionLocation({ executionLocation: 'browser' })).toBe('auto');
    expect(flowExecutionLocation({ executionLocation: 42 })).toBe('auto');
  });

  it('passes desktop and cloud through verbatim', () => {
    expect(flowExecutionLocation({ executionLocation: 'desktop' })).toBe('desktop');
    expect(flowExecutionLocation({ executionLocation: 'cloud' })).toBe('cloud');
    expect(flowExecutionLocation({ executionLocation: 'auto' })).toBe('auto');
  });
});

describe('runLocationLabel', () => {
  it('labels the as-executed locations', () => {
    expect(runLocationLabel('browser')).toBe('browser');
    expect(runLocationLabel('desktop')).toBe('desktop');
    expect(runLocationLabel('cloud')).toBe('cloud');
  });

  it('renders — for rows without a recorded location', () => {
    expect(runLocationLabel(null)).toBe('—');
    expect(runLocationLabel(undefined)).toBe('—');
    expect(runLocationLabel('auto')).toBe('—');
    expect(runLocationLabel('')).toBe('—');
  });
});

describe('EXECUTION_LOCATION_DESCRIPTIONS', () => {
  it('carries the plan §5.7 copy for every selectable location', () => {
    expect(EXECUTION_LOCATION_DESCRIPTIONS.auto).toBe('Let FormLogic decide (browser or your desktop)');
    expect(EXECUTION_LOCATION_DESCRIPTIONS.desktop).toBe('Your FormLogic Desktop (private, unmetered)');
    expect(EXECUTION_LOCATION_DESCRIPTIONS.cloud).toBe('FormLogic Cloud (uses plan credits)');
  });
});
