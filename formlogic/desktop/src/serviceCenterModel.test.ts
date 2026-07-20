import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildServiceCenterItems,
  CODEX_LOGIN_TIMEOUT_MS,
  DEFAULT_SERVICE_CENTER_QUERY,
  formatCodexReasoningEffort,
  getPersistedServiceCenterQuery,
  getCodexReasoningEfforts,
  isSafeBrowserAuthUrl,
  isSafeDeviceVerificationUrl,
  isCodexLoginExpired,
  queryServiceCenter,
  resetPersistedServiceCenterQuery,
  setPersistedServiceCenterQuery,
  shouldFocusServiceSearch,
  type AiProviderLike,
  type RuntimeServiceLike,
  type ServiceCenterItem,
} from './serviceCenterModel.ts';

const runtime: RuntimeServiceLike = {
  id: 'local-voice',
  name: 'Local Voice',
  description: 'Speech service for calls',
  category: 'Voice',
  tags: ['clinic', 'customer-owned'],
  capabilities: ['speech', 'realtime'],
  status: 'running',
  installed: true,
};

const openAi: AiProviderLike = {
  id: 'openai',
  name: 'Old ChatGPT label',
  category: 'Customer AI',
  tags: ['approved', 'production'],
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-test',
  capabilities: ['chat'],
  allowLocal: false,
  enabled: true,
  hasKey: false,
};

test('builds one catalog while distinguishing OpenAI API billing from Codex sign-in', () => {
  const items = buildServiceCenterItems([runtime], [openAi]);
  assert.equal(items.length, 3);

  const api = items.find((item) => item.key === 'provider:openai');
  assert.equal(api?.name, 'OpenAI API');
  assert.equal(api?.status, 'needs-setup');
  assert.equal(api?.kind, 'cloud-api');
  assert.equal(api?.category, 'Customer AI');
  assert.ok(api?.tags.includes('production'));
  assert.match(api?.description ?? '', /billed separately from ChatGPT/i);

  const codex = items.find((item) => item.key === 'catalog:openai-codex-agent');
  assert.equal(codex?.id, 'openai-codex-agent');
  assert.equal(codex?.name, 'Codex Agent — Sign in with ChatGPT');
  assert.equal(codex?.kind, 'delegated-agent');
  assert.equal(codex?.status, 'unavailable');
  assert.match(codex?.description ?? '', /not an OpenAI API key/i);
});

test('projects the live Codex definition and authentication state into the catalog', () => {
  const items = buildServiceCenterItems([], [], true, {
    id: 'openai-codex-agent',
    name: 'OpenAI Codex Agent — Sign in with ChatGPT',
    description: 'Catalog-owned description',
    kind: 'delegated-agent',
    category: { id: 'ai.agents', label: 'AI & Agents' },
    tags: ['codex', 'forms'],
    capabilities: ['agent.assistant'],
  }, {
    available: true,
    running: true,
    requiresOpenaiAuth: false,
    account: { email: 'owner@example.test' },
  });
  const codex = items[0];
  assert.equal(codex.name, 'OpenAI Codex Agent — Sign in with ChatGPT');
  assert.equal(codex.category, 'AI & Agents');
  assert.equal(codex.status, 'configured');
  assert.deepEqual(codex.capabilities, ['agent.assistant']);
});

test('does not relabel a merely OpenAI-compatible provider as OpenAI API', () => {
  const compatible: AiProviderLike = {
    ...openAi,
    id: 'compatible',
    name: 'Acme Compatible',
    baseUrl: 'https://llm.example.test/v1',
    hasKey: true,
  };
  const [item] = buildServiceCenterItems([], [compatible], false);
  assert.equal(item.name, 'Acme Compatible');
  assert.equal(item.isOpenAiApi, false);
});

test('searches names, tags, capabilities, descriptions and ranks exact names first', () => {
  const items = buildServiceCenterItems([runtime], [openAi]);
  const exact = queryServiceCenter(items, {
    ...DEFAULT_SERVICE_CENTER_QUERY,
    search: 'OpenAI API',
  });
  assert.equal(exact.items[0]?.key, 'provider:openai');

  const capability = queryServiceCenter(items, {
    ...DEFAULT_SERVICE_CENTER_QUERY,
    search: 'speech',
  });
  assert.deepEqual(capability.items.map((item) => item.key), ['runtime:local-voice']);

  const tag = queryServiceCenter(items, {
    ...DEFAULT_SERVICE_CENTER_QUERY,
    search: 'oauth',
  });
  assert.deepEqual(tag.items.map((item) => item.key), ['catalog:openai-codex-agent']);

  const customTag = queryServiceCenter(items, {
    ...DEFAULT_SERVICE_CENTER_QUERY,
    search: 'clinic',
  });
  assert.deepEqual(customTag.items.map((item) => item.key), ['runtime:local-voice']);
});

test('combines category, tag, status and kind filters and supports deterministic sorting', () => {
  const items = buildServiceCenterItems([runtime], [openAi]);
  const filtered = queryServiceCenter(items, {
    ...DEFAULT_SERVICE_CENTER_QUERY,
    category: 'Voice',
    tag: 'speech',
    status: 'running',
    kind: 'local-process',
  });
  assert.deepEqual(filtered.items.map((item) => item.key), ['runtime:local-voice']);

  const byStatus = queryServiceCenter(items, {
    ...DEFAULT_SERVICE_CENTER_QUERY,
    sort: 'status',
  });
  assert.deepEqual(byStatus.items.map((item) => item.status), [
    'running',
    'needs-setup',
    'unavailable',
  ]);
});

test('paginates at 12, 24 or 48 and clamps an out-of-range page', () => {
  const items: ServiceCenterItem[] = Array.from({ length: 30 }, (_, index) => ({
    key: `runtime:${index}`,
    source: 'runtime',
    id: String(index),
    name: `Service ${String(index).padStart(2, '0')}`,
    description: '',
    category: 'Test',
    tags: [],
    capabilities: [],
    status: 'stopped',
    kind: 'local-process',
  }));

  const twelve = queryServiceCenter(items, {
    ...DEFAULT_SERVICE_CENTER_QUERY,
    page: 99,
    pageSize: 12,
  });
  assert.equal(twelve.page, 3);
  assert.equal(twelve.pageCount, 3);
  assert.equal(twelve.items.length, 6);

  assert.equal(
    queryServiceCenter(items, { ...DEFAULT_SERVICE_CENTER_QUERY, pageSize: 24 }).items.length,
    24,
  );
  assert.equal(
    queryServiceCenter(items, { ...DEFAULT_SERVICE_CENTER_QUERY, pageSize: 48 }).items.length,
    30,
  );
});

test('preserves a defensive copy of query state across panel unmounts', () => {
  resetPersistedServiceCenterQuery();
  const next = { ...DEFAULT_SERVICE_CENTER_QUERY, search: 'voice', pageSize: 24 as const };
  setPersistedServiceCenterQuery(next);
  next.search = 'mutated outside';
  assert.equal(getPersistedServiceCenterQuery().search, 'voice');
  resetPersistedServiceCenterQuery();
  assert.deepEqual(getPersistedServiceCenterQuery(), DEFAULT_SERVICE_CENTER_QUERY);
});

test('slash focuses search only outside editable controls and without modifiers', () => {
  assert.equal(shouldFocusServiceSearch({ key: '/', target: { tagName: 'DIV' } }), true);
  assert.equal(shouldFocusServiceSearch({ key: '/', target: { tagName: 'INPUT' } }), false);
  assert.equal(shouldFocusServiceSearch({ key: '/', target: { isContentEditable: true } }), false);
  assert.equal(shouldFocusServiceSearch({ key: '/', ctrlKey: true }), false);
  assert.equal(shouldFocusServiceSearch({ key: 'k' }), false);
});

test('accepts only credential-free HTTPS browser authentication URLs', () => {
  assert.equal(isSafeBrowserAuthUrl('https://auth.example.test/oauth?state=safe'), true);
  assert.equal(isSafeBrowserAuthUrl('http://auth.example.test/oauth'), false);
  assert.equal(isSafeBrowserAuthUrl('javascript:alert(1)'), false);
  assert.equal(isSafeBrowserAuthUrl('https://user:secret@example.test/oauth'), false);
  assert.equal(isSafeBrowserAuthUrl('not a url'), false);
  assert.equal(isSafeDeviceVerificationUrl('https://auth.example.test/activate'), true);
  assert.equal(isSafeDeviceVerificationUrl('https://auth.example.test/activate?code=secret'), false);
  assert.equal(isSafeDeviceVerificationUrl('https://auth.example.test/activate#secret'), false);
});

test('expires pending Codex login at the bounded ten-minute deadline', () => {
  const startedAt = 1_000;
  assert.equal(isCodexLoginExpired(startedAt, startedAt + CODEX_LOGIN_TIMEOUT_MS - 1), false);
  assert.equal(isCodexLoginExpired(startedAt, startedAt + CODEX_LOGIN_TIMEOUT_MS), true);
});

test('derives bounded reasoning choices from string and object model metadata', () => {
  assert.deepEqual(getCodexReasoningEfforts({
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'none' },
      'low',
      { reasoningEffort: 'high' },
      { value: 'low' },
      { id: 'not-a-real-effort' },
    ],
  }), ['medium', 'none', 'low', 'high']);
  assert.deepEqual(getCodexReasoningEfforts({
    defaultReasoningEffort: 'xhigh',
    supportedReasoningEfforts: [],
  }), ['xhigh']);
  assert.equal(formatCodexReasoningEffort('none'), 'Off (fastest)');
  assert.equal(formatCodexReasoningEffort('xhigh'), 'Extra high');
});
