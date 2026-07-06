import { describe, expect, it } from 'vitest';
import { ConnectorError, FALLBACKABLE_CODES, parseConnectorError } from './connectorTypes';

describe('parseConnectorError', () => {
  it('reads the code from a ConnectorError instance', () => {
    expect(parseConnectorError(new ConnectorError('capability_denied', 'nope'))).toEqual({
      code: 'capability_denied',
      message: 'nope',
    });
  });
  it('parses a JSON {code,message} error string (native bridge rejection)', () => {
    const parsed = parseConnectorError(new Error('{"code":"command_failed","message":"boom"}'));
    expect(parsed?.code).toBe('command_failed');
    expect(parsed?.message).toBe('boom');
  });
  it('returns null for a bare-string (legacy runtime) error', () => {
    expect(parseConnectorError(new Error('Connector "x" is not available.'))).toBeNull();
    expect(parseConnectorError('plain string')).toBeNull();
  });
  it('returns null for JSON without a code field', () => {
    expect(parseConnectorError(new Error('{"nope":1}'))).toBeNull();
  });
});

describe('FALLBACKABLE_CODES', () => {
  it('permits fallback only for an absent / unreachable native side', () => {
    expect(FALLBACKABLE_CODES.has('ipc_unavailable')).toBe(true);
    expect(FALLBACKABLE_CODES.has('connector_missing')).toBe(true);
  });
  it('never permits fallback for a capability denial or a real failure', () => {
    expect(FALLBACKABLE_CODES.has('capability_denied')).toBe(false);
    expect(FALLBACKABLE_CODES.has('command_failed')).toBe(false);
    expect(FALLBACKABLE_CODES.has('connector_unavailable')).toBe(false);
  });
});
