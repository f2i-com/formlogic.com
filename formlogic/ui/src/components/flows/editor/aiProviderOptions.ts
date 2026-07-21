// Flows editor — llm_chat AI-service picker option list (pure, no JSX/DOM so it is
// testable without a rendering harness; same pattern as runHistoryChip.ts).
//
// Plan §5.6 ("Default (from Settings)" alias): the top option routes the node through
// the acting user's AI settings and shows the currently-resolved source beside it
// (e.g. "Default (from Settings) — Site AI"). Everything else about the list — the
// legacy "Auto" entry, capability filtering, disabled/no-capability flags, and the
// "(missing)" passthrough for unknown stored values — is preserved from the previous
// inline rendering in NodeProperties.tsx.
import {
  AI_PROVIDER_PRESETS,
  providerSupports,
  type AiCapability,
  type AiProviderConfig,
} from '../../../client-runtime/flows/aiProviders';

/** node.data.provider value for the plan §5.6 Settings-default alias. */
export const DEFAULT_PROVIDER_OPTION_VALUE = 'default';

export interface AiProviderOption {
  value: string;
  label: string;
}

export interface BuildAiProviderOptionsInput {
  /** Every AI service in this browser's registry (already user-scoped). */
  providers: AiProviderConfig[];
  /** The node's capability — only providers that declare it are offered. */
  capability: AiCapability;
  /** The stored node.data.provider value ('' when unset). */
  currentValue: string;
  /** Resolved default-source label (e.g. 'Site AI'); null while prefs load. */
  defaultSourceLabel: string | null;
}

/** The §5.6 alias option: always the TOP entry of the picker. */
export function defaultProviderOption(resolvedSourceLabel: string | null): AiProviderOption {
  return {
    value: DEFAULT_PROVIDER_OPTION_VALUE,
    label: resolvedSourceLabel
      ? `Default (from Settings) — ${resolvedSourceLabel}`
      : 'Default (from Settings)',
  };
}

export function buildAiProviderOptions(input: BuildAiProviderOptionsInput): AiProviderOption[] {
  const { providers, capability, currentValue, defaultSourceLabel } = input;
  const options: AiProviderOption[] = [
    defaultProviderOption(defaultSourceLabel),
    { value: '', label: 'Auto (Desktop/app default)' },
  ];

  // Only offer services that declare this node's capability (a custom service may be
  // chat-only / speech-only). The currently-selected service always stays listed —
  // flagged below — so a mismatch is visible and fixable, never silently dropped.
  const usable = providers.filter((provider) => provider.enabled && providerSupports(provider, capability));
  const explicitAlias = currentValue === '' || currentValue === DEFAULT_PROVIDER_OPTION_VALUE;
  const selected = explicitAlias ? null : providers.find((provider) => provider.id === currentValue) ?? null;
  const listed = selected && !usable.some((provider) => provider.id === selected.id) ? [...usable, selected] : usable;

  for (const provider of listed) {
    const flags = [
      provider.enabled ? '' : ' (disabled)',
      providerSupports(provider, capability) ? '' : ` (no ${capability})`,
    ].join('');
    options.push({
      value: provider.id,
      label: `${provider.name} - ${AI_PROVIDER_PRESETS[provider.kind].label}${flags}`,
    });
  }

  // Unknown stored values (e.g. a `provider:<id>` Desktop reference saved elsewhere, or
  // a deleted service) stay visible verbatim; the alias value never reads "(missing)".
  const known = explicitAlias || listed.some((provider) => provider.id === currentValue);
  if (!known) options.push({ value: currentValue, label: `${currentValue} (missing)` });
  return options;
}
