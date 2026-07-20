import { describe, expect, it, vi } from 'vitest';
import type { DesktopAiSource } from '../../client-runtime/desktop/desktopClient';
import {
  DesktopFormGenerationError,
  buildDesktopFormGenerationRequest,
  eligibleDesktopFormProviders,
  generateFormWithDesktopProvider,
  parseDesktopFormGenerationResponse,
} from './desktopFormGeneration';

function formJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Customer feedback',
    description: 'Tell us how we did.',
    fields: [
      {
        type: 'email',
        label: 'Email address',
        required: true,
        properties: {},
      },
    ],
    needsScript: false,
    suggestedScript: '',
    ...overrides,
  };
}

function completion(payload: unknown, finishReason: unknown = 'stop'): Record<string, unknown> {
  return {
    choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: JSON.stringify(payload) } }],
  };
}

describe('Desktop standalone form response parser', () => {
  it('normalizes a valid form with bounded choice properties', () => {
    const parsed = parseDesktopFormGenerationResponse(completion(formJson({
      fields: [
        {
          type: 'dropdown',
          label: 'Preferred contact',
          required: false,
          properties: { options: ['Email', { label: 'Phone', value: 'phone' }] },
        },
      ],
    })));

    expect(parsed).toEqual({
      success: true,
      data: {
        title: 'Customer feedback',
        description: 'Tell us how we did.',
        fields: [{
          id: 'preferred_contact',
          type: 'dropdown',
          label: 'Preferred contact',
          description: '',
          placeholder: '',
          required: false,
          properties: {
            options: [
              { id: 'opt_1', label: 'Email', value: 'email' },
              { id: 'opt_2', label: 'Phone', value: 'phone' },
            ],
          },
        }],
        needsScript: false,
        suggestedScript: '',
      },
    });
  });

  it('generates unique non-reserved field ids', () => {
    const parsed = parseDesktopFormGenerationResponse(completion(formJson({
      fields: [
        { type: 'number', label: 'Count', required: true, properties: {} },
        { type: 'number', label: 'Count', required: false, properties: {} },
      ],
    })));

    expect(parsed.data.fields.map((field) => field.id)).toEqual(['count_1', 'count_2']);
  });

  it.each([
    ['surrounding prose', { choices: [{ finish_reason: 'stop', message: { content: `Here it is: ${JSON.stringify(formJson())}` } }] }],
    ['truncated completion', completion(formJson(), 'length')],
    ['script request', completion(formJson({ needsScript: true, suggestedScript: 'Run code' }))],
    ['unknown property', completion(formJson({ extra: true }))],
    ['unsafe field id', completion(formJson({ fields: [{ id: 'bad-id', type: 'email', label: 'Email', required: true, properties: {} }] }))],
    ['duplicate field id', completion(formJson({ fields: [
      { id: 'email', type: 'email', label: 'Email', required: true, properties: {} },
      { id: 'email', type: 'email', label: 'Backup email', required: false, properties: {} },
    ] }))],
    ['unsupported field property', completion(formJson({ fields: [
      { type: 'email', label: 'Email', required: true, properties: { pattern: '.*' } },
    ] }))],
  ])('fails closed on %s', (_name, response) => {
    expect(() => parseDesktopFormGenerationResponse(response)).toThrow(DesktopFormGenerationError);
  });
});

describe('Desktop form provider routing', () => {
  it('offers only enabled OpenAI-compatible chat providers', () => {
    const sources: DesktopAiSource[] = [
      { id: 'provider:openai', kind: 'provider', providerId: 'openai', name: 'OpenAI', protocol: 'openai', enabled: true, capabilities: ['chat'], model: 'gpt-5' },
      { id: 'provider:openai-codex-agent', kind: 'provider', providerId: 'openai-codex-agent', name: 'ChatGPT via Codex', protocol: 'openai', enabled: true, capabilities: ['chat'], useCases: ['background', 'forms', 'flows'], model: 'gpt-5.6-luna' },
      { id: 'provider:openai-codex-agent-luna-low', kind: 'provider', providerId: 'openai-codex-agent-luna-low', name: 'ChatGPT live-call adapter', protocol: 'openai', enabled: true, capabilities: ['chat'], useCases: ['live-call', 'try-assistant'], model: 'gpt-5.6-luna' },
      { id: 'provider:legacy', kind: 'provider', providerId: 'legacy', name: 'Legacy', protocol: 'openai', enabled: true, capabilities: [] },
      { id: 'provider:disabled', kind: 'provider', providerId: 'disabled', name: 'Disabled', protocol: 'openai', enabled: false, capabilities: ['chat'] },
      { id: 'provider:anthropic', kind: 'provider', providerId: 'anthropic', name: 'Anthropic', protocol: 'anthropic', enabled: true, capabilities: ['chat'] },
      { id: 'service:llama', kind: 'service', serviceId: 'llama', name: 'Llama', status: 'running', capabilities: ['chat'] },
    ];

    expect(eligibleDesktopFormProviders(sources)).toEqual([
      { id: 'openai', name: 'OpenAI', model: 'gpt-5' },
      { id: 'openai-codex-agent', name: 'ChatGPT via Codex', model: 'gpt-5.6-luna' },
      { id: 'legacy', name: 'Legacy' },
    ]);
  });

  it('pins the exact raw provider id and source model with no default route', async () => {
    const chat = vi.fn(async (body, providerId, opts) => {
      void body;
      void providerId;
      void opts;
      return {
        ok: true as const,
        data: completion(formJson()),
      };
    });

    const result = await generateFormWithDesktopProvider({
      providerId: 'my-openai',
      model: 'gpt-5-mini',
      prompt: 'Create a feedback form',
    }, chat);

    expect(result.success).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1]).toBe('my-openai');
    expect(chat.mock.calls[0][0].model).toBe('gpt-5-mini');
    expect(chat.mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces a selected-provider failure without retrying another route', async () => {
    const chat = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'provider_error', message: 'Selected provider failed.' },
    }));

    await expect(generateFormWithDesktopProvider({
      providerId: 'my-openai',
      prompt: 'Create a feedback form',
    }, chat)).rejects.toThrow('Selected provider failed.');
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('builds a bounded text-only request without response_format assumptions', () => {
    const request = buildDesktopFormGenerationRequest({
      providerId: 'my-openai',
      prompt: 'Create a booking form',
    });

    expect(request).not.toHaveProperty('response_format');
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1].content).toContain('Create a booking form');
  });
});
