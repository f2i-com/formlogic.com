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
