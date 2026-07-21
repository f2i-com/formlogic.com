// Tests for the llm_chat AI-service picker's option list (plan §5.6).
//
// The project has no DOM test harness, so the picker logic lives in the pure
// aiProviderOptions.ts (same pattern as runHistoryChip.ts). These tests pin:
//   - "Default (from Settings)" as the TOP option, with the resolved source label
//     beside it once preferences load;
//   - the legacy "Auto (Desktop/app default)" entry preserved;
//   - capability filtering, disabled/no-capability flags and the "(missing)"
//     passthrough for unknown stored values — all unchanged from the previous
//     inline rendering in NodeProperties.tsx;
//   - the alias value ('default') never rendered as "(missing)".
import { describe, expect, it } from 'vitest';
import {
  buildAiProviderOptions,
  defaultProviderOption,
  DEFAULT_PROVIDER_OPTION_VALUE,
} from './aiProviderOptions';
import type { AiProviderConfig } from '../../../client-runtime/flows/aiProviders';

function cfg(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: 'p1',
    name: 'My OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('defaultProviderOption', () => {
  it('renders the plain label while preferences have not resolved', () => {
    expect(defaultProviderOption(null)).toEqual({ value: 'default', label: 'Default (from Settings)' });
  });

  it('shows the currently-resolved source beside the label', () => {
    expect(defaultProviderOption('Site AI')).toEqual({ value: 'default', label: 'Default (from Settings) — Site AI' });
    expect(defaultProviderOption('Desktop — codex')).toEqual({
      value: 'default',
      label: 'Default (from Settings) — Desktop — codex',
    });
  });
});

describe('buildAiProviderOptions', () => {
  it('puts "Default (from Settings)" first and keeps the legacy Auto entry second', () => {
    const options = buildAiProviderOptions({
      providers: [cfg()],
      capability: 'chat',
      currentValue: '',
      defaultSourceLabel: 'Site AI',
    });

    expect(options[0]).toEqual({ value: DEFAULT_PROVIDER_OPTION_VALUE, label: 'Default (from Settings) — Site AI' });
    expect(options[1]).toEqual({ value: '', label: 'Auto (Desktop/app default)' });
    expect(options[2]).toEqual({ value: 'p1', label: 'My OpenAI - OpenAI' });
  });

  it('offers only providers that declare the node capability', () => {
    const options = buildAiProviderOptions({
      providers: [
        cfg({ id: 'chat-ok', capabilities: ['chat'] }),
        cfg({ id: 'speech-only', name: 'Voice', capabilities: ['speech'] }),
      ],
      capability: 'chat',
      currentValue: '',
      defaultSourceLabel: null,
    });

    expect(options.map((o) => o.value)).toEqual(['default', '', 'chat-ok']);
  });

  it('keeps a selected-but-unusable provider listed with its flags', () => {
    const options = buildAiProviderOptions({
      providers: [cfg({ id: 'old', name: 'Old', enabled: false, capabilities: ['speech'] })],
      capability: 'chat',
      currentValue: 'old',
      defaultSourceLabel: null,
    });

    expect(options.map((o) => o.value)).toContain('old');
    const selected = options.find((o) => o.value === 'old');
    expect(selected?.label).toBe('Old - OpenAI (disabled) (no chat)');
  });

  it("never renders the stored 'default' alias as missing", () => {
    const options = buildAiProviderOptions({
      providers: [cfg()],
      capability: 'chat',
      currentValue: 'default',
      defaultSourceLabel: 'Site AI',
    });

    expect(options.filter((o) => o.label.includes('(missing)'))).toEqual([]);
    expect(options.map((o) => o.value)).toEqual(['default', '', 'p1']);
  });

  it('passes unknown stored values through verbatim as "(missing)"', () => {
    const options = buildAiProviderOptions({
      providers: [cfg()],
      capability: 'chat',
      currentValue: 'ghost-id',
      defaultSourceLabel: null,
    });

    expect(options.at(-1)).toEqual({ value: 'ghost-id', label: 'ghost-id (missing)' });
  });

  it("keeps an explicit 'provider:<id>' Desktop reference visible verbatim", () => {
    const options = buildAiProviderOptions({
      providers: [cfg()],
      capability: 'chat',
      currentValue: 'provider:desk-1',
      defaultSourceLabel: null,
    });

    expect(options.at(-1)).toEqual({ value: 'provider:desk-1', label: 'provider:desk-1 (missing)' });
  });

  it('labels a selected provider lacking the capability without duplicating the enabled flag', () => {
    const options = buildAiProviderOptions({
      providers: [cfg({ id: 'tts', name: 'TTS', capabilities: ['speech'], enabled: true })],
      capability: 'speech',
      currentValue: 'tts',
      defaultSourceLabel: null,
    });

    expect(options.find((o) => o.value === 'tts')?.label).toBe('TTS - OpenAI');
  });
});
