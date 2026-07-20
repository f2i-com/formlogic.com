export type ServiceCenterSource = 'runtime' | 'provider' | 'catalog';
export type ServiceCenterKind =
  | 'local-process'
  | 'local-api'
  | 'cloud-api'
  | 'delegated-agent';
export type ServiceCenterStatus =
  | 'running'
  | 'stopped'
  | 'busy'
  | 'error'
  | 'configured'
  | 'needs-setup'
  | 'disabled'
  | 'unavailable';
export type ServiceCenterSort = 'relevance' | 'name' | 'status' | 'kind';
export type ServiceCenterPageSize = 12 | 24 | 48;

export interface RuntimeServiceLike {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  capabilities?: string[];
  status: 'stopped' | 'installing' | 'starting' | 'running' | 'errored';
  installed: boolean;
  owner?: string;
}

export interface AiProviderLike {
  id: string;
  name: string;
  category?: string;
  tags?: string[];
  protocol: string;
  baseUrl: string;
  model?: string;
  capabilities: string[];
  allowLocal: boolean;
  enabled: boolean;
  hasKey: boolean;
}

export interface ServiceDefinitionLike {
  id: string;
  name: string;
  description: string;
  kind: string;
  category: { id: string; label: string };
  tags: string[];
  capabilities: string[];
}

export interface CodexStatusLike {
  available: boolean;
  running: boolean;
  requiresOpenaiAuth: boolean;
  account?: unknown;
  error?: string;
}

export interface ServiceCenterItem {
  key: string;
  source: ServiceCenterSource;
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  capabilities: string[];
  status: ServiceCenterStatus;
  kind: ServiceCenterKind;
  /** Exact OpenAI Platform API identity; compatible APIs intentionally remain generic. */
  isOpenAiApi?: boolean;
}

export interface ServiceCenterQuery {
  search: string;
  category: string;
  tag: string;
  status: string;
  kind: string;
  sort: ServiceCenterSort;
  page: number;
  pageSize: ServiceCenterPageSize;
}

export interface ServiceCenterResult {
  items: ServiceCenterItem[];
  total: number;
  page: number;
  pageCount: number;
}

export const DEFAULT_SERVICE_CENTER_QUERY: ServiceCenterQuery = {
  search: '',
  category: '',
  tag: '',
  status: '',
  kind: '',
  sort: 'relevance',
  page: 1,
  pageSize: 12,
};

export const CODEX_AGENT_CATALOG_ITEM: ServiceCenterItem = {
  key: 'catalog:openai-codex-agent',
  source: 'catalog',
  id: 'openai-codex-agent',
  name: 'Codex Agent — Sign in with ChatGPT',
  description:
    'Use an eligible ChatGPT plan through a local Codex agent, including an experimental text-only Aokie call lane. This is not an OpenAI API key or Realtime voice provider.',
  category: 'AI agents',
  tags: ['codex', 'chatgpt', 'oauth', 'agent', 'calls', 'experimental', 'pilot'],
  capabilities: ['chat', 'form generation', 'app generation', 'experimental call LLM'],
  status: 'unavailable',
  kind: 'delegated-agent',
};

export const CODEX_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function unique(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))),
  );
}

function runtimeStatus(service: RuntimeServiceLike): ServiceCenterStatus {
  if (service.status === 'running') return 'running';
  if (service.status === 'errored') return 'error';
  if (service.status === 'installing' || service.status === 'starting') return 'busy';
  return 'stopped';
}

export function isOpenAiPlatformProvider(provider: AiProviderLike): boolean {
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function providerStatus(provider: AiProviderLike, isOpenAiApi: boolean): ServiceCenterStatus {
  if (!provider.enabled) return 'disabled';
  if (isOpenAiApi && !provider.hasKey) return 'needs-setup';
  return 'configured';
}

export function buildServiceCenterItems(
  runtimeServices: RuntimeServiceLike[],
  providers: AiProviderLike[],
  includeCatalog = true,
  codexDefinition?: ServiceDefinitionLike,
  codexStatus?: CodexStatusLike,
): ServiceCenterItem[] {
  const runtimeItems = runtimeServices.map<ServiceCenterItem>((service) => ({
    key: `runtime:${service.id}`,
    source: 'runtime',
    id: service.id,
    name: service.name,
    description: service.description,
    category: service.category || 'Local services',
    tags: unique([
      'local',
      'process',
      service.installed ? 'installed' : 'not installed',
      service.owner ? `plugin:${service.owner}` : undefined,
      ...(service.tags ?? []),
      ...(service.capabilities ?? []),
    ]),
    capabilities: unique(service.capabilities ?? []),
    status: runtimeStatus(service),
    kind: 'local-process',
  }));

  const providerItems = providers.map<ServiceCenterItem>((provider) => {
    const isOpenAiApi = isOpenAiPlatformProvider(provider);
    return {
      key: `provider:${provider.id}`,
      source: 'provider',
      id: provider.id,
      name: isOpenAiApi ? 'OpenAI API' : provider.name || provider.id,
      description: isOpenAiApi
        ? 'OpenAI Platform API using your API key. Usage is billed separately from ChatGPT subscriptions.'
        : `${provider.protocol} endpoint at ${provider.baseUrl}`,
      category:
        provider.category?.trim() || (provider.allowLocal ? 'Local AI APIs' : 'Cloud AI APIs'),
      tags: unique([
        ...(provider.tags ?? []),
        provider.protocol,
        provider.allowLocal ? 'local' : 'cloud',
        isOpenAiApi ? 'openai-api' : undefined,
        provider.model,
        ...provider.capabilities,
      ]),
      capabilities: unique(provider.capabilities),
      status: providerStatus(provider, isOpenAiApi),
      kind: provider.allowLocal ? 'local-api' : 'cloud-api',
      isOpenAiApi,
    };
  });

  if (!includeCatalog) return [...runtimeItems, ...providerItems];

  const codexItem: ServiceCenterItem = {
    ...CODEX_AGENT_CATALOG_ITEM,
    name: codexDefinition?.name ?? CODEX_AGENT_CATALOG_ITEM.name,
    description: codexDefinition?.description ?? CODEX_AGENT_CATALOG_ITEM.description,
    category: codexDefinition?.category.label ?? CODEX_AGENT_CATALOG_ITEM.category,
    tags: unique(codexDefinition?.tags ?? CODEX_AGENT_CATALOG_ITEM.tags),
    capabilities: unique(codexDefinition?.capabilities ?? CODEX_AGENT_CATALOG_ITEM.capabilities),
    status:
      codexStatus?.available && !codexStatus.requiresOpenaiAuth && codexStatus.account
        ? 'configured'
        : codexStatus?.available
          ? 'needs-setup'
          : 'unavailable',
  };
  return [...runtimeItems, ...providerItems, codexItem];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function relevance(item: ServiceCenterItem, search: string): number {
  const query = normalize(search);
  if (!query) return 0;
  const name = normalize(item.name);
  const id = normalize(item.id);
  const category = normalize(item.category);
  const tags = item.tags.map(normalize);
  const capabilities = item.capabilities.map(normalize);
  const description = normalize(item.description);

  let score = 0;
  if (name === query || id === query) score += 1000;
  if (name.startsWith(query) || id.startsWith(query)) score += 400;
  if (name.includes(query) || id.includes(query)) score += 220;
  if (category === query) score += 140;
  if (category.includes(query)) score += 80;
  if (tags.some((tag) => tag === query)) score += 130;
  if (tags.some((tag) => tag.includes(query))) score += 70;
  if (capabilities.some((capability) => capability === query)) score += 120;
  if (capabilities.some((capability) => capability.includes(query))) score += 60;
  if (description.includes(query)) score += 25;
  return score;
}

const STATUS_ORDER: ServiceCenterStatus[] = [
  'running',
  'configured',
  'busy',
  'needs-setup',
  'stopped',
  'disabled',
  'error',
  'unavailable',
];

export function queryServiceCenter(
  allItems: ServiceCenterItem[],
  query: ServiceCenterQuery,
): ServiceCenterResult {
  const search = normalize(query.search);
  const filtered = allItems.filter((item) => {
    if (query.category && item.category !== query.category) return false;
    if (query.tag && !item.tags.includes(query.tag)) return false;
    if (query.status && item.status !== query.status) return false;
    if (query.kind && item.kind !== query.kind) return false;
    return !search || relevance(item, search) > 0;
  });

  filtered.sort((a, b) => {
    if (query.sort === 'relevance' && search) {
      const score = relevance(b, search) - relevance(a, search);
      if (score !== 0) return score;
    } else if (query.sort === 'status') {
      const status = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      if (status !== 0) return status;
    } else if (query.sort === 'kind') {
      const kind = a.kind.localeCompare(b.kind);
      if (kind !== 0) return kind;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const pageSize: ServiceCenterPageSize = [12, 24, 48].includes(query.pageSize)
    ? query.pageSize
    : 12;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(query.page) || 1), pageCount);
  const start = (page - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageCount,
  };
}

export function getServiceCenterFacetOptions(items: ServiceCenterItem[]) {
  const sorted = (values: string[]) => unique(values).sort((a, b) => a.localeCompare(b));
  return {
    categories: sorted(items.map((item) => item.category)),
    tags: sorted(items.flatMap((item) => item.tags)),
    statuses: sorted(items.map((item) => item.status)),
    kinds: sorted(items.map((item) => item.kind)),
  };
}

let persistedQuery: ServiceCenterQuery = { ...DEFAULT_SERVICE_CENTER_QUERY };

export function getPersistedServiceCenterQuery(): ServiceCenterQuery {
  return { ...persistedQuery };
}

export function setPersistedServiceCenterQuery(query: ServiceCenterQuery): void {
  persistedQuery = { ...query };
}

export function resetPersistedServiceCenterQuery(): void {
  persistedQuery = { ...DEFAULT_SERVICE_CENTER_QUERY };
}

export function shouldFocusServiceSearch(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}): boolean {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return false;
  const tag = event.target?.tagName?.toLowerCase();
  return !event.target?.isContentEditable && tag !== 'input' && tag !== 'textarea' && tag !== 'select';
}

export function isSafeBrowserAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isSafeDeviceVerificationUrl(value: string): boolean {
  if (!isSafeBrowserAuthUrl(value)) return false;
  const url = new URL(value);
  return url.search === '' && url.hash === '';
}

export function isCodexLoginExpired(startedAt: number, now = Date.now()): boolean {
  return Number.isFinite(startedAt) && now - startedAt >= CODEX_LOGIN_TIMEOUT_MS;
}

const CODEX_REASONING_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export function formatCodexReasoningEffort(value: string): string {
  const labels: Record<string, string> = {
    none: 'Off (fastest)',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Maximum',
    ultra: 'Ultra',
  };
  return labels[value] ?? value;
}

export function getCodexReasoningEfforts(model: {
  defaultReasoningEffort: string;
  supportedReasoningEfforts: unknown[];
} | null | undefined): string[] {
  if (!model) return [];
  const values: string[] = [];
  for (const raw of model.supportedReasoningEfforts) {
    const candidate = typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object'
        ? ['reasoningEffort', 'effort', 'value', 'id']
            .map((key) => (raw as Record<string, unknown>)[key])
            .find((value): value is string => typeof value === 'string')
        : undefined;
    if (candidate && (CODEX_REASONING_VALUES as readonly string[]).includes(candidate)) {
      values.push(candidate);
    }
  }
  if (
    (CODEX_REASONING_VALUES as readonly string[]).includes(model.defaultReasoningEffort) &&
    !values.includes(model.defaultReasoningEffort)
  ) {
    values.unshift(model.defaultReasoningEffort);
  }
  return Array.from(new Set(values));
}

export interface CodexTryoutModelLike {
  model: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: unknown[];
}

export interface CodexPhoneConfigurationLike {
  configured: boolean;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export interface CodexTryoutDefaults {
  model: string;
  reasoningEffort: string;
  serviceTier?: 'priority';
  matchesPhoneConfiguration: boolean;
  configurationError?: string;
}

/**
 * Pick the Service Center tryout lane. An exact Aokie Codex phone selection
 * wins over Codex's general catalog default; malformed/stale phone metadata
 * fails visibly instead of silently testing a different model or effort.
 */
export function getCodexTryoutDefaults(
  models: CodexTryoutModelLike[],
  phone: CodexPhoneConfigurationLike | null | undefined,
): CodexTryoutDefaults {
  const fallbackModel = models.find((model) => model.isDefault) ?? models[0];
  const fallbackEfforts = getCodexReasoningEfforts(fallbackModel);
  const fallback: CodexTryoutDefaults = {
    model: fallbackModel?.model ?? '',
    reasoningEffort:
      fallbackModel && fallbackEfforts.includes(fallbackModel.defaultReasoningEffort)
        ? fallbackModel.defaultReasoningEffort
        : fallbackEfforts[0] ?? '',
    matchesPhoneConfiguration: false,
  };
  if (!phone?.configured) return fallback;

  if (!phone.model || !phone.reasoningEffort) {
    return {
      ...fallback,
      configurationError: 'Aokie returned an incomplete ChatGPT phone configuration.',
    };
  }
  if (phone.serviceTier !== undefined && phone.serviceTier !== 'priority') {
    return {
      ...fallback,
      configurationError: 'Aokie returned an unsupported ChatGPT service tier.',
    };
  }
  const configuredModel = models.find((model) => model.model === phone.model);
  if (!configuredModel) {
    return {
      ...fallback,
      configurationError: `The phone model ${phone.model} is not available to this ChatGPT account.`,
    };
  }
  if (!getCodexReasoningEfforts(configuredModel).includes(phone.reasoningEffort)) {
    return {
      ...fallback,
      configurationError: `${phone.model} does not offer the phone's ${phone.reasoningEffort} reasoning setting.`,
    };
  }
  return {
    model: phone.model,
    reasoningEffort: phone.reasoningEffort,
    serviceTier: phone.serviceTier,
    matchesPhoneConfiguration: true,
  };
}

/** Stable, compact wall-clock display shared by the live and final timer. */
export function formatCodexResponseDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1_000;
  return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
}
