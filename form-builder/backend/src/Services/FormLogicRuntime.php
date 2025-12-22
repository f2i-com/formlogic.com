<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Lang\FormLogicEngine;
use FormLogic\Lang\ExecutionLimitException;
use FormLogic\Lang\Objects\{
    BaseObject, HashObject, StringObject, IntegerObject, FloatObject,
    BooleanObject, NullObject, ArrayObject, BuiltinObject
};
use function FormLogic\Lang\Objects\{nullObject, trueObject, falseObject, getValue, nativeToObject};

/**
 * Sandboxed runtime for executing FormLogic scripts on form submissions
 *
 * Scripts must define an `onSubmit(ctx)` function that receives:
 * - ctx.answers: Read-only form answers (HashObject)
 * - ctx.meta: Submission metadata { ip, userAgent, timestamp, responseId, formId }
 * - ctx.db: Database operations { setField, setStatus, addTag, getField }
 * - ctx.utils: Utility functions { uuid, now, nowMs, hash, formatDate }
 * - ctx.http: HTTP requests { get, post, put, delete, request }
 *
 * Scripts can return:
 * - { reject: true, message: 'reason' } to reject the submission
 * - Any other value as computed result
 */
class FormLogicRuntime
{
    private int $maxInstructions;
    private int $maxWallTimeMs;
    private int $maxCallDepth;

    public function __construct(array $config = [])
    {
        $this->maxInstructions = $config['maxInstructions'] ?? 50000;
        $this->maxWallTimeMs = $config['maxWallTimeMs'] ?? 2000;
        $this->maxCallDepth = $config['maxCallDepth'] ?? 100;
    }

    /**
     * Execute a script with the given context
     *
     * @param string $script User-provided FormLogic script
     * @param array $context Execution context with keys: answers, ipAddress, userAgent, timestamp, responseId, formId
     * @return ScriptResult
     */
    public function execute(string $script, array $context): ScriptResult
    {
        $startTime = microtime(true);

        // Create a fresh engine instance
        $engine = new FormLogicEngine();
        $engine->setLimits($this->maxInstructions, $this->maxWallTimeMs, $this->maxCallDepth);

        // Create the database context capture
        $dbCapture = new DbContextCapture();

        // Register the ctx.db module
        $this->registerDbModule($engine, $dbCapture);

        // Register the ctx.utils module
        $this->registerUtilsModule($engine);

        // Register the ctx.http module
        $this->registerHttpModule($engine);

        try {
            // Validate script safety before execution
            $this->validateScriptSafety($script);

            // Build the execution wrapper code
            $wrapperCode = $this->buildWrapperCode($script, $context);

            // Execute the script
            $result = $engine->run($wrapperCode);
            $nativeResult = getValue($result);

            $instructionCount = $engine->getInstructionCount();
            $executionTimeMs = (int)((microtime(true) - $startTime) * 1000);

            // Check for rejection
            if (is_array($nativeResult) && ($nativeResult['reject'] ?? false) === true) {
                $message = $nativeResult['message'] ?? 'Submission rejected';
                return ScriptResult::rejection($message, $instructionCount, $executionTimeMs);
            }

            // Build successful result
            return ScriptResult::success(
                computed: $nativeResult,
                fields: $dbCapture->getFields(),
                tags: $dbCapture->getTags(),
                status: $dbCapture->getStatus(),
                instructionCount: $instructionCount,
                executionTimeMs: $executionTimeMs,
            );

        } catch (ExecutionLimitException $e) {
            $executionTimeMs = (int)((microtime(true) - $startTime) * 1000);
            return ScriptResult::error(
                "Script execution limit exceeded: {$e->getMessage()}",
                $engine->getInstructionCount(),
                $executionTimeMs,
            );

        } catch (\Throwable $e) {
            $executionTimeMs = (int)((microtime(true) - $startTime) * 1000);
            return ScriptResult::error(
                "Script execution error: {$e->getMessage()}",
                $engine->getInstructionCount(),
                $executionTimeMs,
            );
        }
    }

    /**
     * Register the ctx.db module for database operations
     */
    private function registerDbModule(FormLogicEngine $engine, DbContextCapture $capture): void
    {
        $engine->registerModule('__db', [
            'setField' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 2) {
                    return falseObject();
                }
                $name = getValue($args[0]);
                $value = getValue($args[1]);
                if (!is_string($name)) {
                    return falseObject();
                }
                return $capture->setField($name, $value) ? trueObject() : falseObject();
            },
            'getField' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 1) {
                    return nullObject();
                }
                $name = getValue($args[0]);
                if (!is_string($name)) {
                    return nullObject();
                }
                $value = $capture->getField($name);
                return $value !== null ? nativeToObject($value) : nullObject();
            },
            'setStatus' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 1) {
                    return falseObject();
                }
                $status = getValue($args[0]);
                if (!is_string($status)) {
                    return falseObject();
                }
                return $capture->setStatus($status) ? trueObject() : falseObject();
            },
            'addTag' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 1) {
                    return falseObject();
                }
                $tag = getValue($args[0]);
                if (!is_string($tag)) {
                    return falseObject();
                }
                return $capture->addTag($tag) ? trueObject() : falseObject();
            },
        ]);
    }

    /**
     * Register the ctx.utils module for utility functions
     */
    private function registerUtilsModule(FormLogicEngine $engine): void
    {
        $engine->registerModule('__utils', [
            'uuid' => function (array $args): BaseObject {
                return new StringObject($this->generateUuid());
            },
            'now' => function (array $args): BaseObject {
                return new IntegerObject(time());
            },
            'nowMs' => function (array $args): BaseObject {
                return new IntegerObject((int)(microtime(true) * 1000));
            },
            'hash' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return new StringObject('');
                }
                $value = getValue($args[0]);
                $algo = count($args) >= 2 ? getValue($args[1]) : 'sha256';
                if (!is_string($algo) || !in_array($algo, ['md5', 'sha1', 'sha256', 'sha512'], true)) {
                    $algo = 'sha256';
                }
                return new StringObject(hash($algo, (string)$value));
            },
            'formatDate' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return new StringObject('');
                }
                $timestamp = getValue($args[0]);
                $format = count($args) >= 2 ? getValue($args[1]) : 'Y-m-d H:i:s';
                if (!is_numeric($timestamp)) {
                    return new StringObject('');
                }
                // Handle milliseconds
                if ($timestamp > 10000000000) {
                    $timestamp = (int)($timestamp / 1000);
                }
                return new StringObject(date((string)$format, (int)$timestamp));
            },
        ]);
    }

    /**
     * Register the ctx.http module for HTTP requests
     *
     * Provides methods for making HTTP requests to external APIs:
     * - get(url, options?) - GET request
     * - post(url, data?, options?) - POST request
     * - put(url, data?, options?) - PUT request
     * - delete(url, options?) - DELETE request
     * - request(options) - Generic request with full control
     *
     * Options object can include:
     * - headers: object of header key-value pairs
     * - bearerToken: string for Bearer authentication
     * - timeout: request timeout in seconds (default 10, max 30)
     * - body: request body (for request method)
     * - method: HTTP method (for request method)
     * - url: request URL (for request method)
     */
    private function registerHttpModule(FormLogicEngine $engine): void
    {
        $engine->registerModule('__http', [
            'get' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $options = count($args) >= 2 ? getValue($args[1]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('GET', $url, null, is_array($options) ? $options : []);
            },

            'post' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $data = count($args) >= 2 ? getValue($args[1]) : null;
                $options = count($args) >= 3 ? getValue($args[2]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('POST', $url, $data, is_array($options) ? $options : []);
            },

            'put' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $data = count($args) >= 2 ? getValue($args[1]) : null;
                $options = count($args) >= 3 ? getValue($args[2]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('PUT', $url, $data, is_array($options) ? $options : []);
            },

            'delete' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $options = count($args) >= 2 ? getValue($args[1]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('DELETE', $url, null, is_array($options) ? $options : []);
            },

            'patch' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $data = count($args) >= 2 ? getValue($args[1]) : null;
                $options = count($args) >= 3 ? getValue($args[2]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('PATCH', $url, $data, is_array($options) ? $options : []);
            },

            'request' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('Options object is required');
                }
                $options = getValue($args[0]);
                if (!is_array($options)) {
                    return $this->httpErrorResponse('Options must be an object');
                }

                $method = strtoupper($options['method'] ?? 'GET');
                $url = $options['url'] ?? null;
                $body = $options['body'] ?? null;

                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL is required');
                }
                if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], true)) {
                    return $this->httpErrorResponse('Invalid HTTP method');
                }

                return $this->executeHttpRequest($method, $url, $body, $options);
            },
        ]);
    }

    /**
     * Execute an HTTP request using cURL
     */
    private function executeHttpRequest(string $method, string $url, mixed $body, array $options): BaseObject
    {
        // Validate URL
        if (!filter_var($url, FILTER_VALIDATE_URL)) {
            return $this->httpErrorResponse('Invalid URL format');
        }

        // Security: Block private IP ranges and localhost
        $host = parse_url($url, PHP_URL_HOST);
        if ($host === false || $host === null) {
            return $this->httpErrorResponse('Invalid URL');
        }
        if ($this->isPrivateHost($host)) {
            return $this->httpErrorResponse('Requests to private/local addresses are not allowed');
        }

        // Build headers
        $headers = ['Accept: application/json'];
        $contentType = 'application/json';

        // Add custom headers
        if (isset($options['headers']) && is_array($options['headers'])) {
            foreach ($options['headers'] as $key => $value) {
                if (is_string($key) && (is_string($value) || is_numeric($value))) {
                    // Prevent host header override
                    if (strtolower($key) !== 'host') {
                        $headers[] = "{$key}: {$value}";
                        if (strtolower($key) === 'content-type') {
                            $contentType = (string)$value;
                        }
                    }
                }
            }
        }

        // Add Bearer token if provided
        if (isset($options['bearerToken']) && is_string($options['bearerToken'])) {
            $headers[] = 'Authorization: Bearer ' . $options['bearerToken'];
        }

        // Set content type if not already set and we have a body
        if ($body !== null && !$this->hasHeader($headers, 'content-type')) {
            $headers[] = 'Content-Type: ' . $contentType;
        }

        // Prepare body
        $bodyString = null;
        if ($body !== null) {
            if (is_string($body)) {
                $bodyString = $body;
            } else {
                $bodyString = json_encode($body);
            }
        }

        // Timeout (default 10 seconds, max 30)
        $timeout = 10;
        if (isset($options['timeout']) && is_numeric($options['timeout'])) {
            $timeout = min(30, max(1, (int)$options['timeout']));
        }

        // Execute request with cURL
        $ch = curl_init();

        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HEADER => true,
            // Security settings
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            // Prevent SSRF via redirects
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
        ]);

        if ($bodyString !== null && in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $bodyString);
        }

        $response = curl_exec($ch);
        $error = curl_error($ch);
        $errno = curl_errno($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);

        curl_close($ch);

        // Handle cURL errors
        if ($errno !== 0) {
            return $this->httpErrorResponse("Request failed: {$error}");
        }

        // Parse response
        $responseHeaders = substr($response, 0, $headerSize);
        $responseBody = substr($response, $headerSize);

        // Try to parse JSON response
        $data = json_decode($responseBody, true);
        $isJson = json_last_error() === JSON_ERROR_NONE;

        // Build response object
        return nativeToObject([
            'ok' => $httpCode >= 200 && $httpCode < 300,
            'status' => $httpCode,
            'statusText' => $this->getHttpStatusText($httpCode),
            'headers' => $this->parseResponseHeaders($responseHeaders),
            'body' => $responseBody,
            'data' => $isJson ? $data : null,
            'json' => $isJson,
        ]);
    }

    /**
     * Create an error response object
     */
    private function httpErrorResponse(string $message): BaseObject
    {
        return nativeToObject([
            'ok' => false,
            'status' => 0,
            'statusText' => 'Error',
            'headers' => [],
            'body' => '',
            'data' => null,
            'json' => false,
            'error' => $message,
        ]);
    }

    /**
     * Check if a host is private/local (SSRF protection)
     */
    private function isPrivateHost(string $host): bool
    {
        // Check for localhost variants
        $host = strtolower($host);
        if (in_array($host, ['localhost', '127.0.0.1', '::1', '0.0.0.0'], true)) {
            return true;
        }

        // Resolve hostname to IP
        $ip = gethostbyname($host);
        if ($ip === $host) {
            // Could not resolve, allow (might be external)
            return false;
        }

        // Check for private IP ranges
        $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
        if (filter_var($ip, FILTER_VALIDATE_IP, $flags) === false) {
            return true;
        }

        return false;
    }

    /**
     * Check if a header already exists in the headers array
     */
    private function hasHeader(array $headers, string $name): bool
    {
        $name = strtolower($name);
        foreach ($headers as $header) {
            if (str_starts_with(strtolower($header), $name . ':')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Parse response headers into an associative array
     */
    private function parseResponseHeaders(string $headerString): array
    {
        $headers = [];
        $lines = explode("\r\n", $headerString);
        foreach ($lines as $line) {
            if (str_contains($line, ':')) {
                [$key, $value] = explode(':', $line, 2);
                $headers[strtolower(trim($key))] = trim($value);
            }
        }
        return $headers;
    }

    /**
     * Get HTTP status text for a status code
     */
    private function getHttpStatusText(int $code): string
    {
        $statusTexts = [
            200 => 'OK',
            201 => 'Created',
            202 => 'Accepted',
            204 => 'No Content',
            301 => 'Moved Permanently',
            302 => 'Found',
            304 => 'Not Modified',
            400 => 'Bad Request',
            401 => 'Unauthorized',
            403 => 'Forbidden',
            404 => 'Not Found',
            405 => 'Method Not Allowed',
            409 => 'Conflict',
            422 => 'Unprocessable Entity',
            429 => 'Too Many Requests',
            500 => 'Internal Server Error',
            502 => 'Bad Gateway',
            503 => 'Service Unavailable',
        ];
        return $statusTexts[$code] ?? 'Unknown';
    }

    /**
     * Validate script doesn't try to override reserved names
     * @throws \Exception if reserved names are used
     */
    private function validateScriptSafety(string $script): void
    {
        // Reserved module/builtin names that scripts cannot override
        $reservedNames = [
            '__db', '__utils', '__http', '__meta', '__answers',
            'ctx', // The context object itself
        ];

        // Check for attempts to reassign reserved names
        // This catches patterns like: let __db = ..., const __db = ..., var __db = ..., __db = ...
        foreach ($reservedNames as $name) {
            // Check for variable declarations
            $patterns = [
                '/\b(let|const|var)\s+' . preg_quote($name, '/') . '\b/',  // let __db, const __db, var __db
                '/\b' . preg_quote($name, '/') . '\s*=(?!=)/',              // __db = (but not __db ==)
            ];

            foreach ($patterns as $pattern) {
                if (preg_match($pattern, $script)) {
                    throw new \Exception("Cannot override reserved name: {$name}");
                }
            }
        }

        // Also check for dangerous patterns
        $dangerousPatterns = [
            '/\beval\s*\(/' => 'eval() is not allowed',
            '/\bFunction\s*\(/' => 'Function constructor is not allowed',
            '/\bwhile\s*\(\s*true\s*\)/' => 'Infinite while loop detected',
            '/\bfor\s*\(\s*;\s*;\s*\)/' => 'Infinite for loop detected',
        ];

        foreach ($dangerousPatterns as $pattern => $message) {
            if (preg_match($pattern, $script)) {
                throw new \Exception("Unsafe script: {$message}");
            }
        }
    }

    /**
     * Build the wrapper code that sets up context and calls onSubmit
     */
    private function buildWrapperCode(string $script, array $context): string
    {
        // Build the answers object
        $answers = $context['answers'] ?? [];
        $answersCode = $this->phpValueToFormLogicCode($answers);

        // Build the meta object
        $meta = [
            'ip' => $context['ipAddress'] ?? null,
            'userAgent' => $context['userAgent'] ?? null,
            'timestamp' => $context['timestamp'] ?? time(),
            'responseId' => $context['responseId'] ?? null,
            'formId' => $context['formId'] ?? null,
        ];
        $metaCode = $this->phpValueToFormLogicCode($meta);

        // Create the wrapper code
        // This creates a ctx object with answers, meta, db, and utils
        // Then it includes the user script and calls onSubmit(ctx)
        // Note: We assign modules directly instead of wrapping them in closures
        // to avoid issues with method call context being prepended to arguments
        return <<<FORMLOGIC
// Create the context object
let ctx = {
    answers: {$answersCode},
    meta: {$metaCode},
    db: __db,
    utils: __utils,
    http: __http,
};

// User script starts here
{$script}
// User script ends here

// Call the onSubmit function if it exists
typeof onSubmit === "function" ? onSubmit(ctx) : null
FORMLOGIC;
    }

    /**
     * Convert a PHP value to FormLogic code
     */
    private function phpValueToFormLogicCode(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value) || is_float($value)) {
            return (string)$value;
        }
        if (is_string($value)) {
            // Escape string safely
            $escaped = json_encode($value, JSON_UNESCAPED_UNICODE);
            return $escaped !== false ? $escaped : '""';
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                // Indexed array
                $items = array_map(fn($v) => $this->phpValueToFormLogicCode($v), $value);
                return '[' . implode(', ', $items) . ']';
            } else {
                // Associative array (object)
                $pairs = [];
                foreach ($value as $k => $v) {
                    $keyStr = json_encode((string)$k, JSON_UNESCAPED_UNICODE);
                    if ($keyStr === false) {
                        $keyStr = '""';
                    }
                    $pairs[] = $keyStr . ': ' . $this->phpValueToFormLogicCode($v);
                }
                return '{' . implode(', ', $pairs) . '}';
            }
        }
        return 'null';
    }

    /**
     * Generate a UUID v4
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
