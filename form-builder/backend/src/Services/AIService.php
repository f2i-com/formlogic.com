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
        return $this->apiKey !== '' || $this->isCustomEndpoint();
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
     * Make a chat completion request to the API
     */
    private function chatCompletion(array $messages, ?string $model = null): string
    {
        if (!$this->isConfigured()) {
            throw new \Exception('AI service is not configured. Set AI_BASE_URL (and AI_API_KEY if your provider requires one).');
        }

        $model = $model ?? $this->model;

        $payload = [
            'model' => $model,
            'messages' => $messages,
            'temperature' => 0.7,
            'max_tokens' => 4096,
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
