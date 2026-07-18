<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * AI Service for form and script generation
 * Uses OpenAI-compatible API (works with OpenAI, Azure OpenAI, local LLMs, etc.)
 */
class AIService
{
    private string $apiKey;
    private string $apiUrl;
    private string $model;
    private string $visionModel;

    public function __construct()
    {
        // Provider-neutral AI_* names take precedence (point these at LM Studio / Ollama / any
        // OpenAI-compatible local server); the OPENAI_* names remain as fallbacks for back-compat.
        $this->apiKey = (string) ($_ENV['AI_API_KEY'] ?? $_ENV['OPENAI_API_KEY'] ?? '');
        $this->apiUrl = rtrim((string) ($_ENV['AI_BASE_URL'] ?? $_ENV['OPENAI_API_URL'] ?? 'https://api.openai.com/v1'), '/');
        $this->model = (string) ($_ENV['AI_MODEL'] ?? $_ENV['OPENAI_MODEL'] ?? 'gpt-4o');
        // Default the vision model to the main model so a single-model local server works out of the box.
        $this->visionModel = (string) ($_ENV['AI_VISION_MODEL'] ?? $_ENV['OPENAI_VISION_MODEL'] ?? $this->model);

        // Never send an API KEY over plaintext HTTP in production (credential leak). A KEYLESS local
        // endpoint over HTTP is fine — there's no secret to leak. Decision is shared with the health
        // check via keyBlockedOverHttp() so the two can't drift.
        $isProduction = (($_ENV['APP_ENV'] ?? 'production') !== 'development');
        if (self::keyBlockedOverHttp($this->apiUrl, $this->apiKey, $isProduction)) {
            error_log('FormLogic AIService: refusing to send the API key over plaintext HTTP in production; key cleared. Use HTTPS, set ALLOW_INSECURE_LOCAL_AI=1 for a loopback model, or run the local endpoint keyless.');
            $this->apiKey = '';
        }
    }

    /**
     * Whether a set API key would be sent over plaintext HTTP in production and therefore must be
     * cleared (true = unsafe, drop the key). Keyless / https / dev all return false. Honors
     * ALLOW_INSECURE_LOCAL_AI only for a loopback host. Shared by the constructor and the Doctor
     * health check so the guard and its diagnostic never diverge.
     */
    public static function keyBlockedOverHttp(string $apiUrl, string $apiKey, bool $isProduction): bool
    {
        if ($apiKey === '' || !$isProduction) {
            return false;
        }
        if (strtolower((string) parse_url($apiUrl, PHP_URL_SCHEME)) !== 'http') {
            return false;
        }
        // parse_url returns IPv6 hosts bracketed ("[::1]") — strip the brackets so loopback matches.
        $host = trim(strtolower((string) parse_url($apiUrl, PHP_URL_HOST)), '[]');
        $allowInsecureLocal = in_array(strtolower((string) ($_ENV['ALLOW_INSECURE_LOCAL_AI'] ?? '')), ['1', 'true', 'yes'], true)
            && in_array($host, ['127.0.0.1', '::1', 'localhost'], true);
        return !$allowInsecureLocal;
    }

    /**
     * Check if AI service is configured. A key is REQUIRED for the default OpenAI endpoint, but a
     * custom endpoint (a local server such as LM Studio / Ollama, or any self-hosted OpenAI-compatible
     * API) may run KEYLESS — so a custom base URL alone is enough.
     */
    public function isConfigured(): bool
    {
        return $this->isEnabled() && ($this->apiKey !== '' || $this->isCustomEndpoint());
    }

    /**
     * Whether the in-app (local) AI is turned on. Set AI_ENABLED=false in .env to disable all built-in
     * AI generation — useful when steering users to an external AI via the MCP server instead.
     */
    public function isEnabled(): bool
    {
        $v = strtolower(trim((string) ($_ENV['AI_ENABLED'] ?? 'true')));
        return !in_array($v, ['false', '0', 'no', 'off'], true);
    }

    /** True when pointed at a non-OpenAI (e.g. local / self-hosted) OpenAI-compatible endpoint. */
    private function isCustomEndpoint(): bool
    {
        $host = strtolower((string) parse_url($this->apiUrl, PHP_URL_HOST));
        return $host !== '' && $host !== 'api.openai.com';
    }

    /**
     * Generate form fields from a text prompt. When $existingFields is provided, the prompt is
     * treated as an EDIT to that form (the model sees the current fields + script and modifies them,
     * preserving field ids) rather than a fresh generation.
     *
     * @param array<int,array<string,mixed>> $existingFields Current fields ({id,label,type,required}).
     */
    public function generateFormFromPrompt(string $prompt, array $existingFields = [], string $existingScript = ''): array
    {
        $editing = !empty($existingFields);
        $systemPrompt = $this->getFormGenerationSystemPrompt()
            . ($editing ? $this->buildEditContext($existingFields, $existingScript) : '');

        $userMessage = $editing
            ? "Apply this change to the existing form described above. Return the COMPLETE updated form:\n\n" . $prompt
            : "Create a form based on this description:\n\n" . $prompt;

        $response = $this->chatCompletion([
            ['role' => 'system', 'content' => $systemPrompt],
            ['role' => 'user', 'content' => $userMessage],
        ]);

        return $this->parseFormResponse($response);
    }

    /**
     * Build the "you are editing an existing form" addendum to the form-generation system prompt:
     * the current fields (with ids) + script, plus modification rules (preserve ids, full set back).
     *
     * @param array<int,array<string,mixed>> $existingFields
     */
    private function buildEditContext(array $existingFields, string $existingScript): string
    {
        $lines = '';
        foreach ($existingFields as $f) {
            if (!is_array($f)) {
                continue;
            }
            $lines .= sprintf(
                "- id=%s | %s (%s)%s\n",
                (string) ($f['id'] ?? '?'),
                (string) ($f['label'] ?? ''),
                (string) ($f['type'] ?? ''),
                !empty($f['required']) ? ' [required]' : ''
            );
        }

        $ctx = "\n\n---\nYOU ARE EDITING AN EXISTING FORM. Its current fields are:\n" . $lines;
        if (trim($existingScript) !== '') {
            $ctx .= "\nIts current onSubmit script:\n```\n" . $existingScript . "\n```\n";
        }
        $ctx .= "\nThe user's message is a CHANGE REQUEST, not a new form. Rules:\n"
            . "- Return the COMPLETE updated field list (every field the form should end up with), not just the change.\n"
            . "- PRESERVE the exact \"id\" of every existing field you keep or modify (responses and logic reference these ids); give a new id ONLY to genuinely new fields.\n"
            . "- Keep fields the user didn't ask to change. Remove a field only if explicitly asked.\n"
            . "- Preserve a sensible field order.\n"
            . "- If the form has an existing script and the change affects on-submit logic, set \"needsScript\": true and, in \"suggestedScript\", describe the MODIFICATION to make to the current script (what to add/change relative to it) rather than a rewrite from scratch. If no logic change is needed, set \"needsScript\": false.";

        return $ctx;
    }

    /**
     * Generate form from uploaded images (photos of paper forms, screenshots, etc.)
     *
     * @param array $images Array of base64-encoded images or URLs
     */
    public function generateFormFromImages(array $images, ?string $additionalPrompt = null): array
    {
        $systemPrompt = $this->getFormGenerationSystemPrompt();

        $content = [];
        $content[] = [
            'type' => 'text',
            'text' => "Analyze this form/document image and convert it to a digital form. Extract all fields, their types, labels, and whether they appear required.\n\n" .
                     ($additionalPrompt ? "Additional instructions: " . $additionalPrompt : "")
        ];

        foreach ($images as $image) {
            if (str_starts_with($image, 'http://') || str_starts_with($image, 'https://')) {
                // Validate URL to prevent SSRF attacks
                $validatedUrl = $this->validateImageUrl($image);
                if ($validatedUrl === null) {
                    throw new \Exception('Invalid image URL: must be a valid HTTPS URL');
                }
                $content[] = [
                    'type' => 'image_url',
                    'image_url' => ['url' => $validatedUrl]
                ];
            } elseif (str_starts_with($image, 'data:')) {
                // Already a data URL, validate it's an image type
                if (!preg_match('/^data:image\/(jpeg|png|gif|webp);base64,/', $image)) {
                    throw new \Exception('Invalid data URL: must be a valid image data URL');
                }
                $content[] = [
                    'type' => 'image_url',
                    'image_url' => ['url' => $image]
                ];
            } else {
                // Assume base64 (raw base64 without data: prefix)
                $mimeType = $this->detectImageMimeType($image);
                $content[] = [
                    'type' => 'image_url',
                    'image_url' => [
                        'url' => "data:{$mimeType};base64,{$image}"
                    ]
                ];
            }
        }

        $response = $this->chatCompletion([
            [
                'role' => 'system',
                'content' => $systemPrompt
            ],
            [
                'role' => 'user',
                'content' => $content
            ]
        ], $this->visionModel);

        return $this->parseFormResponse($response);
    }

    /**
     * Generate a backend logic script from a prompt
     */
    public function generateScript(string $prompt, array $formFields, string $exampleScript = ''): array
    {
        $systemPrompt = $this->getScriptGenerationSystemPrompt($formFields, $exampleScript);

        $response = $this->chatCompletion([
            [
                'role' => 'system',
                'content' => $systemPrompt
            ],
            [
                'role' => 'user',
                'content' => "Generate a script based on this description:\n\n" . $prompt
            ]
        ]);

        return $this->parseScriptResponse($response);
    }

    /**
     * Generate a CUSTOM SCREEN ({ html, css, js }) for a form — a sandboxed single-page UI that talks
     * to the backend only via the FormLogic SDK. $fields are the form's fields the screen submits to.
     */
    public function generateCustomScreen(string $prompt, array $fields = [], string $existing = '', array $appForms = []): array
    {
        // When appForms is given, the screen is an APP HOME (multi-form, app-scoped SDK); otherwise it's
        // a single-form screen.
        $system = !empty($appForms)
            ? $this->getAppScreenSystemPrompt($appForms)
            : $this->getCustomScreenSystemPrompt($fields);
        $messages = [
            ['role' => 'system', 'content' => $system],
        ];
        if (trim($existing) !== '') {
            $messages[] = ['role' => 'user', 'content' => "Here is the current screen JSON:\n```json\n{$existing}\n```\n\nModify it based on this request:\n\n" . $prompt];
        } else {
            $messages[] = ['role' => 'user', 'content' => "Build this screen:\n\n" . $prompt];
        }
        // Screens are bigger than forms/scripts (full HTML+CSS+JS), so allow more output room.
        return $this->parseCustomScreen($this->chatCompletion($messages, null, 16384));
    }

    private function getCustomScreenSystemPrompt(array $fields): string
    {
        $fieldList = '(this form has no fields yet)';
        if (!empty($fields)) {
            $lines = [];
            foreach ($fields as $f) {
                if (!is_array($f)) {
                    continue;
                }
                $lines[] = '- ' . ($f['id'] ?? '?') . ' (' . ($f['type'] ?? 'text') . '): ' . ($f['label'] ?? '');
            }
            $fieldList = implode("\n", $lines);
        }

        return <<<PROMPT
You build a CUSTOM SCREEN — a small React-style TSX app that runs inside a SANDBOXED iframe.
It has NO network access of its own (fetch/XHR are blocked). It talks to the FormLogic backend ONLY through the
global `FormLogic` SDK, which is already injected (do not redefine it):

  await FormLogic.context()            -> { formId, title, fields: [{ id, label, type }] }
  await FormLogic.records({ limit })   -> [{ id, answers: {<fieldId>: value}, submittedAt, status, tags }]  // this form's saved records, newest first
  await FormLogic.submit(answers)      -> saves a record (answers is an object keyed by FIELD ID); returns the saved record. Runs server validation + the form's onSubmit script.
  await FormLogic.currentUser()        -> { id, name, email } | null
  FormLogic.toast.success(message)     // small success toast
  FormLogic.toast.error(message)       // small error toast
  FormLogic.escapeHtml(value)          // -> HTML-escaped string (only needed if you build raw HTML strings; JSX text is auto-escaped)

RUNTIME: the screen is a multi-file TypeScript/TSX project bundled in the sandbox. JSX components run on
Preact with React aliased to it — `import { useState, useEffect } from 'react'` and
`import { createRoot } from 'react-dom/client'` work as usual. ONLY these built-in modules exist:
'react', 'react-dom/client', 'preact', 'preact/hooks'. NO other npm packages — everything else must be
your own files, imported with RELATIVE paths (folders are fine, e.g. `import { Card } from './components/Card'`).
The entry file is index.tsx and it MUST mount the app:
  createRoot(document.getElementById('root')!).render(<App />);
A `<div id="root"></div>` shell exists automatically — you do NOT need an index.html. Every .css file you
emit is injected automatically. The host injects CSS custom properties for theming: use var(--fl-accent)
and var(--fl-accent-contrast) for the brand color so the screen matches the app.

This form's fields (submit using these EXACT ids):
{$fieldList}

Requirements:
- Use ONLY FormLogic for data — never fetch(). Wrap async calls in try/catch and use FormLogic.toast.error on failure.
- Make it genuinely functional and visually polished (responsive, clean typography, sensible spacing).
- To save data call FormLogic.submit({ fieldId: value }); to show a leaderboard/history call FormLogic.records().
- Handle events with JSX props (onClick etc.) — never inline HTML attribute handlers.
- SECURITY: render record/user data as JSX text (auto-escaped). NEVER use dangerouslySetInnerHTML with record data.
- Split non-trivial UIs into component files (components/…) rather than one giant file.
- Keep total output reasonable so it isn't truncated.

Respond with ONLY fenced code blocks, ONE PER FILE, each fence tagged with its path — no prose, no JSON:
```tsx file=index.tsx
...the entry: components + createRoot mount...
```
```css file=styles.css
...the styles...
```
Add more component files as extra blocks, e.g. ```tsx file=components/Leaderboard.tsx
PROMPT;
    }

    private function getAppScreenSystemPrompt(array $appForms): string
    {
        $formList = '(this app has no forms yet)';
        if (!empty($appForms)) {
            $blocks = [];
            foreach ($appForms as $f) {
                if (!is_array($f)) {
                    continue;
                }
                $fid = $f['formId'] ?? $f['id'] ?? '?';
                $title = $f['title'] ?? $f['displayName'] ?? '';
                $fieldLines = [];
                foreach (($f['fields'] ?? []) as $fld) {
                    if (!is_array($fld)) {
                        continue;
                    }
                    $fieldLines[] = '      - ' . ($fld['id'] ?? '?') . ' (' . ($fld['type'] ?? 'text') . '): ' . ($fld['label'] ?? '');
                }
                $blocks[] = "  formId \"{$fid}\" — {$title}\n" . (empty($fieldLines) ? '      (no fields)' : implode("\n", $fieldLines));
            }
            $formList = implode("\n", $blocks);
        }

        return <<<PROMPT
You build an APP HOME screen — the landing page of a multi-form app — as a small React-style TSX app that
runs inside a SANDBOXED iframe. It has NO network access of its own (fetch/XHR are blocked).
It talks to the backend ONLY through the global `FormLogic` SDK, which is already injected (do not redefine it).
This SDK is APP-scoped — it spans the app's forms, so data calls take a formId:

  await FormLogic.context()                  -> { appName, appSlug, forms: [{ formId, displayName, fields:[{id,label,type}] }] }
  await FormLogic.forms()                    -> the forms array (same as context().forms)
  await FormLogic.submit(formId, answers)    -> save a record to that form (answers keyed by FIELD ID; runs its onSubmit)
  await FormLogic.records(formId, { limit }) -> that form's records, newest first: [{ id, answers, submittedAt }]
  await FormLogic.navigate(formId)           -> open that form inside the app
  await FormLogic.currentUser()              -> { id, name, email } | null
  FormLogic.toast.success(message) / FormLogic.toast.error(message)
  FormLogic.escapeHtml(value)                -> HTML-escaped string; use for ANY record/user data put into innerHTML

RUNTIME: the screen is a multi-file TypeScript/TSX project bundled in the sandbox. JSX components run on
Preact with React aliased to it — `import { useState, useEffect } from 'react'` and
`import { createRoot } from 'react-dom/client'` work as usual. ONLY these built-in modules exist:
'react', 'react-dom/client', 'preact', 'preact/hooks'. NO other npm packages — everything else must be
your own files, imported with RELATIVE paths (folders are fine, e.g. `import { Card } from './components/Card'`).
The entry file is index.tsx and it MUST mount the app:
  createRoot(document.getElementById('root')!).render(<App />);
A `<div id="root"></div>` shell exists automatically — you do NOT need an index.html. Every .css file you
emit is injected automatically. The host injects CSS custom properties for theming: use var(--fl-accent)
and var(--fl-accent-contrast) for the brand color so the screen matches the app.

This app's forms (use these EXACT formId values and field ids):
{$formList}

Requirements:
- Use ONLY FormLogic for data — never fetch(). Pass the correct formId to submit/records/navigate.
- Make it a genuinely useful, polished landing (responsive, clean typography) — e.g. a dashboard, a game, a launcher.
- Handle events with JSX props (onClick etc.) — never inline HTML attribute handlers.
- SECURITY: render record/user data as JSX text (auto-escaped). NEVER use dangerouslySetInnerHTML with record data.
- Split non-trivial UIs into component files (components/…) rather than one giant file.
- Wrap async calls in try/catch and use FormLogic.toast.error on failure.

Respond with ONLY fenced code blocks, ONE PER FILE, each fence tagged with its path — no prose, no JSON:
```tsx file=index.tsx
...the entry: components + createRoot mount...
```
```css file=styles.css
...the styles...
```
Add more component files as extra blocks, e.g. ```tsx file=components/FormCard.tsx
PROMPT;
    }

    /**
     * Parse the AI screen reply. Preferred format: fenced blocks tagged with file paths
     * (```tsx file=index.tsx …) — returned as a multi-file `files` project the Studio/runtime
     * bundles (TSX on the embedded Preact). Falls back to the legacy three-block html/css/js
     * triple, then to a JSON object, so older models keep working.
     */
    public function parseCustomScreen(string $response): array
    {
        // Named-file fences: ```<lang> file=path
        if (preg_match_all('/```[a-zA-Z]*[ \t]+file=([^\s`]+)[ \t]*\r?\n([\s\S]*?)```/i', $response, $m, PREG_SET_ORDER)) {
            $files = [];
            $total = 0;
            foreach (array_slice($m, 0, 24) as $match) {
                $path = $this->sanitizeScreenFilePath($match[1]);
                if ($path === null) {
                    continue;
                }
                $content = substr(trim($match[2]), 0, 200000);
                $total += strlen($content);
                if ($total > 480000) { // stay under the 512KB customScreen cap with JSON overhead
                    break;
                }
                $files[] = ['path' => $path, 'content' => $content];
            }
            $hasEntry = array_filter($files, static fn ($f) => preg_match('/^(index|main|app)\.(tsx?|jsx?)$/', $f['path']));
            if (!empty($files) && !empty($hasEntry)) {
                // Models sometimes mix formats: tagged code fences plus an UNTAGGED css/html block.
                // Fold those in rather than silently dropping them.
                $paths = array_column($files, 'path');
                if (!in_array(true, array_map(static fn ($p) => (bool) preg_match('/\.css$/', $p), $paths), true)
                    && preg_match('/```css\b[ \t]*\r?\n([\s\S]*?)```/i', $response, $cssM)) {
                    $files[] = ['path' => 'styles.css', 'content' => substr(trim($cssM[1]), 0, 100000)];
                }
                if (!in_array('index.html', $paths, true)
                    && preg_match('/```html\b[ \t]*\r?\n([\s\S]*?)```/i', $response, $htmlM)) {
                    $files[] = ['path' => 'index.html', 'content' => substr(trim($htmlM[1]), 0, 100000)];
                }
                return ['html' => '', 'css' => '', 'js' => '', 'files' => $files];
            }
        }

        $grab = static function (string $lang) use ($response): string {
            return preg_match('/```' . $lang . '\b[ \t]*\r?\n([\s\S]*?)```/i', $response, $m) ? trim($m[1]) : '';
        };
        $html = $grab('html');
        $css = $grab('css');
        $js = $grab('(?:js|javascript)');
        // A lone un-tagged tsx/ts fence still counts as an entry file (models sometimes drop the tag).
        $tsx = $grab('(?:tsx|ts|typescript)');
        if ($tsx !== '' && $js === '') {
            $files = [['path' => 'index.tsx', 'content' => substr($tsx, 0, 200000)]];
            if ($css !== '') {
                $files[] = ['path' => 'styles.css', 'content' => substr($css, 0, 100000)];
            }
            return ['html' => '', 'css' => '', 'js' => '', 'files' => $files];
        }

        // Fallback: some models return a JSON object instead of fenced blocks.
        if ($html === '' && $js === '' && preg_match('/\{[\s\S]*\}/', $response, $m)) {
            $data = json_decode(preg_replace('/,\s*([}\]])/', '$1', $m[0]), true);
            if (is_array($data)) {
                $html = (string) ($data['html'] ?? '');
                $css = (string) ($data['css'] ?? '');
                $js = (string) ($data['js'] ?? '');
            }
        }
        if ($html === '' && $js === '') {
            throw new \Exception('No screen content found in AI reply');
        }
        $clip = static fn ($v, int $max): string => substr((string) $v, 0, $max);
        return ['html' => $clip($html, 100000), 'css' => $clip($css, 100000), 'js' => $clip($js, 200000)];
    }

    /** Normalize an AI-emitted screen file path; null = refuse (traversal / bad extension). */
    private function sanitizeScreenFilePath(string $path): ?string
    {
        $path = ltrim(str_replace('\\', '/', trim($path)), '/');
        if ($path === '' || strlen($path) > 160 || str_contains($path, '..')) {
            return null;
        }
        if (!preg_match('#^[A-Za-z0-9._/-]+\.(html?|css|jsx?|tsx?|json|svg|md|txt)$#', $path)) {
            return null;
        }
        return $path;
    }

    /**
     * Improve or modify an existing script
     */
    public function improveScript(string $currentScript, string $prompt, array $formFields): array
    {
        $systemPrompt = $this->getScriptGenerationSystemPrompt($formFields);

        $response = $this->chatCompletion([
            [
                'role' => 'system',
                'content' => $systemPrompt
            ],
            [
                'role' => 'user',
                'content' => "Here is the current script:\n\n```\n{$currentScript}\n```\n\nModify it based on this request:\n\n" . $prompt
            ]
        ]);

        return $this->parseScriptResponse($response);
    }

    /**
     * Generate a multi-form APP PLAN from a prompt (AI App Builder). Returns a normalized plan:
     * { app:{name,description}, forms:[{key,title,purpose}], relations:[{from,to,label}], roles:[{name,level}] }.
     */
    public function generateAppPlan(string $prompt, int $maxForms = 6, ?string $image = null): array
    {
        $system = $this->getAppPlanSystemPrompt();
        $userText = $prompt . "\n\nDesign up to {$maxForms} forms.";

        if ($image !== null && $image !== '') {
            // A sketch/screenshot/wireframe/document image as extra design detail (vision).
            if (!preg_match('/^data:image\/(jpeg|png|gif|webp);base64,/', $image)) {
                throw new \Exception('Invalid image: must be a base64 image data URL (jpeg/png/gif/webp)');
            }
            $messages = [
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => [
                    ['type' => 'text', 'text' => $userText . "\n\nUse the attached image (a sketch, screenshot, wireframe, or document) as additional detail for the app design."],
                    ['type' => 'image_url', 'image_url' => ['url' => $image]],
                ]],
            ];
            $response = $this->chatCompletion($messages, $this->visionModel);
        } else {
            $response = $this->chatCompletion([
                ['role' => 'system', 'content' => $system],
                ['role' => 'user', 'content' => $userText],
            ]);
        }
        return $this->parseAppPlan($response, $maxForms);
    }

    private function getAppPlanSystemPrompt(): string
    {
        return <<<'PROMPT'
You are an application architect for FormLogic, a platform where an "app" bundles several linked forms.
Given a description, design a coherent multi-form app and respond with ONLY a JSON object:
{
  "app": { "name": "Short App Name", "description": "One sentence." },
  "forms": [ { "key": "snake_case_id", "title": "Form Title", "purpose": "what this form captures + any logic it needs", "screen": "OPTIONAL: describe a custom interactive UI for this form (e.g. a game board, a dashboard, a kanban) — omit for plain data-entry forms" } ],
  "relations": [ { "from": "child_form_key", "to": "parent_form_key", "label": "Linked Field Label" } ],
  "roles": [ { "name": "Role Name", "level": "admin" } ]
}
Rules:
- Design the forms a real team would use for this domain — distinct, non-overlapping, in a sensible workflow order.
- "key" is a unique snake_case slug per form. Relations reference forms by their "key".
- A relation means the "from" form has a field linking to a record in the "to" form (e.g. an Interview links to a Candidate). Point child -> parent. Only include relations that make real sense.
- "level" is one of: "admin" (full control), "contributor" (submit + see own), "viewer" (read all). Include 2-4 roles.
- Only add "screen" to a form when a custom interactive frontend genuinely adds value (games, dashboards, leaderboards, boards). Most forms should NOT have one.
- Respond with ONLY the JSON object, no prose.
PROMPT;
    }

    /** Parse + normalize the app plan: slugify keys, cap forms, dedup, drop dangling relations. */
    private function parseAppPlan(string $response, int $maxForms): array
    {
        if (!preg_match('/\{[\s\S]*\}/', $response, $matches)) {
            throw new \Exception('Could not parse plan as JSON');
        }
        $data = json_decode($matches[0], true);
        if (json_last_error() !== JSON_ERROR_NONE || !is_array($data)) {
            throw new \Exception('Invalid plan JSON: ' . json_last_error_msg());
        }

        $slugify = static function (string $s): string {
            $s = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '_', $s), '_'));
            return substr($s, 0, 48);
        };

        $appName = trim((string) ($data['app']['name'] ?? ''));
        if ($appName === '') {
            throw new \Exception('Plan has no app name');
        }

        $forms = [];
        $keys = [];
        foreach (array_slice(is_array($data['forms'] ?? null) ? $data['forms'] : [], 0, $maxForms) as $f) {
            if (!is_array($f)) {
                continue;
            }
            $key = $slugify((string) ($f['key'] ?? $f['title'] ?? ''));
            $title = trim((string) ($f['title'] ?? ''));
            if ($key === '' || $title === '' || in_array($key, $keys, true)) {
                continue;
            }
            $keys[] = $key;
            $forms[] = [
                'key' => $key,
                'title' => $title,
                'purpose' => trim((string) ($f['purpose'] ?? '')),
                'screen' => trim((string) ($f['screen'] ?? '')),
            ];
        }
        if (empty($forms)) {
            throw new \Exception('Plan produced no usable forms');
        }

        $relations = [];
        foreach (is_array($data['relations'] ?? null) ? $data['relations'] : [] as $r) {
            if (!is_array($r)) {
                continue;
            }
            $from = $slugify((string) ($r['from'] ?? ''));
            $to = $slugify((string) ($r['to'] ?? ''));
            if ($from === $to || !in_array($from, $keys, true) || !in_array($to, $keys, true)) {
                continue;
            }
            $relations[] = ['from' => $from, 'to' => $to, 'label' => trim((string) ($r['label'] ?? 'Linked record')) ?: 'Linked record'];
        }

        $roles = [];
        foreach (is_array($data['roles'] ?? null) ? $data['roles'] : [] as $r) {
            if (!is_array($r) || trim((string) ($r['name'] ?? '')) === '') {
                continue;
            }
            $level = strtolower((string) ($r['level'] ?? 'viewer'));
            if (!in_array($level, ['admin', 'contributor', 'viewer'], true)) {
                $level = 'viewer';
            }
            $roles[] = ['name' => trim((string) $r['name']), 'level' => $level];
        }

        return [
            'app' => ['name' => $appName, 'description' => trim((string) ($data['app']['description'] ?? ''))],
            'forms' => $forms,
            'relations' => $relations,
            'roles' => $roles,
        ];
    }

    /**
     * Make a chat completion request to the API
     */
    private function chatCompletion(array $messages, ?string $model = null, int $maxTokens = 4096): string
    {
        if (!$this->isEnabled()) {
            throw new \Exception('The in-app AI is disabled (AI_ENABLED=false). Use an external AI via the MCP server instead.');
        }
        if (!$this->isConfigured()) {
            throw new \Exception('AI service is not configured. Set AI_BASE_URL (and AI_API_KEY if your provider requires one).');
        }

        $model = $model ?? $this->model;

        $payload = [
            'model' => $model,
            'messages' => $messages,
            'temperature' => 0.7,
            'max_tokens' => $maxTokens,
        ];

        // Only send Authorization when a key is set — keyless local servers (LM Studio / Ollama)
        // can reject or mishandle an empty bearer token.
        $headers = ['Content-Type: application/json'];
        if ($this->apiKey !== '') {
            $headers[] = 'Authorization: Bearer ' . $this->apiKey;
        }

        $ch = curl_init($this->apiUrl . '/chat/completions');
        $aiCurlOpts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_TIMEOUT => 120,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ];
        // Vendored CA bundle fallback (only when the operator hasn't configured
        // their own curl.cainfo / CURL_CA_BUNDLE — don't override a private CA).
        $caBundle = __DIR__ . '/../../resources/cacert.pem';
        if (!ini_get('curl.cainfo') && !getenv('CURL_CA_BUNDLE') && is_file($caBundle)) {
            $aiCurlOpts[CURLOPT_CAINFO] = $caBundle;
        }
        curl_setopt_array($ch, $aiCurlOpts);

        try {
            $response = curl_exec($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $error = curl_error($ch);
        } finally {
            curl_close($ch);
        }

        if ($response === false || $error) {
            throw new \Exception('API request failed: ' . ($error ?: 'curl_exec returned false'));
        }

        if ($httpCode !== 200) {
            $errorData = json_decode($response, true);
            $errorMessage = $errorData['error']['message'] ?? 'Unknown error';
            throw new \Exception('API error (' . $httpCode . '): ' . $errorMessage);
        }

        $data = json_decode($response, true);

        if (!isset($data['choices'][0]['message']['content'])) {
            throw new \Exception('Invalid API response format');
        }

        return $data['choices'][0]['message']['content'];
    }

    /**
     * Get the system prompt for form generation
     */
    private function getFormGenerationSystemPrompt(): string
    {
        return <<<'PROMPT'
You are a form builder AI assistant. Your task is to generate form field definitions based on user requests or document analysis.

You must respond with a valid JSON object in this exact format:
{
  "title": "Form Title",
  "description": "Optional form description",
  "fields": [
    {
      "type": "field_type",
      "label": "Field Label",
      "description": "Optional help text",
      "placeholder": "Optional placeholder",
      "required": true,
      "properties": {}
    }
  ],
  "needsScript": false,
  "suggestedScript": ""
}

Available field types:
- "short_text": Single line text input
- "long_text": Multi-line textarea
- "email": Email address input
- "phone": Phone number input
- "number": Numeric input
- "url": URL input
- "date": Date picker
- "time": Time picker
- "datetime": Date and time picker
- "dropdown": Single select dropdown (requires options in properties)
- "multiple_choice": Radio button selection (requires options in properties)
- "checkboxes": Multiple select checkboxes (requires options in properties)
- "rating": Star rating (properties: { "maxStars": 5 })
- "scale": Numeric scale (properties: { "scaleStart": 1, "scaleEnd": 10, "scaleStartLabel": "", "scaleEndLabel": "" })
- "file_upload": File upload
- "signature": Signature pad
- "statement": Read-only text block (no input)

For dropdown, multiple_choice, and checkboxes, include options like:
{
  "type": "dropdown",
  "label": "Select Option",
  "properties": {
    "options": [
      { "label": "Option 1", "value": "option_1" },
      { "label": "Option 2", "value": "option_2" }
    ]
  }
}

Guidelines:
- Create logical, user-friendly field labels
- Add helpful descriptions for complex fields
- Mark fields as required when appropriate
- Use the most appropriate field type for each input
- Group related fields logically
- Add placeholders to guide users
- For scale fields, add meaningful start/end labels
- Extract ALL fields visible in documents/images
- Set "needsScript" to true ONLY if the form genuinely needs backend logic on submit — e.g.
  cross-field validation beyond simple field types, computed/derived values, conditional status or
  routing, scoring, anti-spam / duplicate checks, or notifications. For a plain data-collection form
  (contact, RSVP, basic survey with no computed outcome), set "needsScript" to false.
- When "needsScript" is true, put a concise plain-language description of that logic in
  "suggestedScript" (what to validate/compute/route, naming the relevant fields). Otherwise leave it "".

Respond ONLY with the JSON object, no additional text.
PROMPT;
    }

    /**
     * Get the system prompt for script generation
     */
    private function getScriptGenerationSystemPrompt(array $formFields, string $exampleScript = ''): string
    {
        $fieldsList = "";
        foreach ($formFields as $field) {
            $fieldsList .= "- {$field['id']}: {$field['label']} ({$field['type']})\n";
        }

        // A field-grounded starter the client generated for THIS form. Giving it to the
        // model anchors it to the real field IDs and the correct ctx API shape.
        $starterSection = '';
        if (trim($exampleScript) !== '') {
            $starterSection = "\nHere is a starter script already wired to this form's fields. Use it as a reference for the correct API shape and the exact field IDs, then adapt it to the request (don't just return it unchanged):\n```\n{$exampleScript}\n```\n";
        }

        return <<<PROMPT
You are a backend script generator for FormLogic forms. Generate safe, sandboxed scripts that run on form submission.

The form has these fields:
{$fieldsList}
{$starterSection}
Your script must follow this structure:
```
function onSubmit(ctx) {
    // Your logic here

    // Optionally return rejection:
    // return { reject: true, message: "Reason" };

    // Or return computed values:
    // return { score: 100, category: "premium" };
}
```

Available APIs in ctx:

1. ctx.answers - Read-only form answers
   - Access field values: ctx.answers.fieldId
   - Example: ctx.answers.email, ctx.answers.age

2. ctx.meta - Submission metadata
   - ctx.meta.ip - Client IP address
   - ctx.meta.userAgent - Browser user agent
   - ctx.meta.timestamp - Submission timestamp (seconds)
   - ctx.meta.responseId - Unique response ID
   - ctx.meta.formId - Form ID

3. ctx.db - Database operations
   - ctx.db.setField(name, value) - Store computed field
   - ctx.db.setStatus(status) - Set response status: "submitted", "reviewed", "approved", "rejected", "spam", "archived"
   - ctx.db.addTag(tag) - Add a tag to the response
   - ctx.db.getField(name) - Get a previously set computed field

4. ctx.utils - Utility functions
   - ctx.utils.uuid() - Generate a UUID
   - ctx.utils.now() - Current timestamp (seconds)
   - ctx.utils.hash(value) - SHA-256 hash

5. ctx.http - HTTP requests (use sparingly)
   - ctx.http.post(url, data, options) - POST request
   - ctx.http.get(url, options) - GET request
   - Options: { headers: {}, bearerToken: "..." }

IMPORTANT RULES:
1. NEVER use while(true) or infinite loops
2. Keep logic simple and efficient
3. Always validate data before using
4. Use ctx.db.setField for computed values
5. Use ctx.db.addTag for categorization
6. Return { reject: true, message: "..." } to reject submissions
7. Don't access external URLs unless explicitly requested
8. Field IDs might contain underscores or be camelCase

Respond with a JSON object:
{
  "script": "function onSubmit(ctx) { ... }",
  "explanation": "Brief explanation of what the script does"
}

Respond ONLY with the JSON object, no additional text.
PROMPT;
    }

    /**
     * Parse and validate the form generation response
     */
    private function parseFormResponse(string $response): array
    {
        // Extract JSON from response (in case there's extra text)
        $jsonMatch = preg_match('/\{[\s\S]*\}/', $response, $matches);
        if (!$jsonMatch) {
            throw new \Exception('Could not parse AI response as JSON');
        }

        $data = json_decode($matches[0], true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new \Exception('Invalid JSON in AI response: ' . json_last_error_msg());
        }

        // Validate structure
        if (!isset($data['fields']) || !is_array($data['fields'])) {
            throw new \Exception('AI response missing fields array');
        }

        // Validate and normalize fields
        $validTypes = [
            'short_text', 'long_text', 'email', 'phone', 'number', 'url',
            'date', 'time', 'datetime', 'dropdown', 'multiple_choice',
            'checkboxes', 'rating', 'scale', 'file_upload', 'signature',
            'statement', 'welcome_screen', 'thank_you', 'calculated', 'hidden'
        ];

        $normalizedFields = [];
        foreach ($data['fields'] as $index => $field) {
            if (!isset($field['type']) || !isset($field['label'])) {
                continue; // Skip invalid fields
            }

            // Normalize type
            $type = strtolower(str_replace([' ', '-'], '_', $field['type']));
            if (!in_array($type, $validTypes)) {
                $type = 'short_text'; // Default fallback
            }

            $normalizedFields[] = [
                'id' => $field['id'] ?? $this->generateFieldId($field['label']),
                'type' => $type,
                'label' => $field['label'],
                'description' => $field['description'] ?? '',
                'placeholder' => $field['placeholder'] ?? '',
                'required' => $field['required'] ?? false,
                'properties' => $this->normalizeProperties($field['properties'] ?? [], $type),
            ];
        }

        return [
            'title' => $data['title'] ?? 'Untitled Form',
            'description' => $data['description'] ?? '',
            'fields' => $normalizedFields,
            'needsScript' => (bool) ($data['needsScript'] ?? false),
            'suggestedScript' => $data['suggestedScript'] ?? null,
        ];
    }

    /**
     * Parse and validate the script generation response
     */
    private function parseScriptResponse(string $response): array
    {
        // Extract JSON from response
        $jsonMatch = preg_match('/\{[\s\S]*\}/', $response, $matches);
        if (!$jsonMatch) {
            throw new \Exception('Could not parse AI response as JSON');
        }

        $data = json_decode($matches[0], true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new \Exception('Invalid JSON in AI response: ' . json_last_error_msg());
        }

        if (!isset($data['script'])) {
            throw new \Exception('AI response missing script');
        }

        // Basic safety checks on the script
        $script = $data['script'];
        $this->validateScriptSafety($script);

        return [
            'script' => $script,
            'explanation' => $data['explanation'] ?? 'No explanation provided',
        ];
    }

    /**
     * Validate script for obvious safety issues
     */
    private function validateScriptSafety(string $script): void
    {
        $dangerousPatterns = [
            '/while\s*\(\s*true\s*\)/' => 'Infinite while loop detected',
            '/for\s*\(\s*;\s*;\s*\)/' => 'Infinite for loop detected',
            '/eval\s*\(/' => 'eval() is not allowed',
            '/Function\s*\(/' => 'Function constructor is not allowed',
        ];

        foreach ($dangerousPatterns as $pattern => $message) {
            if (preg_match($pattern, $script)) {
                throw new \Exception('Unsafe script: ' . $message);
            }
        }
    }

    /**
     * Validate an image URL to prevent SSRF and other attacks.
     * Only allows HTTPS URLs with valid hostnames.
     *
     * @param string $url The URL to validate
     * @return string|null The validated URL or null if invalid
     */
    private function validateImageUrl(string $url): ?string
    {
        // Parse the URL
        $parsed = parse_url($url);
        if ($parsed === false || !isset($parsed['host'])) {
            return null;
        }

        // Only allow HTTPS (or HTTP in development)
        $allowedSchemes = ['https'];
        if (($_ENV['APP_ENV'] ?? 'development') !== 'production') {
            $allowedSchemes[] = 'http';
        }

        if (!isset($parsed['scheme']) || !in_array(strtolower($parsed['scheme']), $allowedSchemes, true)) {
            return null;
        }

        $host = strtolower($parsed['host']);

        // Block localhost and private IP ranges
        $blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
        if (in_array($host, $blockedHosts, true)) {
            return null;
        }

        // Check if it's an IP address and block private ranges
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            // Block private and reserved IP ranges
            if (!filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                return null;
            }
        }

        // Block common internal hostnames
        $internalPatterns = [
            '/\.local$/',
            '/\.internal$/',
            '/\.localhost$/',
            '/^10\.\d+\.\d+\.\d+$/',
            '/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/',
            '/^192\.168\.\d+\.\d+$/',
        ];

        foreach ($internalPatterns as $pattern) {
            if (preg_match($pattern, $host)) {
                return null;
            }
        }

        // Resolve the hostname and reject if ANY resolved address is private /
        // reserved / loopback / link-local. Without this, a public hostname that
        // resolves to an internal IP (or cloud metadata 169.254.169.254) bypasses
        // the literal-IP checks above (SSRF).
        if (!filter_var($host, FILTER_VALIDATE_IP)) {
            $ips = $this->resolveAllIps($host);
            if (empty($ips)) {
                return null;
            }
            foreach ($ips as $ip) {
                if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                    return null;
                }
            }
        }

        // Return the validated URL
        return $url;
    }

    /**
     * Resolve a hostname to all of its A (IPv4) and AAAA (IPv6) addresses.
     */
    private function resolveAllIps(string $host): array
    {
        $ips = [];
        $v4 = @gethostbynamel($host);
        if (is_array($v4)) {
            $ips = array_merge($ips, $v4);
        }
        $v6 = @dns_get_record($host, DNS_AAAA);
        if (is_array($v6)) {
            foreach ($v6 as $rec) {
                if (!empty($rec['ipv6'])) {
                    $ips[] = $rec['ipv6'];
                }
            }
        }
        return array_values(array_unique($ips));
    }

    /**
     * Generate a field ID from a label
     */
    private function generateFieldId(string $label): string
    {
        $id = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '_', $label));
        $id = trim($id, '_');
        return $id ?: 'field_' . substr(md5($label), 0, 8);
    }

    /**
     * Normalize field properties based on type
     */
    private function normalizeProperties(array $properties, string $type): array
    {
        $normalized = [];

        switch ($type) {
            case 'dropdown':
            case 'multiple_choice':
            case 'checkboxes':
                if (isset($properties['options']) && is_array($properties['options'])) {
                    $normalized['options'] = [];
                    foreach ($properties['options'] as $index => $option) {
                        if (is_string($option)) {
                            $normalized['options'][] = [
                                'id' => 'opt_' . $index,
                                'label' => $option,
                                'value' => strtolower(preg_replace('/[^a-zA-Z0-9]+/', '_', $option))
                            ];
                        } elseif (is_array($option)) {
                            $normalized['options'][] = [
                                'id' => $option['id'] ?? 'opt_' . $index,
                                'label' => $option['label'] ?? $option['value'] ?? 'Option ' . ($index + 1),
                                'value' => $option['value'] ?? strtolower(preg_replace('/[^a-zA-Z0-9]+/', '_', $option['label'] ?? ''))
                            ];
                        }
                    }
                }
                break;

            case 'rating':
                $normalized['maxStars'] = $properties['maxStars'] ?? 5;
                break;

            case 'scale':
                $normalized['scaleStart'] = $properties['scaleStart'] ?? 1;
                $normalized['scaleEnd'] = $properties['scaleEnd'] ?? 10;
                $normalized['scaleStartLabel'] = $properties['scaleStartLabel'] ?? '';
                $normalized['scaleEndLabel'] = $properties['scaleEndLabel'] ?? '';
                break;

            case 'file_upload':
                $normalized['allowMultiple'] = $properties['allowMultiple'] ?? false;
                $normalized['maxFileSize'] = $properties['maxFileSize'] ?? 10485760; // 10MB
                $normalized['acceptedFileTypes'] = $properties['acceptedFileTypes'] ?? [];
                break;
        }

        return $normalized;
    }

    /**
     * Detect MIME type from base64 image data
     */
    private function detectImageMimeType(string $base64): string
    {
        $decoded = base64_decode(substr($base64, 0, 16));

        if (str_starts_with($decoded, "\xFF\xD8\xFF")) {
            return 'image/jpeg';
        }
        if (str_starts_with($decoded, "\x89PNG")) {
            return 'image/png';
        }
        if (str_starts_with($decoded, "GIF")) {
            return 'image/gif';
        }
        if (str_starts_with($decoded, "RIFF") && substr($decoded, 8, 4) === 'WEBP') {
            return 'image/webp';
        }

        return 'image/png'; // Default fallback
    }
}
