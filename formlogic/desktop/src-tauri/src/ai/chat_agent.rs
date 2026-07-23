//! Phase 6 — the E2E chat tool loop (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md
//! §5.4): model → tool_call → execute → feed back, bounded at
//! [`MAX_TOOL_ROUNDS`] provider rounds.
//!
//! Entered from `relay_poller::run_chat` whenever the sealed body carries a
//! non-empty `toolGrant` and the chat-tools catalog is non-empty. Two tool
//! TRANSPORTS cover every provider kind:
//!
//! - **Native** — registry providers speaking the OpenAI chat dialect
//!   end-to-end ([`provider_supports_tools`]): the catalog rides the request
//!   as OpenAI function-calling `tools`, and `tool_calls` come back
//!   structurally.
//! - **Prompted** — everything else that can chat (the managed Codex lane,
//!   whose request is prompt-only and rejects `tools` by design;
//!   Anthropic-translated and Custom-mapped registry providers, whose
//!   request/response mapping would drop tool schemas): a harness preamble
//!   teaches the model the catalog plus a strict reply convention — to call a
//!   tool the reply must be a SINGLE fenced block
//!   ` ```tool_call\n{"tool":"<name>","input":{…}}\n``` ` and NOTHING else.
//!   The parse rule is well-formed-or-text: only a parseable fenced block
//!   naming a cataloged tool counts as a call; anything else (malformed JSON,
//!   unknown tool, prose around the fence) is the final text answer — never
//!   guessed, never fabricated. Tool results return as plain-text
//!   `tool_result <name>: {…}` messages.
//!
//! Both transports share every other behavior — the sealed activity/proposal
//! frame shapes are IDENTICAL (the browser cannot tell which transport
//! produced a call), confirm-mode pause/approve/deny, denial strings, result
//! bounding, the catalog cache, and the round bound with guaranteed
//! termination: the final allowed round (and every round after a terminal
//! grant failure) attaches no tools — Native omits the `tools` array,
//! Prompted swaps the preamble for a plain-text-answer instruction and stops
//! parsing for fences.
//!
//! Degradations stay honest and narrow: an empty/unfetchable catalog falls
//! back to the plain chat path in `run_chat` (the model simply has no tools),
//! and a grant-less request never reaches this module at all (byte-identical
//! legacy path).
//!
//! Sealed OUT frames (pinned wire contract; the browser normalizes them in
//! `ui/src/components/chat/chatEngine.ts`):
//! - `{"type":"tool_call","id":…,"name":…,"status":"running"}` before execute;
//! - `{"type":"tool_result","id":…,"name":…,"status":"done","result":…}` or
//!   `{…,"status":"failed","error":…}` after;
//! - confirm mode first proposes:
//!   `{"type":"tool_proposal","callId":…,"requestId":…,"tool":…,"input":…}`
//!   then polls the sealed IN channel (`fetch_ai_input`) for
//!   `{"v":1,"type":"tool_approval","callId":…,"approved":bool}` — 120 s
//!   without an answer auto-denies. A denial is a failed tool result plus an
//!   honest refusal fed back to the model, never a failed request.
//!
//! The final text reply is sealed as the same buffered
//! `{"v":1,"kind":"final","completion":…}` body the non-tool path emits
//! (`relay_poller::final_body`) — tool turns are non-streaming by design (the
//! loop must inspect the reply before anything is user-visible).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ai::codex::CodexChatRequest;
use crate::ai::gateway;
use crate::ai::providers::{Protocol, ProviderProfile};
use crate::ai::relay_poller::{
    final_body, gateway_tunnel_error, AiTunnel, ResolvedProvider, TunnelError,
};
use crate::formlogic_client::{ChatToolExecError, FlError, FormLogicClient};

/// Plan §5.4: the tool loop is bounded at 6 provider rounds.
pub const MAX_TOOL_ROUNDS: usize = 6;
/// Plan §5.4/§5.5 pattern: the chat-tools catalog is cached for 5 minutes.
const CATALOG_CACHE_TTL: Duration = Duration::from_secs(300);
/// Bound on tool calls honoured within ONE assistant reply (Native can batch;
/// Prompted is one-per-reply by convention); extras get an honest refusal
/// result (every tool_call still receives its `role:"tool"` reply, per the
/// OpenAI convention).
const MAX_TOOL_CALLS_PER_ROUND: usize = 8;
/// A tool result larger than this is replaced by a truncation note in the
/// sealed frame (the envelope plaintext cap is 256 KiB; leave headroom).
const MAX_RESULT_FRAME_BYTES: usize = 192 * 1024;
/// Bound on the serialized tool result fed back to the model per call.
const MAX_RESULT_MODEL_BYTES: usize = 32 * 1024;

/// Grant refusal codes that are TERMINAL for tool use in this request — the
/// backend will refuse every subsequent execute identically, so retrying or
/// looping on them would be dishonest noise.
const TERMINAL_GRANT_CODES: [&str; 3] = ["grant_expired", "grant_invalid", "grant_instance_mismatch"];

/// The fence opener of the Prompted convention (the closing fence is bare
/// ` ``` `). Pinned — the preamble teaches exactly this and the parser accepts
/// exactly this.
const PROMPTED_FENCE: &str = "```tool_call";

/// The system-level instruction used when tools are (no longer) available on
/// a Prompted round: the final allowed round and every round after a terminal
/// grant failure.
const PROMPTED_PLAIN_ANSWER: &str = "Tool calling is not available for this reply. Answer the \
user in plain text using the information you already have; do not emit a tool_call block.";

/// Confirm-mode approval timing. A struct (not consts) so tests inject a
/// short deadline instead of sleeping 120 real seconds.
#[derive(Debug, Clone)]
pub struct ConfirmTiming {
    /// How long a sealed `tool_proposal` waits for its `tool_approval` before
    /// auto-denying (plan §5.4: 120 s).
    pub deadline: Duration,
    /// Cadence of `fetch_ai_input` polls while paused (~1–2 s).
    pub poll_interval: Duration,
}

impl Default for ConfirmTiming {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(120),
            poll_interval: Duration::from_millis(1500),
        }
    }
}

/// Can this registry provider carry OpenAI function-calling tools NATIVELY,
/// both ways? Only the OpenAI dialect qualifies: the canonical body passes
/// through unmodified and the response comes back untranslated, so `tools`
/// survives the request and `tool_calls` survives the reply. Everything else
/// takes the Prompted transport instead.
pub(crate) fn provider_supports_tools(provider: &ProviderProfile) -> bool {
    provider.protocol == Protocol::OpenAi
}

/// Outcome of one confirm-mode approval wait.
enum Approval {
    Approved,
    /// The honest reason string sealed into the failed `tool_result` frame
    /// and fed back to the model.
    Denied(&'static str),
}

/// Outcome of one tool call, after its activity frames were sealed. Shared by
/// both transports; only the conversation feedback SHAPE differs per
/// transport.
enum ExecOutcome {
    /// Executed: `bounded` is the size-capped serialized result for the model.
    Done { bounded: String },
    /// Refused/failed (denial, dead grant, typed refusal, transport error).
    /// `terminal` marks a grant refusal that ends tool availability for the
    /// whole request.
    Failed { error: String, terminal: bool },
}

/// One Prompted provider round: the assistant's raw text plus the completion
/// to seal if this reply turns out to be final.
struct PromptedRound {
    text: String,
    completion: Value,
}

impl AiTunnel {
    /// The Phase-6 tool loop for ONE claimed chat request. `tools` is the
    /// non-empty catalog already fetched by the caller (`run_chat` falls back
    /// to the plain path when it is empty). Returns the FINAL plaintext body
    /// to seal, exactly like `run_chat`'s other arms.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_chat_with_tools(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        eph_pub: &str,
        resolved: &ResolvedProvider,
        messages: &[Value],
        body: &Value,
        model: Option<&str>,
        grant: &str,
        tools: Arc<Vec<Value>>,
    ) -> Result<Vec<u8>, TunnelError> {
        let confirm = body.get("toolMode").and_then(Value::as_str) == Some("confirm");
        match resolved {
            ResolvedProvider::Registry(provider) if provider_supports_tools(provider) => {
                self.run_native_tool_loop(
                    client, instance_id, id, eph_pub, provider, messages, confirm, model, grant,
                    tools,
                )
                .await
            }
            _ => {
                self.run_prompted_tool_loop(
                    client, instance_id, id, eph_pub, resolved, messages, body, confirm, model,
                    grant, tools,
                )
                .await
            }
        }
    }

    /// The Native transport: OpenAI function-calling `tools` on the request,
    /// structural `tool_calls` on the reply, `role:"tool"` feedback.
    #[allow(clippy::too_many_arguments)]
    async fn run_native_tool_loop(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        eph_pub: &str,
        provider: &ProviderProfile,
        messages: &[Value],
        confirm: bool,
        model: Option<&str>,
        grant: &str,
        tools: Arc<Vec<Value>>,
    ) -> Result<Vec<u8>, TunnelError> {
        let mut grant_dead = false;
        let mut convo: Vec<Value> = messages.to_vec();
        // The sealed IN channel cursor persists across rounds — approval-frame
        // seqs (and their e2e counters) are monotonic per request.
        let mut input_cursor: u64 = 0;

        for round in 1..=MAX_TOOL_ROUNDS {
            let attach = !grant_dead && round < MAX_TOOL_ROUNDS;
            let mut chat_body = json!({ "messages": convo });
            if let Some(m) = model {
                chat_body["model"] = json!(m);
            }
            if attach {
                chat_body["tools"] = Value::Array(tools.as_ref().clone());
            }
            let completion = gateway::chat_completions(&self.providers, provider, chat_body)
                .await
                .map_err(gateway_tunnel_error)?;
            let message = completion
                .pointer("/choices/0/message")
                .cloned()
                .unwrap_or(Value::Null);
            let tool_calls: Vec<Value> = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            // A text-only reply ends the loop. So does any reply on a round
            // that attached no tools (the final round / dead grant): with
            // nothing attached there is nothing to execute, and treating the
            // reply as final keeps the ≤ MAX_TOOL_ROUNDS bound.
            if tool_calls.is_empty() || !attach {
                return Ok(final_body(completion));
            }

            // The assistant turn that requested the calls precedes its tool
            // replies in the conversation (OpenAI convention).
            convo.push(message);
            for (index, call) in tool_calls.iter().enumerate() {
                let call_id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call-{round}-{index}"));
                let name = call
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if name.is_empty() {
                    let error = "malformed tool call: missing function name";
                    self.post_tool_failure(client, instance_id, id, &call_id, &name, error)
                        .await?;
                    convo.push(tool_reply(&call_id, json!({ "executed": false, "error": error })));
                    continue;
                }
                if index >= MAX_TOOL_CALLS_PER_ROUND {
                    let error = "tool call skipped: too many tool calls in one round";
                    self.post_tool_failure(client, instance_id, id, &call_id, &name, error)
                        .await?;
                    convo.push(tool_reply(&call_id, json!({ "executed": false, "error": error })));
                    continue;
                }
                let args = match call.pointer("/function/arguments") {
                    Some(Value::String(raw)) => match serde_json::from_str::<Value>(raw) {
                        Ok(v) => v,
                        Err(_) => {
                            let error = "tool arguments were not valid JSON";
                            self.post_tool_failure(client, instance_id, id, &call_id, &name, error)
                                .await?;
                            convo.push(tool_reply(
                                &call_id,
                                json!({ "executed": false, "error": error }),
                            ));
                            continue;
                        }
                    },
                    Some(v @ Value::Object(_)) => v.clone(),
                    _ => json!({}),
                };

                let outcome = self
                    .run_one_tool_call(
                        client,
                        instance_id,
                        id,
                        eph_pub,
                        &call_id,
                        &name,
                        &args,
                        confirm,
                        grant,
                        &mut grant_dead,
                        &mut input_cursor,
                    )
                    .await?;
                convo.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": native_feedback(&outcome),
                }));
            }
        }
        // Unreachable: the final round never attaches tools, so it always
        // returns above. Kept as a typed failure rather than a panic.
        Err(TunnelError::new(
            "upstream_error",
            "tool loop exceeded its round bound without a final reply",
        ))
    }

    /// The Prompted transport: the harness preamble teaches the catalog + the
    /// fenced-block convention; replies are parsed well-formed-or-text; tool
    /// results return as plain-text `tool_result …` user messages. One tool
    /// call per reply by convention. Codex rides its own thread continuation
    /// (round 1 renders the whole conversation; later rounds send only the
    /// new feedback into the same thread).
    #[allow(clippy::too_many_arguments)]
    async fn run_prompted_tool_loop(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        eph_pub: &str,
        resolved: &ResolvedProvider,
        messages: &[Value],
        body: &Value,
        confirm: bool,
        model: Option<&str>,
        grant: &str,
        tools: Arc<Vec<Value>>,
    ) -> Result<Vec<u8>, TunnelError> {
        let mut grant_dead = false;
        let mut convo: Vec<Value> = messages.to_vec();
        let mut input_cursor: u64 = 0;
        // Codex thread continuation: the FIRST round always STARTS FRESH —
        // the browser's threadId is its own key, never a codex rollout id,
        // and the harness must teach its preamble anyway, so the full
        // conversation is rendered into the prompt. Later rounds send only
        // what is new (`pending`) into the thread the first response opened;
        // the browser-thread mapping is recorded for future plain-chat turns.
        let browser_thread: Option<String> = body
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string);
        // Per-turn Codex reasoning effort from the sealed body (browser chat
        // selector / Settings default); codex validates the value itself.
        let reasoning: Option<String> = body
            .get("reasoning")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut codex_thread: Option<String> = None;
        let mut codex_started = false;
        let mut codex_pending: Vec<String> = Vec::new();
        let mut call_seq = 0usize;

        for round in 1..=MAX_TOOL_ROUNDS {
            let attach = !grant_dead && round < MAX_TOOL_ROUNDS;
            let reply = match resolved {
                ResolvedProvider::Registry(provider) => {
                    let mut msgs: Vec<Value> = Vec::with_capacity(convo.len() + 1);
                    msgs.push(json!({
                        "role": "system",
                        "content": if attach {
                            prompted_preamble(&tools)
                        } else {
                            PROMPTED_PLAIN_ANSWER.to_string()
                        },
                    }));
                    msgs.extend(convo.iter().cloned());
                    let mut chat_body = json!({ "messages": msgs });
                    if let Some(m) = model {
                        chat_body["model"] = json!(m);
                    }
                    let completion =
                        gateway::chat_completions(&self.providers, provider, chat_body)
                            .await
                            .map_err(gateway_tunnel_error)?;
                    let text = completion
                        .pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    PromptedRound { text, completion }
                }
                ResolvedProvider::CodexAsync => {
                    // Image attachments ride the round that renders the
                    // conversation (first, or a dead-rollout re-render) as
                    // app-server `image` input items; tool-feedback followup
                    // rounds continue a thread that already saw them.
                    let (prompt, thread, images) = if codex_started {
                        (
                            codex_followup_prompt(&codex_pending, attach),
                            codex_thread.clone(),
                            Vec::new(),
                        )
                    } else {
                        (
                            codex_first_prompt(attach, &tools, &convo),
                            None,
                            collect_user_image_urls(&convo, false),
                        )
                    };
                    codex_started = true;
                    codex_pending.clear();
                    let request = CodexChatRequest {
                        prompt,
                        thread_id: thread.clone(),
                        model: model.map(str::to_string),
                        reasoning_effort: reasoning.clone(),
                        service_tier: None,
                        images,
                    };
                    let response = match self.codex_chat_with_busy_backoff(request).await {
                        Ok(response) => response,
                        Err(e)
                            if thread.is_some()
                                && crate::ai::relay_poller::is_dead_codex_thread_message(
                                    e.message(),
                                ) =>
                        {
                            // The mid-request rollout died (codex restarted):
                            // fall back AUTOMATICALLY to a fresh thread with
                            // the preamble + conversation + prior tool_result
                            // feedback re-rendered — the user gets an answer,
                            // never a "no rollout found" error.
                            self.codex_chat_with_busy_backoff(CodexChatRequest {
                                prompt: codex_first_prompt(attach, &tools, &convo),
                                thread_id: None,
                                model: model.map(str::to_string),
                                reasoning_effort: reasoning.clone(),
                                service_tier: None,
                                images: collect_user_image_urls(&convo, false),
                            })
                            .await?
                        }
                        Err(e) => return Err(e),
                    };
                    codex_thread = Some(response.thread_id.clone());
                    if let Some(bt) = browser_thread.as_deref() {
                        self.remember_codex_thread(bt, &response.thread_id);
                    }
                    // The same OpenAI-shaped projection the legacy Codex arm
                    // emits, so the sealed final is indistinguishable.
                    let completion = json!({
                        "id": format!("chatcmpl-formlogic-codex-{}", response.turn_id),
                        "object": "chat.completion",
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "message": { "role": "assistant", "content": response.text },
                            "finish_reason": "stop"
                        }]
                    });
                    PromptedRound {
                        text: response.text,
                        completion,
                    }
                }
            };

            // Well-formed-or-text: only a parseable single fenced block naming
            // a cataloged tool counts as a call — and only while tools are
            // offered at all. Anything else is the final answer.
            let parsed = if attach {
                parse_prompted_tool_call(&reply.text, &tools)
            } else {
                None
            };
            let Some((name, args)) = parsed else {
                return Ok(final_body(reply.completion));
            };
            call_seq += 1;
            let call_id = format!("call-{call_seq}");
            convo.push(json!({ "role": "assistant", "content": reply.text }));
            let outcome = self
                .run_one_tool_call(
                    client,
                    instance_id,
                    id,
                    eph_pub,
                    &call_id,
                    &name,
                    &args,
                    confirm,
                    grant,
                    &mut grant_dead,
                    &mut input_cursor,
                )
                .await?;
            let feedback = prompted_feedback(&name, &outcome);
            convo.push(json!({ "role": "user", "content": feedback }));
            codex_pending.push(feedback);
        }
        Err(TunnelError::new(
            "upstream_error",
            "tool loop exceeded its round bound without a final reply",
        ))
    }

    /// The transport-shared core for ONE tool call: the confirm-mode gate
    /// (proposal frame + approval wait), the running frame, the backend
    /// execute, grant-death latching, result bounding, and the done/failed
    /// result frame — so the sealed frames are IDENTICAL whichever transport
    /// asked. The caller only shapes the conversation feedback.
    #[allow(clippy::too_many_arguments)]
    async fn run_one_tool_call(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        eph_pub: &str,
        call_id: &str,
        name: &str,
        args: &Value,
        confirm: bool,
        grant: &str,
        grant_dead: &mut bool,
        input_cursor: &mut u64,
    ) -> Result<ExecOutcome, TunnelError> {
        if confirm {
            self.seal_and_post_frame(
                client,
                instance_id,
                id,
                &json!({
                    "type": "tool_proposal",
                    "callId": call_id,
                    "requestId": id,
                    "tool": name,
                    "input": args,
                }),
            )
            .await?;
            if let Approval::Denied(reason) = self
                .await_tool_approval(client, instance_id, id, eph_pub, call_id, input_cursor)
                .await
            {
                self.post_tool_failure(client, instance_id, id, call_id, name, reason)
                    .await?;
                return Ok(ExecOutcome::Failed {
                    error: reason.to_string(),
                    terminal: false,
                });
            }
        }

        self.seal_and_post_frame(
            client,
            instance_id,
            id,
            &json!({
                "type": "tool_call",
                "id": call_id,
                "name": name,
                "status": "running",
            }),
        )
        .await?;
        if *grant_dead {
            // A terminal grant refusal already happened this request —
            // executing again can only repeat it.
            let error = "tool grant is no longer valid";
            self.post_tool_failure(client, instance_id, id, call_id, name, error)
                .await?;
            return Ok(ExecOutcome::Failed {
                error: error.to_string(),
                terminal: false,
            });
        }
        match client.chat_tools_execute(grant, name, args).await {
            Ok(value) => {
                // Execute success wraps the result as {data: …}; tolerate a
                // bare body.
                let result = value.get("data").cloned().unwrap_or(value);
                let (frame_result, model_feed) = bound_result(result);
                self.seal_and_post_frame(
                    client,
                    instance_id,
                    id,
                    &json!({
                        "type": "tool_result",
                        "id": call_id,
                        "name": name,
                        "status": "done",
                        "result": frame_result,
                    }),
                )
                .await?;
                Ok(ExecOutcome::Done { bounded: model_feed })
            }
            Err(ChatToolExecError::Typed { code, message })
                if TERMINAL_GRANT_CODES.contains(&code.as_str()) =>
            {
                *grant_dead = true;
                let error = format!("{code}: {message}");
                self.post_tool_failure(client, instance_id, id, call_id, name, &error)
                    .await?;
                Ok(ExecOutcome::Failed {
                    error,
                    terminal: true,
                })
            }
            Err(e) => {
                // Recoverable (unknown_tool, validation, transport…): the
                // model sees the honest error and may retry or answer without.
                let error = e.to_string();
                self.post_tool_failure(client, instance_id, id, call_id, name, &error)
                    .await?;
                Ok(ExecOutcome::Failed {
                    error,
                    terminal: false,
                })
            }
        }
    }

    /// The chat-tools catalog in OpenAI function-calling format, cached ~5 min
    /// in the tunnel state. A fetch failure is NOT cached and yields an empty
    /// list — this turn honestly runs without tools and the next request
    /// retries.
    pub(super) async fn chat_tools_openai(&self, client: &FormLogicClient) -> Arc<Vec<Value>> {
        {
            let cache = self.tools_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((at, tools)) = cache.as_ref() {
                if at.elapsed() < CATALOG_CACHE_TTL {
                    return tools.clone();
                }
            }
        }
        let raw = match client.chat_tools_catalog().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[ai-tunnel] chat-tools catalog fetch failed ({e}) — this turn runs without tools"
                );
                return Arc::new(Vec::new());
            }
        };
        let tools = Arc::new(catalog_to_openai_tools(&raw));
        let mut cache = self.tools_cache.lock().unwrap_or_else(|e| e.into_inner());
        *cache = Some((Instant::now(), tools.clone()));
        tools
    }

    /// Seal one tool-activity frame and post it. A POST failure is logged and
    /// tolerated (the browser detects gaps from the server-assigned seq, same
    /// as delta frames); a SEAL failure is fatal for the request.
    async fn seal_and_post_frame(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        frame: &Value,
    ) -> Result<(), TunnelError> {
        let envelope = self
            .sessions
            .seal_outbound(id, frame.to_string().as_bytes())
            .map_err(|e| TunnelError::new(e.code(), e.message()))?;
        if let Err(e) = client.append_ai_frame(id, instance_id, &envelope).await {
            eprintln!("[ai-tunnel] request {id} tool frame post failed: {e}");
        }
        Ok(())
    }

    /// Seal the pinned failed `tool_result` frame for one call.
    async fn post_tool_failure(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        call_id: &str,
        name: &str,
        error: &str,
    ) -> Result<(), TunnelError> {
        self.seal_and_post_frame(
            client,
            instance_id,
            id,
            &json!({
                "type": "tool_result",
                "id": call_id,
                "name": name,
                "status": "failed",
                "error": error,
            }),
        )
        .await
    }

    /// Poll the sealed IN channel until a `tool_approval` matching `call_id`
    /// arrives, the deadline passes (auto-deny), or the channel closes.
    /// Frames that fail to open are skipped (their seq is still consumed so
    /// the poll never wedges on one bad frame); stale approvals for other
    /// calls are ignored.
    async fn await_tool_approval(
        &self,
        client: &FormLogicClient,
        instance_id: &str,
        id: &str,
        eph_pub: &str,
        call_id: &str,
        cursor: &mut u64,
    ) -> Approval {
        let deadline = Instant::now() + self.confirm_timing.deadline;
        loop {
            match client.fetch_ai_input(id, instance_id, *cursor).await {
                Ok(body) => {
                    if let Some(status) = body.get("status").and_then(Value::as_str) {
                        if matches!(status, "done" | "failed" | "expired") {
                            return Approval::Denied("approval channel closed");
                        }
                    }
                    let frames = body
                        .get("frames")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for frame in &frames {
                        if let Some(seq) = frame.get("seq").and_then(Value::as_u64) {
                            if seq > *cursor {
                                *cursor = seq;
                            }
                        }
                        let Some(envelope) = frame.get("envelope").and_then(Value::as_str) else {
                            continue;
                        };
                        let opened = match self
                            .sessions
                            .open_inbound(&self.identity, id, eph_pub, envelope)
                        {
                            Ok(bytes) => bytes,
                            Err(e) => {
                                eprintln!("[ai-tunnel] request {id} input frame rejected: {e}");
                                continue;
                            }
                        };
                        let Ok(value) = serde_json::from_slice::<Value>(&opened) else {
                            continue;
                        };
                        if value.get("type").and_then(Value::as_str) != Some("tool_approval") {
                            continue;
                        }
                        if value.get("callId").and_then(Value::as_str) != Some(call_id) {
                            continue;
                        }
                        return match value.get("approved").and_then(Value::as_bool) {
                            Some(true) => Approval::Approved,
                            _ => Approval::Denied("denied by user"),
                        };
                    }
                }
                Err(FlError::Http { status: 404, .. }) | Err(FlError::Conflict) => {
                    // The request row is gone / no longer ours — no answer can
                    // ever arrive on this channel.
                    return Approval::Denied("approval channel closed");
                }
                Err(e) => {
                    // Transient — keep polling until the deadline.
                    eprintln!("[ai-tunnel] request {id} input poll failed: {e}");
                }
            }
            if Instant::now() >= deadline {
                return Approval::Denied("approval timed out");
            }
            tokio::time::sleep(self.confirm_timing.poll_interval).await;
        }
    }
}

/// One `role:"tool"` conversation message (OpenAI convention: content is a
/// string; every tool_call gets exactly one).
fn tool_reply(call_id: &str, content: Value) -> Value {
    json!({
        "role": "tool",
        "tool_call_id": call_id,
        "content": content.to_string(),
    })
}

/// The Native transport's `role:"tool"` content for one outcome.
fn native_feedback(outcome: &ExecOutcome) -> String {
    match outcome {
        ExecOutcome::Done { bounded } => bounded.clone(),
        ExecOutcome::Failed {
            error,
            terminal: true,
        } => json!({
            "executed": false,
            "error": error,
            "note": "Tool access is no longer available for this conversation; answer with what you already have.",
        })
        .to_string(),
        ExecOutcome::Failed {
            error,
            terminal: false,
        } => json!({ "executed": false, "error": error }).to_string(),
    }
}

/// The Prompted transport's plain-text feedback for one outcome — the shape
/// the preamble announces (`tool_result <name>: …`).
fn prompted_feedback(name: &str, outcome: &ExecOutcome) -> String {
    match outcome {
        ExecOutcome::Done { bounded } => format!("tool_result {name}: {bounded}"),
        ExecOutcome::Failed {
            error,
            terminal: true,
        } => format!(
            "tool_result {name} failed: {error}\nTool access is no longer available for this conversation; answer with what you already have."
        ),
        ExecOutcome::Failed {
            error,
            terminal: false,
        } => format!("tool_result {name} failed: {error}"),
    }
}

/// The Prompted harness preamble: the catalog (name, description, input
/// schema) plus the pinned reply convention.
fn prompted_preamble(tools: &[Value]) -> String {
    let mut s = String::from(
        "You can use FormLogic tools in this conversation.\n\nAvailable tools:\n",
    );
    for tool in tools {
        let Some(name) = tool.pointer("/function/name").and_then(Value::as_str) else {
            continue;
        };
        let description = tool
            .pointer("/function/description")
            .and_then(Value::as_str)
            .unwrap_or("");
        let schema = tool
            .pointer("/function/parameters")
            .map(Value::to_string)
            .unwrap_or_else(|| "{}".to_string());
        s.push_str(&format!("- {name}: {description}\n  input schema: {schema}\n"));
    }
    s.push_str(concat!(
        "\nTo call a tool, reply with ONLY one fenced block and nothing else — ",
        "no prose before or after it:\n\n",
        "```tool_call\n",
        "{\"tool\":\"<name>\",\"input\":{...}}\n",
        "```\n\n",
        "One tool call per reply. Each result arrives as a message starting with ",
        "\"tool_result\"; then call another tool or answer the user. ",
        "When no tool is needed, answer the user in plain text.",
    ));
    s
}

/// The text of a message content: a plain string as-is; OpenAI content PARTS
/// collapse to their text parts joined, with an `[image attached]` marker per
/// image part (the images themselves ride the request's `images` field as
/// app-server input items — the marker keeps the transcript honest about
/// where they sat in the conversation).
pub(super) fn message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    out.push(text.to_string());
                }
            }
            Some("image_url") => out.push("[image attached]".to_string()),
            _ => {}
        }
    }
    out.join("\n")
}

/// Chat image data URIs from USER messages' content parts, in conversation
/// order. `last_only` restricts to the newest user message (thread-resume
/// turns — earlier images already reached the thread). Capped at the request
/// limit KEEPING THE NEWEST — the tail of the conversation is what the user
/// is asking about.
pub(super) fn collect_user_image_urls(messages: &[Value], last_only: bool) -> Vec<String> {
    const CAP: usize = 8;
    let last_user = messages
        .iter()
        .rposition(|m| m.get("role").and_then(Value::as_str) == Some("user"));
    let mut urls: Vec<String> = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        if m.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if last_only && Some(i) != last_user {
            continue;
        }
        let Some(parts) = m.get("content").and_then(Value::as_array) else {
            continue;
        };
        for part in parts {
            if part.get("type").and_then(Value::as_str) != Some("image_url") {
                continue;
            }
            if let Some(url) = part.pointer("/image_url/url").and_then(Value::as_str) {
                urls.push(url.to_string());
            }
        }
    }
    if urls.len() > CAP {
        urls.drain(..urls.len() - CAP);
    }
    urls
}

/// Render an OpenAI-style message list as plain conversation text (the shape
/// the prompt-only Codex lane receives on its first harness round, and the
/// fresh-thread prompt of the plain chat path — `pub(super)` for the latter).
pub(super) fn render_convo_text(messages: &[Value]) -> String {
    messages
        .iter()
        .map(|m| {
            let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
            let content = m
                .get("content")
                .map(message_text)
                .unwrap_or_default();
            format!("{role}: {content}")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The first Codex harness prompt: instruction block + the rendered
/// conversation (the Codex request is prompt-only; later rounds continue the
/// thread the response opened).
fn codex_first_prompt(attach: bool, tools: &[Value], convo: &[Value]) -> String {
    let mut p = if attach {
        prompted_preamble(tools)
    } else {
        PROMPTED_PLAIN_ANSWER.to_string()
    };
    p.push_str("\n\n");
    p.push_str(&render_convo_text(convo));
    p
}

/// A follow-up Codex harness prompt: only what is NEW since the last round
/// (the tool feedback), plus the plain-answer instruction once tools are no
/// longer offered.
fn codex_followup_prompt(pending: &[String], attach: bool) -> String {
    let mut p = pending.join("\n\n");
    if !attach {
        if !p.is_empty() {
            p.push_str("\n\n");
        }
        p.push_str(PROMPTED_PLAIN_ANSWER);
    }
    p
}

/// Well-formed-or-text: parse a Prompted reply as a tool call ONLY when the
/// whole (trimmed) reply is a single ```tool_call fenced block whose JSON
/// names a cataloged tool with an object (or absent) input. Anything else —
/// malformed JSON, an unknown tool, a non-object input, prose around the
/// fence — is `None`: the reply is the final text answer. Never guess.
fn parse_prompted_tool_call(text: &str, tools: &[Value]) -> Option<(String, Value)> {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix(PROMPTED_FENCE)?;
    let rest = rest.strip_prefix('\r').unwrap_or(rest);
    let rest = rest.strip_prefix('\n')?;
    let inner = rest.strip_suffix("```")?;
    let value: Value = serde_json::from_str(inner.trim()).ok()?;
    let name = value
        .get("tool")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let known = tools
        .iter()
        .any(|t| t.pointer("/function/name").and_then(Value::as_str) == Some(name));
    if !known {
        return None;
    }
    let input = match value.get("input") {
        Some(v @ Value::Object(_)) => v.clone(),
        None | Some(Value::Null) => json!({}),
        Some(_) => return None,
    };
    Some((name.to_string(), input))
}

/// Bound a tool result for (a) the sealed frame and (b) the model feed. An
/// oversized frame result becomes an honest truncation note (never a silently
/// clipped JSON document); the model feed is clipped at a char boundary with
/// an explicit marker.
fn bound_result(result: Value) -> (Value, String) {
    let serialized = result.to_string();
    let frame = if serialized.len() > MAX_RESULT_FRAME_BYTES {
        json!({ "truncated": true, "note": "tool result exceeded the relay frame cap" })
    } else {
        result
    };
    let feed = if serialized.len() > MAX_RESULT_MODEL_BYTES {
        let mut cut = serialized;
        let mut end = MAX_RESULT_MODEL_BYTES;
        while end > 0 && !cut.is_char_boundary(end) {
            end -= 1;
        }
        cut.truncate(end);
        cut.push_str(" … [truncated]");
        cut
    } else {
        serialized
    };
    (frame, feed)
}

/// Normalize the backend catalog (`{tools:[{name, description, inputSchema}]}`,
/// with a `data.tools` envelope tolerated) into the OpenAI function-calling
/// `tools` array. Entries without a name are skipped; a missing/malformed
/// schema becomes the empty object schema.
pub(crate) fn catalog_to_openai_tools(raw: &Value) -> Vec<Value> {
    let entries = raw
        .get("tools")
        .and_then(Value::as_array)
        .or_else(|| raw.pointer("/data/tools").and_then(Value::as_array));
    let Some(entries) = entries else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())?;
            let mut function = json!({ "name": name });
            if let Some(desc) = entry
                .get("description")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                function["description"] = json!(desc);
            }
            function["parameters"] = entry
                .get("inputSchema")
                .or_else(|| entry.get("input_schema"))
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Some(json!({ "type": "function", "function": function }))
        })
        .collect()
}

#[cfg(test)]
mod tests;
