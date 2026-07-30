// Tests for the Site Chat engine (plan §5.4 + Phase 6).
//
// Covers: source routing per the user's preference (site/desktop/custom, plus typed
// unresolved failures with NO silent source hop), the hosted-chat SSE parser (deltas,
// tool events, done-with-content, error events, CRLF + split-chunk boundaries), the
// desktop source's per-turn tool grant + toolMode/toolGrant pass-through (a mint failure
// degrades to an honest note, never a failed turn), tool proposal normalization +
// answerToolProposal's postInput payload, and the demo account's tools-off behavior.
import { describe, expect, it, vi } from 'vitest';
import {
  answerToolProposal,
  chatTextOf,
  createSiteChatSseParser,
  historyFor,
  normalizeToolActivity,
  normalizeToolProposal,
  sendChatTurn,
  sinceLastSummary,
  SUMMARY_PREFIX,
  type ChatEngineDeps,
  type ChatToolActivity,
  type ChatToolProposal,
  type ChatTurnError,
  type SendChatTurnOptions,
} from './chatEngine';
import type { AiDefaultResult, AiPreferences } from '../../client-runtime/flows/aiDefault';
import type { ChatViaTunnelOptions, ChatViaTunnelSuccess, DesktopTunnelResult } from '../../client-runtime/desktop/desktopTunnel';

const MESSAGES = [{ role: 'user', content: 'make me a contact form' }];

function prefs(overrides: Partial<AiPreferences> = {}): AiPreferences {
  return {
    aiSource: 'site',
    desktopProviderId: null,
    desktopModel: null,
    customProviderId: null,
    chatToolMode: null,
    ...overrides,
  };
}

function prefsDeps(value: AiPreferences, more: ChatEngineDeps = {}): ChatEngineDeps {
  return {
    fetchPreferences: async (): Promise<AiDefaultResult<AiPreferences>> => ({ ok: true, data: value }),
    apiBase: (endpoint) => `http://api.test/api${endpoint}`,
    csrfToken: () => 'csrf-1',
    ...more,
  };
}

function turn(overrides: Partial<SendChatTurnOptions> = {}): SendChatTurnOptions {
  return { threadId: 'thread-1', messages: MESSAGES, ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const okTunnel = (finalText = 'desktop reply') =>
  vi.fn(
    async (opts: ChatViaTunnelOptions): Promise<DesktopTunnelResult<ChatViaTunnelSuccess>> => ({
      ok: true,
      data: { threadId: opts.threadId ?? 'thread-1', finalText },
    })
  );

const okGrant = () => vi.fn(async () => ({ data: { grantToken: 'grant-1', expiresAt: '' }, status: 200 }));

// ---------------------------------------------------------------------------
// Hosted SSE parser (pure).
// ---------------------------------------------------------------------------

describe('createSiteChatSseParser', () => {
  function collect() {
    const deltas: string[] = [];
    const activities: ChatToolActivity[] = [];
    const done: Array<{ usage?: unknown; content?: string }> = [];
    const errors: ChatTurnError[] = [];
    const parser = createSiteChatSseParser({
      onDelta: (delta) => deltas.push(delta),
      onToolActivity: (a) => activities.push(a),
      onDone: (info) => done.push(info),
      onError: (e) => errors.push(e),
    });
    return { parser, deltas, activities, done, errors };
  }

  it('parses deltas, tool_call events, and done-with-content', () => {
    const { parser, deltas, activities, done, errors } = collect();
    parser.push('event: delta\ndata: {"content":"Hel"}\n\n');
    parser.push('data: {"content":"lo"}\n\n');
    parser.push('data: {"type":"tool_call","name":"create_form","status":"done","result":{"formId":"f-1"}}\n\n');
    parser.push('event: done\ndata: {"content":"Hello","usage":{"in":3}}\n\n');
    parser.push('event: end\ndata: {}\n\n');
    parser.end();

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(activities).toEqual([
      { id: expect.any(String), name: 'create_form', label: 'Create a form', status: 'done', link: { kind: 'form', id: 'f-1' } },
    ]);
    expect(done).toEqual([{ content: 'Hello', usage: { in: 3 } }]);
    expect(errors).toEqual([]);
  });

  it('surfaces a typed error event (JSON and raw-text bodies)', () => {
    const { parser, errors } = collect();
    parser.push('event: error\ndata: {"code":"ai_allowance_exceeded","message":"Allowance used up."}\n\n');
    parser.push('event: error\ndata: not-json at all\n\n');
    parser.end();

    expect(errors).toEqual([
      { code: 'ai_allowance_exceeded', message: 'Allowance used up.' },
      { code: 'request_failed', message: 'not-json at all' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const { parser, deltas, done } = collect();
    parser.push('data: {"content":"a"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n');
    parser.end();
    expect(deltas).toEqual(['a']);
    expect(done).toHaveLength(1);
  });

  it('reassembles events split across arbitrary chunk boundaries', () => {
    const { parser, deltas } = collect();
    const wire = 'event: delta\ndata: {"content":"split"}\n\ndata: {"content":" up"}\n\n';
    for (const ch of wire) parser.push(ch); // worst case: one char per chunk
    parser.end();
    expect(deltas).toEqual(['split', ' up']);
  });

  it('flushes a trailing event with no final newline on end()', () => {
    const { parser, done } = collect();
    parser.push('event: done\ndata: {"content":"tail"}');
    parser.end();
    expect(done).toEqual([{ content: 'tail' }]);
  });
});

// ---------------------------------------------------------------------------
// Source routing (one source per turn, typed failures, no silent hop).
// ---------------------------------------------------------------------------

describe('sendChatTurn — routing', () => {
  it('passes a typed preferences failure through with source null', async () => {
    const out = await sendChatTurn(turn(), {
      fetchPreferences: async () => ({ ok: false, error: { code: 'auth_required', message: 'Sign in again.' } }),
    });
    expect(out).toEqual({ ok: false, source: null, error: { code: 'auth_required', message: 'Sign in again.' } });
  });

  it('maps a thrown preferences fetch to ai_default_unresolved', async () => {
    const out = await sendChatTurn(turn(), {
      fetchPreferences: async () => {
        throw new Error('boom');
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.source).toBeNull();
      expect(out.error.code).toBe('ai_default_unresolved');
      expect(out.error.message).toContain('boom');
    }
  });

  it('site source → POST /api/ai/chat with tools:true (JSON fallback body accepted)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: { content: 'site says hi' } }));
    const out = await sendChatTurn(turn(), prefsDeps(prefs(), { fetchFn }));

    expect(out).toEqual({ ok: true, source: 'site', content: 'site says hi' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/ai/chat');
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-1');
    expect(JSON.parse(String(init.body))).toEqual({ messages: MESSAGES, stream: true, tools: true });
  });

  it('site source on the demo account sends tools:false', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: { content: 'demo reply' } }));
    const out = await sendChatTurn(turn({ isDemo: true }), prefsDeps(prefs(), { fetchFn }));
    expect(out.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).tools).toBe(false);
  });

  it('noTools forces tools:false on the site wire (the compaction summary turn)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: { content: 'summary text' } }));
    const out = await sendChatTurn(turn({ noTools: true }), prefsDeps(prefs(), { fetchFn }));
    expect(out.ok).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).tools).toBe(false);
  });

  it('site source streams SSE deltas + tool activity and prefers the done content', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        'event: delta\ndata: {"content":"Hel"}\n\n',
        'data: {"content":"lo"}\n\n',
        'data: {"type":"tool_call","name":"create_app","status":"running"}\n\n',
        'event: done\ndata: {"content":"Hello there"}\n\n',
      ])
    );
    const deltas: string[] = [];
    const activities: ChatToolActivity[] = [];
    const out = await sendChatTurn(
      turn({ events: { onDelta: (d) => deltas.push(d), onToolActivity: (a) => activities.push(a) } }),
      prefsDeps(prefs(), { fetchFn })
    );

    expect(out).toEqual({ ok: true, source: 'site', content: 'Hello there' });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(activities).toMatchObject([{ name: 'create_app', status: 'running' }]);
  });

  it('site source surfaces a mid-stream error event as a typed failure', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse(['data: {"content":"partial"}\n\n', 'event: error\ndata: {"code":"request_failed","message":"upstream died"}\n\n'])
    );
    const out = await sendChatTurn(turn(), prefsDeps(prefs(), { fetchFn }));
    expect(out).toEqual({ ok: false, source: 'site', error: { code: 'request_failed', message: 'upstream died' } });
  });

  it('site source maps a non-2xx refusal to its typed code (ai_allowance_exceeded)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: true, code: 'ai_allowance_exceeded', message: 'Monthly allowance used up.' }, 402)
    );
    const out = await sendChatTurn(turn(), prefsDeps(prefs(), { fetchFn }));
    expect(out).toEqual({
      ok: false,
      source: 'site',
      error: { code: 'ai_allowance_exceeded', message: 'Monthly allowance used up.' },
    });
  });

  it('desktop source mints one grant per turn and seals toolMode + toolGrant through the tunnel', async () => {
    const tunnelChat = okTunnel();
    const mintToolGrant = okGrant();
    const out = await sendChatTurn(
      turn({ clientSeq: 3 }),
      prefsDeps(prefs({ aiSource: 'desktop', desktopProviderId: 'openai-codex-agent', desktopModel: 'gpt-5-codex' }), {
        tunnelChat,
        mintToolGrant,
      })
    );

    expect(out).toEqual({ ok: true, source: 'desktop', content: 'desktop reply' });
    expect(mintToolGrant).toHaveBeenCalledTimes(1);
    expect(tunnelChat).toHaveBeenCalledTimes(1);
    const opts = tunnelChat.mock.calls[0][0];
    expect(opts).toMatchObject({
      providerId: 'openai-codex-agent',
      model: 'gpt-5-codex',
      threadId: 'thread-1',
      messages: MESSAGES,
      clientSeq: 3,
      toolMode: 'auto',
      toolGrant: 'grant-1',
    });
  });

  it("desktop source passes toolMode 'confirm' when the preference says so", async () => {
    const tunnelChat = okTunnel();
    await sendChatTurn(
      turn(),
      prefsDeps(prefs({ aiSource: 'desktop', desktopProviderId: 'codex', chatToolMode: 'confirm' }), {
        tunnelChat,
        mintToolGrant: okGrant(),
      })
    );
    expect(tunnelChat.mock.calls[0][0].toolMode).toBe('confirm');
  });

  it('desktop source degrades a mint failure to a note — the turn still succeeds without tools', async () => {
    const tunnelChat = okTunnel();
    const out = await sendChatTurn(
      turn(),
      prefsDeps(prefs({ aiSource: 'desktop', desktopProviderId: 'codex' }), {
        tunnelChat,
        mintToolGrant: vi.fn(async () => ({ error: 'grant route down', status: 503 })),
      })
    );

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.note).toContain('grant route down');
      expect(out.note).toContain('unavailable');
    }
    expect(tunnelChat.mock.calls[0][0].toolGrant).toBeUndefined();
  });

  it('desktop source on the demo account never mints a grant and notes tools are off', async () => {
    const tunnelChat = okTunnel();
    const mintToolGrant = okGrant();
    const out = await sendChatTurn(
      turn({ isDemo: true }),
      prefsDeps(prefs({ aiSource: 'desktop', desktopProviderId: 'codex' }), { tunnelChat, mintToolGrant })
    );
    expect(mintToolGrant).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.note).toBe('Tool actions are disabled in the demo.');
    expect(tunnelChat.mock.calls[0][0].toolGrant).toBeUndefined();
  });

  it('desktop source without a chosen provider fails typed (ai_default_unresolved), no hop', async () => {
    const tunnelChat = okTunnel();
    const fetchFn = vi.fn();
    const out = await sendChatTurn(
      turn(),
      prefsDeps(prefs({ aiSource: 'desktop' }), { tunnelChat, fetchFn, mintToolGrant: okGrant() })
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.source).toBe('desktop');
      expect(out.error.code).toBe('ai_default_unresolved');
    }
    expect(tunnelChat).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('desktop source passes tunnel failures through verbatim', async () => {
    const tunnelChat = vi.fn(
      async (): Promise<DesktopTunnelResult<ChatViaTunnelSuccess>> => ({
        ok: false,
        error: { code: 'desktop_offline', message: 'The desktop is not reachable.' },
      })
    );
    const out = await sendChatTurn(
      turn(),
      prefsDeps(prefs({ aiSource: 'desktop', desktopProviderId: 'codex' }), { tunnelChat, mintToolGrant: okGrant() })
    );
    expect(out).toEqual({
      ok: false,
      source: 'desktop',
      error: { code: 'desktop_offline', message: 'The desktop is not reachable.' },
    });
  });

  it('desktop source normalizes tunnel frames into tool proposals + activities', async () => {
    const tunnelChat = vi.fn(async (opts: ChatViaTunnelOptions): Promise<DesktopTunnelResult<ChatViaTunnelSuccess>> => {
      opts.onFrame?.({ type: 'tool_proposal', callId: 'call-1', requestId: 'req-9', tool: 'create_form', input: { title: 'Contact' } });
      opts.onFrame?.({ type: 'tool_call', name: 'create_form', status: 'done', result: { formId: 'f-1' }, requestId: 'req-9' });
      return { ok: true, data: { threadId: 'thread-1', finalText: 'Created it.' } };
    });
    const proposals: ChatToolProposal[] = [];
    const activities: ChatToolActivity[] = [];
    const out = await sendChatTurn(
      turn({ events: { onToolProposal: (p) => proposals.push(p), onToolActivity: (a) => activities.push(a) } }),
      prefsDeps(prefs({ aiSource: 'desktop', desktopProviderId: 'codex' }), { tunnelChat, mintToolGrant: okGrant() })
    );

    expect(out.ok).toBe(true);
    expect(proposals).toEqual([
      { callId: 'call-1', requestId: 'req-9', tool: 'create_form', toolLabel: 'Create a form', input: { title: 'Contact' }, status: 'pending' },
    ]);
    expect(activities).toMatchObject([{ name: 'create_form', status: 'done', link: { kind: 'form', id: 'f-1' } }]);
  });

  it('custom source answers text-only with the honest no-tools note', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'custom pong' } }] }));
    const out = await sendChatTurn(
      turn(),
      prefsDeps(prefs({ aiSource: 'custom', customProviderId: 'my-openai' }), {
        fetchFn,
        resolveCustomProvider: async () => ({
          name: 'My OpenAI',
          kind: 'openai',
          url: 'https://api.openai.test/v1/chat/completions',
          headers: { 'Content-Type': 'application/json' },
          responsePath: 'choices.0.message.content',
        }),
      })
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toBe('custom');
      expect(out.content).toBe('custom pong');
      expect(out.note).toContain('text-only');
    }
  });

  it('custom source fails typed when unset or not configured in this browser', async () => {
    const unset = await sendChatTurn(turn(), prefsDeps(prefs({ aiSource: 'custom' })));
    expect(unset.ok).toBe(false);
    if (!unset.ok) expect(unset.error.code).toBe('ai_default_unresolved');

    const missing = await sendChatTurn(
      turn(),
      prefsDeps(prefs({ aiSource: 'custom', customProviderId: 'gone' }), { resolveCustomProvider: async () => null })
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.source).toBe('custom');
      expect(missing.error.code).toBe('ai_default_unresolved');
      expect(missing.error.message).toContain('gone');
    }
  });
});

// ---------------------------------------------------------------------------
// Tool proposal normalization + the approve/deny answer path.
// ---------------------------------------------------------------------------

describe('normalizeToolActivity', () => {
  it('normalizes tool events, deriving errors and deep links', () => {
    expect(
      normalizeToolActivity({ type: 'tool_call', name: 'create_form', status: 'done', result: { form: { form_id: 'f-2' } } })
    ).toMatchObject({ name: 'create_form', status: 'done', link: { kind: 'form', id: 'f-2' } });
    expect(normalizeToolActivity({ type: 'tool_call', name: 'list_apps', status: 'failed', message: 'nope' })).toMatchObject({
      status: 'failed',
      error: 'nope',
    });
    expect(normalizeToolActivity({ type: 'delta', name: 'x' })).toBeNull();
    expect(normalizeToolActivity({ type: 'tool_call' })).toBeNull(); // no tool name
  });

  it('classifies a bare result id by the tool name', () => {
    expect(normalizeToolActivity({ type: 'tool_result', tool: 'create_flow', status: 'done', result: { id: 'fl-9' } })).toMatchObject({
      link: { kind: 'flow', id: 'fl-9' },
    });
  });

  it('walks app-building tools through the App Studio (Follow-AI narrative)', () => {
    // create_app returns the app itself — its bare id is the app id, no step
    // (the studio entry redirect picks the natural first step).
    expect(
      normalizeToolActivity({ type: 'tool_result', name: 'create_app', status: 'done', result: { id: 'a-1', name: 'Ops' } })
    ).toMatchObject({ link: { kind: 'app', id: 'a-1' } });
    // create_app_form names BOTH the form and the app — the APP link (Data step)
    // wins so Follow-AI stays in the studio instead of bouncing to the builder.
    expect(
      normalizeToolActivity({ type: 'tool_result', name: 'create_app_form', status: 'done', result: { form: { id: 'f-1' }, appId: 'a-1' } })
    ).toMatchObject({ link: { kind: 'app', id: 'a-1', step: 'data' } });
    expect(
      normalizeToolActivity({ type: 'tool_result', name: 'create_flow', status: 'done', result: { id: 'fl-1', appId: 'a-1' } })
    ).toMatchObject({ link: { kind: 'app', id: 'a-1', step: 'automations' } });
    expect(
      normalizeToolActivity({ type: 'tool_result', name: 'update_app', status: 'done', result: { id: 'a-1', status: 'published' } })
    ).toMatchObject({ link: { kind: 'app', id: 'a-1', step: 'publish' } });
  });

  it('links the screen tools to their Studios, not the builder/app list', () => {
    // set_form_screen returns the updated FORM — the link must be the screen studio kind,
    // never the generic form/builder link the name-based fallback would produce.
    expect(
      normalizeToolActivity({ type: 'tool_result', name: 'set_form_screen', status: 'done', result: { id: 'f-7', title: 'T' } })
    ).toMatchObject({ link: { kind: 'formScreen', id: 'f-7' } });
    expect(
      normalizeToolActivity({ type: 'tool_result', name: 'set_app_home', status: 'done', result: { id: 'a-3', name: 'App' } })
    ).toMatchObject({ link: { kind: 'appScreen', id: 'a-3' } });
    // No id in the result → no link (never a dead link).
    expect(normalizeToolActivity({ type: 'tool_result', name: 'set_app_home', status: 'done', result: 'ok' })?.link).toBeUndefined();
  });
});

describe('normalizeToolProposal + answerToolProposal', () => {
  it('prefers the frame requestId and falls back to the callId', () => {
    expect(normalizeToolProposal({ type: 'tool_proposal', callId: 'c1', requestId: 'r1', tool: 't', input: 1 })).toEqual({
      callId: 'c1',
      requestId: 'r1',
      tool: 't',
      // Unknown tool names fall back to the raw id, so nothing ever renders blank.
      toolLabel: 't',
      input: 1,
      status: 'pending',
    });
    expect(normalizeToolProposal({ type: 'tool_proposal', callId: 'c2' })?.requestId).toBe('c2');
    expect(normalizeToolProposal({ type: 'tool_call', callId: 'c3' })).toBeNull();
  });

  it('answers via postInput with the {type, callId, approved} payload', async () => {
    const postInputFn = vi.fn(async () => ({ ok: true as const, data: { accepted: true } }));
    const proposal: ChatToolProposal = { callId: 'call-1', requestId: 'req-1', tool: 'create_form', input: null, status: 'pending' };

    const approved = await answerToolProposal(proposal, true, { postInputFn });
    expect(approved).toEqual({ ok: true });
    const denied = await answerToolProposal(proposal, false, { postInputFn });
    expect(denied).toEqual({ ok: true });

    expect(postInputFn.mock.calls).toEqual([
      ['req-1', { type: 'tool_approval', callId: 'call-1', approved: true }],
      ['req-1', { type: 'tool_approval', callId: 'call-1', approved: false }],
    ]);
  });

  it('maps a session_unknown refusal to the already-completed copy', async () => {
    const postInputFn = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'session_unknown' as const, message: 'no session' },
    }));
    const proposal: ChatToolProposal = { callId: 'c', requestId: 'r', tool: 't', input: null, status: 'pending' };
    const res = await answerToolProposal(proposal, true, { postInputFn });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no longer answerable');
  });
});

// ---------------------------------------------------------------------------
// Chat compaction history assembly (SUMMARY_PREFIX marker messages).
// ---------------------------------------------------------------------------

describe('compaction history helpers', () => {
  const msg = (role: string, content: string) => ({ role, content });

  it('no marker: the full transcript rides the wire', () => {
    const msgs = [msg('user', 'hi'), msg('assistant', 'hello')];
    expect(sinceLastSummary(msgs)).toEqual({ summary: null, tail: msgs });
    expect(historyFor(msgs)).toEqual(msgs);
  });

  it('marker present: summary becomes a leading system message + only the tail rides', () => {
    const summary = `${SUMMARY_PREFIX}
We built a contact form (id form-1).`;
    const msgs = [
      msg('user', 'old question'),
      msg('assistant', 'old answer'),
      msg('assistant', summary),
      msg('user', 'new question'),
    ];
    expect(historyFor(msgs)).toEqual([
      { role: 'system', content: summary },
      { role: 'user', content: 'new question' },
    ]);
  });

  it('re-compaction: only the LAST marker wins', () => {
    const first = `${SUMMARY_PREFIX}
first`;
    const second = `${SUMMARY_PREFIX}
second`;
    const msgs = [msg('assistant', first), msg('user', 'a'), msg('assistant', second), msg('user', 'b')];
    expect(historyFor(msgs)).toEqual([
      { role: 'system', content: second },
      { role: 'user', content: 'b' },
    ]);
    expect(sinceLastSummary(msgs).tail).toEqual([msg('user', 'b')]);
  });

  it('a USER message quoting the prefix is not a marker', () => {
    const msgs = [msg('user', `${SUMMARY_PREFIX} what does this mean?`), msg('assistant', 'it marks a summary')];
    expect(sinceLastSummary(msgs).summary).toBeNull();
  });
});

describe('image attachment plumbing', () => {
  const img = 'data:image/jpeg;base64,QUJD';

  it('historyFor turns stored images into OpenAI content parts', () => {
    expect(historyFor([{ role: 'user', content: 'look at this', images: [img] }])).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: img } },
        ],
      },
    ]);
    // Image-only message: no empty text part.
    expect(historyFor([{ role: 'user', content: '', images: [img] }])).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: img } }] },
    ]);
  });

  it('chatTextOf collapses parts to their text', () => {
    expect(chatTextOf('plain')).toBe('plain');
    expect(
      chatTextOf([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: img } },
        { type: 'text', text: 'b' },
      ])
    ).toBe('a\nb');
  });

  it('the codex desktop lane sends content parts VERBATIM (desktop extracts the images)', async () => {
    const tunnelChat = okTunnel();
    const partMessages = [
      { role: 'user', content: 'plain stays' },
      {
        role: 'user',
        content: [
          { type: 'text' as const, text: 'see image' },
          { type: 'image_url' as const, image_url: { url: img } },
        ],
      },
    ];
    const out = await sendChatTurn(
      turn({ messages: partMessages }),
      prefsDeps(prefs({ aiSource: 'desktop', desktopProviderId: 'openai-codex-agent' }), {
        tunnelChat,
        mintToolGrant: okGrant(),
      })
    );
    expect(out.ok).toBe(true);
    expect(tunnelChat.mock.calls[0][0].messages).toEqual(partMessages);
  });
});
