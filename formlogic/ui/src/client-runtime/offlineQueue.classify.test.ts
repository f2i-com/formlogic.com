import { describe, expect, it } from 'vitest';
import { classifyDeliveryResult } from './offlineQueue';

// Pure decision logic behind offlineQueue.deliver(): given the server's submission result, decide
// whether the queued item is delivered (remove), retryable, in-flight (keep), or a terminal conflict.
describe('classifyDeliveryResult', () => {
  it('success → delivered (remove from queue)', () => {
    expect(classifyDeliveryResult({ ok: true }).outcome).toBe('delivered');
  });

  it('idempotent replay of a completed submission → delivered', () => {
    expect(classifyDeliveryResult({ ok: true, idempotent: true }).outcome).toBe('delivered');
  });

  it('server processing flag → processing (keep pending, do NOT remove or fail)', () => {
    const c = classifyDeliveryResult({ ok: false, processing: true, error: 'already being processed' });
    expect(c.outcome).toBe('processing');
  });

  it('detects processing from the message when the flag is absent', () => {
    const c = classifyDeliveryResult({
      ok: false,
      error: 'This submission is already being processed. Please retry in a moment.',
    });
    expect(c.outcome).toBe('processing');
  });

  it('server conflict flag → terminal (different submission, never retry)', () => {
    const c = classifyDeliveryResult({ ok: false, conflict: true, error: 'different submission' });
    expect(c.outcome).toBe('terminal');
    expect(c.error).toContain('different submission');
  });

  it('detects a conflict from the message when the flag is absent', () => {
    const c = classifyDeliveryResult({
      ok: false,
      error: 'This idempotency key was already used with a different submission.',
    });
    expect(c.outcome).toBe('terminal');
  });

  it('prefers server flags over message text (processing flag wins)', () => {
    // Message alone would look like a conflict, but the explicit flag says it is still in flight.
    const c = classifyDeliveryResult({ ok: false, processing: true, error: 'different submission' });
    expect(c.outcome).toBe('processing');
  });

  it('generic error → retry (attempts++), preserving the message', () => {
    const c = classifyDeliveryResult({ ok: false, status: 500, error: 'Server error (500)' });
    expect(c.outcome).toBe('retry');
    expect(c.error).toBe('Server error (500)');
  });

  // The server was not reached, or asked to be tried later: nothing about the submission was
  // judged, so it must not use up one of its attempts.
  it('network failure (status 0) → unreachable, preserving the message', () => {
    const c = classifyDeliveryResult({ ok: false, status: 0, error: 'Failed to fetch' });
    expect(c.outcome).toBe('unreachable');
    expect(c.error).toBe('Failed to fetch');
  });

  it('408 and 429 → unreachable', () => {
    expect(classifyDeliveryResult({ ok: false, status: 408, error: 'Request Timeout' }).outcome).toBe('unreachable');
    expect(classifyDeliveryResult({ ok: false, status: 429, error: 'Too many requests' }).outcome).toBe('unreachable');
  });

  it('a validation refusal still counts as an attempt', () => {
    expect(classifyDeliveryResult({ ok: false, status: 422, error: 'Validation failed' }).outcome).toBe('retry');
  });

  it('unknown failure with no message → retry with a non-empty default error', () => {
    const c = classifyDeliveryResult({ ok: false });
    expect(c.outcome).toBe('retry');
    expect(c.error).toBeTruthy();
  });
});
