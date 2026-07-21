# Website AI to Desktop routing audit

The website can use an explicitly selected OpenAI-compatible provider (including
Desktop's bounded background ChatGPT/Codex adapter) for **new text-form
generation**. The request is sent from the signed-in website directly to the
paired loopback Desktop gateway at
`/api/ai/providers/:id/v1/chat/completions`; provider credentials or delegated
ChatGPT sign-in remain in Desktop. FormLogic Cloud does not proxy that provider
request.

The hosted generator remains an explicit choice. A failed Desktop request is not
silently retried against hosted AI, which avoids duplicate generation and
unexpected hosted usage.

| Website operation | Desktop provider | FormLogic Hosted | Current reason |
| --- | --- | --- | --- |
| New form from text | Yes, exact selected provider | Yes | Strict browser-side schema/parser rejects code, unknown fields and unsafe IDs. |
| Edit an existing form | No | Yes | Hosted edit path preserves field IDs and coordinates existing logic. |
| Form from photo | No | Yes | Hosted path owns image/document extraction and validated form conversion. |
| Form from PDF/Word document | No | Yes | Hosted path owns bounded file parsing and document conversion. |
| App plan | No | Yes | Hosted app planner returns the validated multi-form plan contract. |
| App form materialization | No | Yes | The app-builder runner still calls the hosted form generator. |
| Custom/app-home screen generation | No | Yes | Generated TSX/JS is executable content and stays behind the hosted prompt, compiler and validation boundary. |
| Script generation/improvement | No | Yes | Generated on-submit code stays behind the hosted field-grounded safety path. |

The executable policy is
`formlogic/ui/src/lib/websiteAiRouting.ts`; its test locks the exact matrix and
proves an unsupported Desktop selection returns `unsupported`, never hosted.
Adding Desktop support to another row requires a bounded response parser and
operation-specific tests before changing that policy.

## Floating site chat (Phase 6)

The floating chat widget (`ui/src/components/chat/SiteChatWidget.tsx`, mounted
globally in `AppShell` for signed-in users) routes every turn through
`ui/src/components/chat/chatEngine.ts`, which resolves the user's Settings → AI
source per turn and runs **exactly one** source — a failing or unresolvable
source is a typed inline error, never a silent hop:

- **Site** — `POST /api/ai/chat` (hosted tool loop, SSE, allowance-metered).
  Content is server-processed; the widget badges it
  "Hosted — processed by FormLogic Cloud".
- **Desktop** — the E2E tunnel
  (`ui/src/client-runtime/desktop/desktopTunnel.ts`): the request body —
  including `messages`, the per-user `toolMode` (Auto/Confirm) and a per-turn
  `toolGrant` — is sealed to the desktop's X25519 identity, so FormLogic Cloud
  relays only routing metadata. Badge: "Private — end-to-end encrypted to your
  Desktop".
- **Custom** — the browser-local AI-services registry, named plainly in the
  badge. Tools are unsupported there; replies carry an honest text-only note.

Tool use on the desktop source works without exposing content to the backend:
the browser mints a 10-minute grant per turn (`POST /api/ai/chat-tool-grant`),
seals it into the tunnel envelope, and the desktop presents it to
`POST /api/ai/chat-tools/execute`, which verifies the grant + its bound desktop
instance and executes as the granting user (audited). A failed mint degrades the
turn to a no-tools reply with a visible note — it never fails the turn. In
Confirm mode the desktop pauses on a sealed `tool_proposal` frame; the widget
renders an approve/deny card answered over the sealed input channel
(`postInput`, `{type:'tool_approval', callId, approved}`), and an unanswered
proposal is auto-denied by the desktop after about 120 seconds.

Chat history is client-side only in v1 (IndexedDB `formlogic-chat:<userId>`,
`ui/src/components/chat/chatStore.ts`, in-memory fallback when storage is
unavailable); there are no server-side transcripts. The demo account chats with
tools disabled end to end (banner + `tools:false` + no grant minting).
