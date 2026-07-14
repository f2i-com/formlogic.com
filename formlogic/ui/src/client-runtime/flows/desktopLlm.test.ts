import { describe, expect, it } from 'vitest';
import { pickDesktopLlmService } from './desktopLlm';
import type { DesktopServiceSnapshot } from '../desktop/desktopClient';

// FormLogic Desktop local-AI routing (docs/FORMLOGIC_FLOWS.md §4): pick the first RUNNING
// OpenAI-compatible service and build its loopback chat endpoint. Mirrors how f2i-web maps
// companion services into the flow palette.

function svc(overrides: Partial<DesktopServiceSnapshot>): DesktopServiceSnapshot {
  return { id: 's', name: 'S', status: 'running', port: 11434, ...overrides };
}

describe('pickDesktopLlmService', () => {
  it('picks the first running LLM-category service on its loopback port', () => {
    const out = pickDesktopLlmService([
      svc({ id: 'stopped', status: 'stopped', category: 'llm' }),
      svc({ id: 'ollama', category: 'LLM', port: 11434 }),
    ]);
    expect(out).toEqual({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', service: 'S' });
  });

  it('honours an explicit openai node contract (endpoint + apiFormat)', () => {
    const out = pickDesktopLlmService([
      svc({ id: 'llamacpp', port: 8080, node: { apiFormat: 'openai', endpoint: '/v1/chat/completions' } }),
    ]);
    expect(out?.endpoint).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  it('skips a declared node that is not openai-compatible', () => {
    const out = pickDesktopLlmService([
      svc({ id: 'tts', port: 5002, category: 'llm', node: { apiFormat: 'custom' } }),
    ]);
    expect(out).toBeNull();
  });

  it('returns null when Desktop runs no running LLM service (absent case)', () => {
    expect(pickDesktopLlmService([])).toBeNull();
    expect(pickDesktopLlmService([svc({ status: 'stopped', category: 'llm' })])).toBeNull();
    expect(pickDesktopLlmService([svc({ category: 'stt' })])).toBeNull();
  });

  it('skips a service with no resolvable port', () => {
    expect(pickDesktopLlmService([svc({ port: 0, category: 'llm' })])).toBeNull();
  });
});
