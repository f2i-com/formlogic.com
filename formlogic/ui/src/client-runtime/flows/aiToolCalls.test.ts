// The editor bridge's native tool calls (`aiTools: 1`): the structured request is checked
// field by field (and rebuilt from what was checked), and the neutral shape maps to and
// from OpenAI-compatible /chat/completions without losing a call, an id or an error flag.
import { describe, expect, it } from 'vitest';
import {
  EDITOR_AI_LIMITS,
  fromOpenAiChatCompletion,
  toOpenAiChatMessages,
  toOpenAiTools,
  validateEditorAiToolRequest,
  type EditorAiMessage,
} from './aiToolCalls';

const TOOLS = [
  { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
];

/** A new Studio's agent conversation, three rounds in: calls, results (one failed), more calls. */
const CONVERSATION: EditorAiMessage[] = [
  { role: 'system', content: 'You edit Softn apps.' },
  { role: 'user', content: 'Add a title to the main screen.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_01', name: 'read_file', arguments: { path: 'ui/main.ui' } }, { id: 'toolu_02', name: 'read_file', arguments: { path: 'ui/missing.ui' } }] },
  { role: 'tool', toolCallId: 'toolu_01', name: 'read_file', content: '<Column/>' },
  { role: 'tool', toolCallId: 'toolu_02', name: 'read_file', content: 'No such file.', isError: true },
  { role: 'assistant', content: 'Writing it.', toolCalls: [{ id: 'call_3', name: 'write_file', arguments: { path: 'ui/main.ui', content: '<Column><Text>Title</Text></Column>' } }] },
  { role: 'tool', toolCallId: 'call_3', name: 'write_file', content: 'Wrote 1 file.' },
];

const request = (overrides: Record<string, unknown> = {}) => ({ kind: 'ai-request', id: 'r1', aiTools: 1, messages: CONVERSATION, tools: TOOLS, maxOutputTokens: 16384, ...overrides });

describe('validateEditorAiToolRequest', () => {
  it('takes a scripted Studio conversation and rebuilds it from what it checked', () => {
    const noisy = request({ extra: 'dropped', messages: [...CONVERSATION.slice(0, 2), { ...CONVERSATION[2], extra: true }, ...CONVERSATION.slice(3)] });
    const checked = validateEditorAiToolRequest(noisy);
    expect(checked).toEqual({ ok: true, request: { messages: CONVERSATION, tools: TOOLS, maxOutputTokens: 16384 } });
  });

  it('takes a request without tools or an output cap', () => {
    const checked = validateEditorAiToolRequest({ aiTools: 1, messages: [{ role: 'user', content: 'Hi' }] });
    expect(checked).toEqual({ ok: true, request: { messages: [{ role: 'user', content: 'Hi' }], tools: [] } });
  });

  const user = { role: 'user', content: 'Hi' };
  const call = { id: 'call_1', name: 'read_file', arguments: { path: 'a' } };
  const withCall = { role: 'assistant', content: '', toolCalls: [call] };
  const tool = TOOLS[0];
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['another aiTools version', { aiTools: 2 }, /aiTools must be 1/],
    ['aiTools as a string', { aiTools: '1' }, /aiTools must be 1/],
    ['no messages', { messages: [] }, /messages must hold/],
    ['too many messages', { messages: Array(101).fill(user) }, /messages must hold/],
    ['unknown role', { messages: [{ role: 'developer', content: 'x' }] }, /role must be/],
    ['non-string content', { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, /content must be a string/],
    ['tool calls on a user message', { messages: [{ ...user, toolCalls: [call] }] }, /only assistant/],
    ['tools not a list', { tools: true }, /tools must be a list/],
    ['too many tools', { tools: Array.from({ length: 65 }, (_, i) => ({ ...tool, name: `t${i}` })) }, /at most 64/],
    ['a duplicate tool', { tools: [tool, tool] }, /declared twice/],
    ['a bad tool name', { tools: [{ ...tool, name: 'read file' }] }, /tool name/],
    ['a missing description', { tools: [{ name: 'x', inputSchema: { type: 'object' } }] }, /description/],
    ['a long description', { tools: [{ ...tool, description: 'd'.repeat(4097) }] }, /description/],
    ['a schema that is not an object schema', { tools: [{ ...tool, inputSchema: { type: 'array' } }] }, /type "object"/],
    ['a schema that is a list', { tools: [{ ...tool, inputSchema: [] }] }, /type "object"/],
    ['an oversized schema', { tools: [{ ...tool, inputSchema: { type: 'object', description: 'x'.repeat(EDITOR_AI_LIMITS.maxToolSchemaChars) } }] }, /inputSchema over/],
    ['a bad call id', { messages: [user, { ...withCall, toolCalls: [{ ...call, id: 'call 1"' }] }] }, /tool call id/],
    ['an empty call id', { messages: [user, { ...withCall, toolCalls: [{ ...call, id: '' }] }] }, /tool call id/],
    ['a duplicate call id', { messages: [user, { ...withCall, toolCalls: [call, call] }] }, /used twice/],
    ['string arguments', { messages: [user, { ...withCall, toolCalls: [{ ...call, arguments: '{"path":"a"}' }] }] }, /arguments must be an object/],
    ['list arguments', { messages: [user, { ...withCall, toolCalls: [{ ...call, arguments: ['a'] }] }] }, /arguments must be an object/],
    ['oversized arguments', { messages: [user, { ...withCall, toolCalls: [{ ...call, arguments: { v: 'x'.repeat(EDITOR_AI_LIMITS.maxArgumentsChars) } }] }] }, /arguments exceed/],
    ['too many calls', { messages: [user, { ...withCall, toolCalls: Array.from({ length: 33 }, (_, i) => ({ ...call, id: `c${i}` })) }] }, /at most 32/],
    ['a result with no call before it', { messages: [user, { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'x' }] }, /does not answer/],
    ['a result naming another tool', { messages: [user, withCall, { role: 'tool', toolCallId: 'call_1', name: 'write_file', content: 'x' }] }, /does not answer/],
    ['a call answered twice', { messages: [user, withCall, { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'x' }, { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'y' }] }, /does not answer/],
    ['a result after a user turn', { messages: [user, withCall, user, { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'x' }] }, /does not answer/],
    ['a non-boolean isError', { messages: [user, withCall, { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'x', isError: 'yes' }] }, /isError/],
    ['a zero output cap', { maxOutputTokens: 0 }, /maxOutputTokens/],
    ['a fractional output cap', { maxOutputTokens: 1.5 }, /maxOutputTokens/],
    ['a request over the size bound', { messages: [user, withCall, { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'x'.repeat(EDITOR_AI_LIMITS.maxRequestChars) }] }, /exceeds/],
  ];
  it.each(cases)('refuses %s', (_name, overrides, error) => {
    const checked = validateEditorAiToolRequest(request(overrides));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toMatch(error);
  });
});

describe('OpenAI-compatible mapping', () => {
  it('maps the conversation: assistant tool_calls with JSON arguments, role:tool results, failures marked', () => {
    expect(toOpenAiChatMessages(CONVERSATION)).toEqual([
      { role: 'system', content: 'You edit Softn apps.' },
      { role: 'user', content: 'Add a title to the main screen.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_01', type: 'function', function: { name: 'read_file', arguments: '{"path":"ui/main.ui"}' } },
          { id: 'toolu_02', type: 'function', function: { name: 'read_file', arguments: '{"path":"ui/missing.ui"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_01', content: '<Column/>' },
      { role: 'tool', tool_call_id: 'toolu_02', content: 'Error: No such file.' },
      { role: 'assistant', content: 'Writing it.', tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'write_file', arguments: '{"path":"ui/main.ui","content":"<Column><Text>Title</Text></Column>"}' } }] },
      { role: 'tool', tool_call_id: 'call_3', content: 'Wrote 1 file.' },
    ]);
    expect(toOpenAiTools(TOOLS)[0]).toEqual({ type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: TOOLS[0].inputSchema } });
  });

  it('reads a reply: text, calls (parsed or raw), the provider stop reason, usage', () => {
    const reply = fromOpenAiChatCompletion({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } },
            { id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '{"path":' } },
            { id: 'has spaces', type: 'function', function: { name: 'read_file', arguments: '' } },
            { id: 'call_d', type: 'function', function: { arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 900, completion_tokens: 40 },
    });
    expect(reply).toEqual({
      text: '',
      toolCalls: [
        { id: 'call_a', name: 'read_file', arguments: { path: 'x' } },
        { id: 'call_b', name: 'write_file', arguments: '{"path":' },
        { id: 'formlogic_call_2', name: 'read_file', arguments: {} },
      ],
      stopReason: 'tool_calls',
      usage: { inputTokens: 900, outputTokens: 40 },
    });
  });

  it('reads a final text reply without usage, and refuses a body with no message', () => {
    expect(fromOpenAiChatCompletion({ choices: [{ message: { content: 'Done.' }, finish_reason: 'length' }] })).toEqual({ text: 'Done.', toolCalls: [], stopReason: 'length' });
    expect(fromOpenAiChatCompletion({ choices: [] })).toBeNull();
    expect(fromOpenAiChatCompletion('nope')).toBeNull();
  });
});
