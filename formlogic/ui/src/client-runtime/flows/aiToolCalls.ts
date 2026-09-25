// Native AI tool calls for the hosted Softn Studio editor (the editor bridge's optional
// `aiTools` capability, version 1 — Softn's docs/engineering/FORMLOGIC_INTEGRATION.md).
//
// Studio drives its own agent loop and executes its own tools; FormLogic only carries
// one model round per `ai-request`. This module owns the provider-neutral shapes on the
// FormLogic side:
//   - validateEditorAiToolRequest: the bridge's structured request, checked field by
//     field and rebuilt from what was checked (nothing unvalidated is passed on);
//   - toOpenAiChatMessages / toOpenAiTools / fromOpenAiChatCompletion: the mapping to and
//     from OpenAI-compatible /chat/completions, the one wire every tool-capable source
//     FormLogic has speaks (Site AI's upstream and the browser's own AI services).
// Model names never appear here: a request carries whatever model the source's own
// configuration names.

/** The `aiTools` version FormLogic speaks on the editor bridge. */
export const EDITOR_AI_TOOLS_VERSION = 1;

/** Bounds for a structured request. Mirrored (tighter where the backend's own chat bounds are) in AIService. */
export const EDITOR_AI_LIMITS = {
  /** Same as the text path's message count. */
  maxMessages: 100,
  /** Messages AND tools together, as JSON — the text path's 1,000,000 now covers the tool list too. */
  maxRequestChars: 1_000_000,
  maxTools: 64,
  maxToolDescriptionChars: 4096,
  maxToolSchemaChars: 16_384,
  maxToolCallsPerMessage: 32,
  maxArgumentsChars: 262_144,
  maxOutputTokens: 1_000_000,
} as const;

/** Tool names: OpenAI's own function-name rule (Anthropic's is the same set). */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Tool call ids as providers mint them (call_…, toolu_…) — no whitespace, quotes or markup. */
export const TOOL_CALL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface EditorAiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface EditorAiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type EditorAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: EditorAiToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface EditorAiToolRequest {
  messages: EditorAiMessage[];
  tools: EditorAiTool[];
  maxOutputTokens?: number;
}

/** The structured `ai-response` value. `arguments` is the parsed object, or the provider's raw string when it did not parse. */
export interface EditorAiReply {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> | string }>;
  stopReason: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

export type EditorAiToolValidation = { ok: true; request: EditorAiToolRequest } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? Infinity;
  } catch {
    return Infinity; // cycles, BigInt: not JSON, so not a request this bridge takes
  }
}

/**
 * Check a structured `ai-request` (one carrying `aiTools`). Everything returned was
 * checked; unknown keys are dropped rather than forwarded. The rules:
 *  - `aiTools` is exactly the version FormLogic announced;
 *  - 1..100 messages; roles system/user/assistant/tool; every `content` a string;
 *  - assistant `toolCalls`: ≤ 32 per message, id/name formats, `arguments` a plain
 *    object ≤ 256 KiB as JSON, ids unique in the message;
 *  - a `tool` message answers a call of the assistant message it follows (directly, or
 *    after that message's other results), by id AND name, once;
 *  - `tools`: ≤ 64, unique names, description ≤ 4 KiB, `inputSchema` a JSON-schema
 *    object (`type: "object"`) ≤ 16 KiB;
 *  - `maxOutputTokens`: a positive integer;
 *  - messages + tools ≤ 1,000,000 characters of JSON.
 */
export function validateEditorAiToolRequest(data: unknown): EditorAiToolValidation {
  const fail = (error: string): EditorAiToolValidation => ({ ok: false, error: `Invalid AI request: ${error}.` });
  if (!isPlainObject(data)) return fail('not an object');
  if (data.aiTools !== EDITOR_AI_TOOLS_VERSION) return fail(`aiTools must be ${EDITOR_AI_TOOLS_VERSION}`);

  const L = EDITOR_AI_LIMITS;
  let maxOutputTokens: number | undefined;
  if (data.maxOutputTokens !== undefined) {
    const m = data.maxOutputTokens;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > L.maxOutputTokens) return fail('maxOutputTokens must be a positive integer');
    maxOutputTokens = m;
  }

  const tools: EditorAiTool[] = [];
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || data.tools.length > L.maxTools) return fail(`tools must be a list of at most ${L.maxTools}`);
    const names = new Set<string>();
    for (const raw of data.tools) {
      if (!isPlainObject(raw)) return fail('each tool must be an object');
      const { name, description, inputSchema } = raw;
      if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) return fail('a tool name must be 1-64 letters, digits, _ or -');
      if (names.has(name)) return fail(`tool ${name} is declared twice`);
      names.add(name);
      if (typeof description !== 'string' || description.length > L.maxToolDescriptionChars) return fail(`tool ${name} needs a description of at most ${L.maxToolDescriptionChars} characters`);
      if (!isPlainObject(inputSchema) || inputSchema.type !== 'object') return fail(`tool ${name} needs an inputSchema of type "object"`);
      if (jsonLength(inputSchema) > L.maxToolSchemaChars) return fail(`tool ${name} has an inputSchema over ${L.maxToolSchemaChars} characters`);
      tools.push({ name, description, inputSchema });
    }
  }

  if (!Array.isArray(data.messages) || data.messages.length === 0 || data.messages.length > L.maxMessages) {
    return fail(`messages must hold 1-${L.maxMessages} items`);
  }
  const messages: EditorAiMessage[] = [];
  // The calls the latest assistant message made that no tool message has answered yet;
  // null once anything other than a tool result follows it.
  let open: Map<string, string> | null = null;
  for (const raw of data.messages) {
    if (!isPlainObject(raw)) return fail('each message must be an object');
    const { role, content } = raw;
    if (typeof content !== 'string') return fail('message content must be a string');
    if (role === 'system' || role === 'user') {
      if (raw.toolCalls !== undefined) return fail('only assistant messages carry toolCalls');
      messages.push({ role, content });
      open = null;
    } else if (role === 'assistant') {
      let toolCalls: EditorAiToolCall[] | undefined;
      open = null;
      if (raw.toolCalls !== undefined) {
        if (!Array.isArray(raw.toolCalls) || raw.toolCalls.length > L.maxToolCallsPerMessage) {
          return fail(`toolCalls must be a list of at most ${L.maxToolCallsPerMessage}`);
        }
        if (raw.toolCalls.length > 0) {
          toolCalls = [];
          open = new Map();
          for (const call of raw.toolCalls) {
            if (!isPlainObject(call)) return fail('each tool call must be an object');
            const { id, name } = call;
            if (typeof id !== 'string' || !TOOL_CALL_ID_RE.test(id)) return fail('a tool call id must be 1-128 letters, digits or _.:-');
            if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) return fail('a tool call name must be 1-64 letters, digits, _ or -');
            if (open.has(id)) return fail(`tool call id ${id} is used twice in one message`);
            if (!isPlainObject(call.arguments)) return fail(`tool call ${id} arguments must be an object`);
            if (jsonLength(call.arguments) > L.maxArgumentsChars) return fail(`tool call ${id} arguments exceed ${L.maxArgumentsChars} characters`);
            toolCalls.push({ id, name, arguments: call.arguments });
            open.set(id, name);
          }
        }
      }
      messages.push(toolCalls ? { role, content, toolCalls } : { role, content });
    } else if (role === 'tool') {
      const { toolCallId, name, isError } = raw;
      if (typeof toolCallId !== 'string' || !TOOL_CALL_ID_RE.test(toolCallId)) return fail('a tool result needs a valid toolCallId');
      if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) return fail('a tool result needs a valid name');
      if (isError !== undefined && typeof isError !== 'boolean') return fail('isError must be a boolean');
      if (!open || open.get(toolCallId) !== name) return fail(`tool result ${toolCallId} does not answer an open call of the assistant message before it`);
      open.delete(toolCallId);
      messages.push(isError ? { role, toolCallId, name, content, isError: true } : { role, toolCallId, name, content });
    } else {
      return fail('message role must be system, user, assistant or tool');
    }
  }

  if (jsonLength(messages) + jsonLength(tools) > L.maxRequestChars) return fail(`the request exceeds ${L.maxRequestChars} characters`);
  return { ok: true, request: { messages, tools, ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) } };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible /chat/completions mapping.
// ---------------------------------------------------------------------------

export type OpenAiChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Neutral messages → OpenAI chat messages (a failed tool's result is prefixed `Error: `, as Studio's own OpenAI encoder does). */
export function toOpenAiChatMessages(messages: EditorAiMessage[]): OpenAiChatMessage[] {
  return messages.map((m): OpenAiChatMessage => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.isError ? `Error: ${m.content}` : m.content };
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content !== '' ? m.content : null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAiTools(tools: EditorAiTool[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * A provider's tool call → the bridge's. Arguments that parse to an object go as the
 * object; anything else goes as the raw string so Studio can tell the model its JSON was
 * bad. An id no later request could carry back (missing, or outside TOOL_CALL_ID_RE) is
 * replaced by a stable one, so the conversation can continue.
 */
export function editorToolCall(index: number, id: unknown, name: string, rawArguments: unknown): EditorAiReply['toolCalls'][number] {
  let args: Record<string, unknown> | string;
  if (isPlainObject(rawArguments)) args = rawArguments;
  else if (typeof rawArguments === 'string') {
    try {
      const parsed: unknown = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
      args = isPlainObject(parsed) ? parsed : rawArguments;
    } catch {
      args = rawArguments;
    }
  } else args = {};
  return { id: typeof id === 'string' && TOOL_CALL_ID_RE.test(id) ? id : `formlogic_call_${index}`, name, arguments: args };
}

/** OpenAI usage → the bridge's counts; undefined when the provider reported none. */
export function editorUsage(inputTokens: unknown, outputTokens: unknown): EditorAiReply['usage'] {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens: count(inputTokens), outputTokens: count(outputTokens) };
}

/** An OpenAI chat completion → the bridge's reply; null when it has no message to read. */
export function fromOpenAiChatCompletion(payload: unknown): EditorAiReply | null {
  if (!isPlainObject(payload) || !Array.isArray(payload.choices)) return null;
  const choice = payload.choices[0];
  if (!isPlainObject(choice) || !isPlainObject(choice.message)) return null;
  const message = choice.message;
  const toolCalls: EditorAiReply['toolCalls'] = [];
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((raw, index) => {
      if (!isPlainObject(raw) || !isPlainObject(raw.function)) return;
      const name = raw.function.name;
      if (typeof name !== 'string' || name === '') return;
      toolCalls.push(editorToolCall(index, raw.id, name, raw.function.arguments));
    });
  }
  const usage = isPlainObject(payload.usage) ? editorUsage(payload.usage.prompt_tokens, payload.usage.completion_tokens) : undefined;
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    stopReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    ...(usage ? { usage } : {}),
  };
}
