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
        $this->apiKey = $_ENV['OPENAI_API_KEY'] ?? '';
        $this->apiUrl = $_ENV['OPENAI_API_URL'] ?? 'https://api.openai.com/v1';
        $this->model = $_ENV['OPENAI_MODEL'] ?? 'gpt-4o';
        $this->visionModel = $_ENV['OPENAI_VISION_MODEL'] ?? 'gpt-4o';
    }

    /**
     * Check if AI service is configured
     */
    public function isConfigured(): bool
    {
        return !empty($this->apiKey);
    }

    /**
     * Generate form fields from a text prompt
     */
    public function generateFormFromPrompt(string $prompt): array
    {
        $systemPrompt = $this->getFormGenerationSystemPrompt();

        $response = $this->chatCompletion([
            [
                'role' => 'system',
                'content' => $systemPrompt
            ],
            [
                'role' => 'user',
                'content' => "Create a form based on this description:\n\n" . $prompt
            ]
        ]);

        return $this->parseFormResponse($response);
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
    public function generateScript(string $prompt, array $formFields): array
    {
        $systemPrompt = $this->getScriptGenerationSystemPrompt($formFields);

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
            throw new \Exception('AI service is not configured. Please set OPENAI_API_KEY.');
        }

        $model = $model ?? $this->model;

        $payload = [
            'model' => $model,
            'messages' => $messages,
            'temperature' => 0.7,
            'max_tokens' => 4096,
        ];

        $ch = curl_init($this->apiUrl . '/chat/completions');
        $aiCurlOpts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $this->apiKey,
            ],
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
  "suggestedScript": "Optional: describe any logic that might be useful"
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

Respond ONLY with the JSON object, no additional text.
PROMPT;
    }

    /**
     * Get the system prompt for script generation
     */
    private function getScriptGenerationSystemPrompt(array $formFields): string
    {
        $fieldsList = "";
        foreach ($formFields as $field) {
            $fieldsList .= "- {$field['id']}: {$field['label']} ({$field['type']})\n";
        }

        return <<<PROMPT
You are a backend script generator for FormLogic forms. Generate safe, sandboxed scripts that run on form submission.

The form has these fields:
{$fieldsList}

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
            'statement', 'welcome_screen', 'thank_you', 'calculated'
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
