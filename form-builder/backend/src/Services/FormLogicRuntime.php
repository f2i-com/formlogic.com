<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Sandboxed runtime for executing FormLogic scripts on form submissions.
 *
 * Scripts must define an `onSubmit(ctx)` function that receives:
 * - ctx.answers: Read-only form answers
 * - ctx.meta: Submission metadata { ip, userAgent, timestamp, responseId, formId }
 * - ctx.db: Database operations { setField, getField, setStatus, addTag }
 * - ctx.utils: Utility functions { uuid, now, nowMs, hash, formatDate }
 * - ctx.http: HTTP requests { get, post, put, patch, delete, request }
 *
 * Scripts can return:
 * - { reject: true, message: 'reason' } to reject the submission
 * - Any other value as the computed result
 *
 * Execution happens inside the QuickJS sandbox (via {@see QuickJsRunner} and the
 * vendored static qjs binary) — the SAME engine + prelude the browser uses. The
 * untrusted script runs with no host bindings; ctx.db/ctx.http/ctx.utils are
 * synchronous RPC callbacks handled here in PHP, so all side effects and the
 * SSRF/DNS-pinning HTTP guards stay on the trusted side. A wall-clock kill in the
 * runner bounds runaway/looping scripts; this class enforces the shared HTTP
 * time + request-count budget across ctx.http calls.
 */
class FormLogicRuntime
{
    private int $maxInstructions;
    private int $maxWallTimeMs;
    private int $maxCallDepth;
    private int $httpRequestCount = 0;
    private float $httpDeadline = 0.0;
    private QuickJsRunner $runner;

    private const MAX_HTTP_REQUESTS = 10;
    private const MAX_RESPONSE_SIZE = 1 * 1024 * 1024; // 1MB

    public function __construct(array $config = [], ?QuickJsRunner $runner = null)
    {
        $this->maxInstructions = $config['maxInstructions'] ?? 50000;
        $this->maxWallTimeMs = $config['maxWallTimeMs'] ?? 2000;
        $this->maxCallDepth = $config['maxCallDepth'] ?? 100;
        // onSubmit scripts can do more than a field expression, so give them more
        // memory/stack headroom than the field-expression default (which matches
        // the browser VM). Field-expression parity is handled by FormLogicService.
        $this->runner = $runner ?? new QuickJsRunner(null, 131072, 1024);
    }

    /**
     * Execute a script with the given context.
     *
     * @param string $script User-provided onSubmit script
     * @param array $context Keys: answers, ipAddress, userAgent, timestamp, responseId, formId
     */
    public function execute(string $script, array $context): ScriptResult
    {
        $startTime = microtime(true);
        $this->httpRequestCount = 0; // Reset per execution
        // Shared wall-clock budget for native ctx.http calls this execution. cURL
        // runs OUTSIDE the guest's CPU budget, so without this a script pointing at
        // a tarpit could block a PHP worker for minutes (DoS). Clamp to [3s, 10s].
        $this->httpDeadline = $startTime + min(max($this->maxWallTimeMs / 1000, 3.0), 10.0);

        $answers = $context['answers'] ?? [];
        // Seed the capture with the submitted answers so ctx.db.getField() can read the
        // record's submitted values, not only fields the script itself sets this run.
        $capture = new DbContextCapture($answers);

        $meta = [
            'ip' => $context['ipAddress'] ?? null,
            'userAgent' => $context['userAgent'] ?? null,
            'timestamp' => $context['timestamp'] ?? time(),
            'responseId' => $context['responseId'] ?? null,
            'formId' => $context['formId'] ?? null,
        ];

        $handler = function (string $module, string $method, array $args) use ($capture) {
            return $this->handleHostCall($module, $method, $args, $capture);
        };

        if (!$this->runner->isAvailable()) {
            return ScriptResult::error('FormLogic runtime is not available', 0, 0);
        }

        // CPU budget for the guest; the runner adds host-handler (HTTP) time back
        // so network latency doesn't burn the compute budget.
        $cpuBudgetMs = $this->maxWallTimeMs + 500;
        $done = $this->runner->runScript(
            $script,
            ['answers' => $answers, 'meta' => $meta],
            $handler,
            $cpuBudgetMs
        );

        $executionTimeMs = (int) ((microtime(true) - $startTime) * 1000);

        if (isset($done['error'])) {
            return ScriptResult::error(
                'Script execution error: ' . $this->sanitizeError((string) $done['error']),
                0,
                $executionTimeMs
            );
        }

        if (($done['reject'] ?? false) === true) {
            $message = (string) ($done['message'] ?? 'Submission rejected');
            if (strlen($message) > 500) {
                $message = substr($message, 0, 500);
            }
            return ScriptResult::rejection($message, 0, $executionTimeMs);
        }

        return ScriptResult::success(
            computed: $done['result'] ?? null,
            fields: $capture->getFields(),
            tags: $capture->getTags(),
            status: $capture->getStatus(),
            instructionCount: 0,
            executionTimeMs: $executionTimeMs,
        );
    }

    /**
     * Dispatch a ctx.* host call from the sandbox. Returns a plain value to be
     * JSON-encoded back to the guest; may throw to surface an error there.
     *
     * @param array<int, mixed> $args
     */
    private function handleHostCall(string $module, string $method, array $args, DbContextCapture $capture): mixed
    {
        switch ($module) {
            case 'db':
                return $this->handleDb($method, $args, $capture);
            case 'utils':
                return $this->handleUtils($method, $args);
            case 'http':
                return $this->handleHttp($method, $args);
        }
        return null;
    }

    /**
     * @param array<int, mixed> $args
     */
    private function handleDb(string $method, array $args, DbContextCapture $capture): mixed
    {
        switch ($method) {
            case 'setField':
                if (count($args) < 2 || !is_string($args[0])) {
                    return false;
                }
                return $capture->setField($args[0], $args[1]);
            case 'getField':
                if (count($args) < 1 || !is_string($args[0])) {
                    return null;
                }
                return $capture->getField($args[0]);
            case 'setStatus':
                if (count($args) < 1 || !is_string($args[0])) {
                    return false;
                }
                return $capture->setStatus($args[0]);
            case 'addTag':
                if (count($args) < 1 || !is_string($args[0])) {
                    return false;
                }
                return $capture->addTag($args[0]);
        }
        return false;
    }

    /**
     * @param array<int, mixed> $args
     */
    private function handleUtils(string $method, array $args): mixed
    {
        switch ($method) {
            case 'uuid':
                return $this->generateUuid();
            case 'now':
                return time();
            case 'nowMs':
                return (int) (microtime(true) * 1000);
            case 'hash':
                $value = $args[0] ?? '';
                $algo = $args[1] ?? 'sha256';
                if (!is_string($algo) || !in_array($algo, ['md5', 'sha1', 'sha256', 'sha512'], true)) {
                    $algo = 'sha256';
                }
                $str = is_string($value) ? $value : (string) json_encode($value);
                return hash($algo, $str);
            case 'formatDate':
                $timestamp = $args[0] ?? null;
                $format = $args[1] ?? 'Y-m-d H:i:s';
                if (!is_numeric($timestamp)) {
                    return '';
                }
                if ($timestamp > 10000000000) {
                    $timestamp = (int) ($timestamp / 1000);
                }
                return date(is_string($format) ? $format : 'Y-m-d H:i:s', (int) $timestamp);
        }
        return null;
    }

    /**
     * @param array<int, mixed> $args
     * @return array<string, mixed>
     */
    private function handleHttp(string $method, array $args): array
    {
        switch ($method) {
            case 'get':
                $url = $args[0] ?? null;
                $options = $args[1] ?? [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('GET', $url, null, is_array($options) ? $options : []);
            case 'post':
            case 'put':
            case 'patch':
                $url = $args[0] ?? null;
                $data = $args[1] ?? null;
                $options = $args[2] ?? [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest(strtoupper($method), $url, $data, is_array($options) ? $options : []);
            case 'delete':
                $url = $args[0] ?? null;
                $options = $args[1] ?? [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('DELETE', $url, null, is_array($options) ? $options : []);
            case 'request':
                $options = $args[0] ?? [];
                if (!is_array($options)) {
                    return $this->httpErrorResponse('Options must be an object');
                }
                $reqMethod = strtoupper((string) ($options['method'] ?? 'GET'));
                $url = $options['url'] ?? null;
                $body = $options['body'] ?? null;
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL is required');
                }
                if (!in_array($reqMethod, ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], true)) {
                    return $this->httpErrorResponse('Invalid HTTP method');
                }
                return $this->executeHttpRequest($reqMethod, $url, $body, $options);
        }
        return $this->httpErrorResponse('Unknown HTTP method');
    }

    /**
     * Strip file paths / line numbers from an error message before returning it.
     */
    private function sanitizeError(string $message): string
    {
        $message = preg_replace('/\s*in\s+\/[^\s]+/', '', $message) ?? $message;
        $message = preg_replace('/\s*in\s+[A-Z]:\\\\[^\s]+/i', '', $message) ?? $message;
        $message = preg_replace('/\s*on line \d+/', '', $message) ?? $message;
        return $message;
    }

    /**
     * Execute an HTTP request using cURL.
     *
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    private function executeHttpRequest(string $method, string $url, mixed $body, array $options): array
    {
        // Enforce per-execution HTTP request limit
        if ($this->httpRequestCount >= self::MAX_HTTP_REQUESTS) {
            return $this->httpErrorResponse('HTTP request limit exceeded (max ' . self::MAX_HTTP_REQUESTS . ' per execution)');
        }
        $this->httpRequestCount++;

        // Validate URL
        if (!filter_var($url, FILTER_VALIDATE_URL)) {
            return $this->httpErrorResponse('Invalid URL format');
        }

        // Parse URL components
        $parsedUrl = parse_url($url);
        $host = $parsedUrl['host'] ?? null;
        $port = $parsedUrl['port'] ?? (($parsedUrl['scheme'] ?? 'https') === 'https' ? 443 : 80);

        if ($host === null) {
            return $this->httpErrorResponse('Invalid URL');
        }

        // Security: Block private IP ranges, localhost, and perform DNS pinning
        $hostCheck = $this->checkHostSecurity($host);
        if ($hostCheck['isPrivate']) {
            return $this->httpErrorResponse('Requests to private/local addresses are not allowed');
        }

        $resolvedIp = $hostCheck['resolvedIp'];

        // Build headers
        $headers = ['Accept: application/json'];
        $contentType = 'application/json';

        // Add custom headers
        if (isset($options['headers']) && is_array($options['headers'])) {
            foreach ($options['headers'] as $key => $value) {
                if (is_string($key) && (is_string($value) || is_numeric($value))) {
                    $key = (string)$key;
                    $value = (string)$value;
                    // Reject header injection via CRLF characters
                    if (preg_match('/[\r\n\x00]/', $key . $value)) {
                        continue;
                    }
                    // Prevent host header override
                    if (strtolower($key) !== 'host') {
                        $headers[] = "{$key}: {$value}";
                        if (strtolower($key) === 'content-type') {
                            $contentType = $value;
                        }
                    }
                }
            }
        }

        // Add Bearer token if provided (only if no Authorization header already set)
        if (isset($options['bearerToken']) && is_string($options['bearerToken']) && !$this->hasHeader($headers, 'authorization')) {
            $token = $options['bearerToken'];
            // Reject CRLF injection in bearer token
            if (!preg_match('/[\r\n\x00]/', $token)) {
                $headers[] = 'Authorization: Bearer ' . $token;
            }
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

        // Timeout: cap to wall-time limit to prevent blocking the PHP worker
        $maxTimeout = max(1, (int)($this->maxWallTimeMs / 1000));
        $timeout = min($maxTimeout, 10);
        if (isset($options['timeout']) && is_numeric($options['timeout'])) {
            $timeout = min($maxTimeout, max(1, (int)$options['timeout']));
        }

        // Bound every cURL call by the REMAINING shared HTTP budget so connect +
        // transfer time (across all requests AND redirects) can never exceed it.
        $remainingMs = (int) (($this->httpDeadline - microtime(true)) * 1000);
        if ($remainingMs <= 0) {
            return $this->httpErrorResponse('HTTP time budget exceeded');
        }
        $callTimeoutMs = min($remainingMs, $timeout * 1000);
        $connectTimeoutMs = min($remainingMs, 3000);
        $maxResponseSize = self::MAX_RESPONSE_SIZE;

        // Execute request with cURL
        $ch = curl_init();

        $curlOptions = [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false, // Disable auto-follow to validate redirects
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_TIMEOUT_MS => $callTimeoutMs,
            CURLOPT_CONNECTTIMEOUT_MS => $connectTimeoutMs,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HEADER => true,
            // Security settings
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            // Restrict to HTTP/HTTPS only (prevent gopher://, dict://, file:// etc.)
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            // Limit response size to prevent memory exhaustion
            CURLOPT_MAXFILESIZE => self::MAX_RESPONSE_SIZE,
            // MAXFILESIZE only catches a declared Content-Length; this aborts the
            // transfer mid-stream once downloaded bytes exceed the cap, covering
            // chunked / Content-Length-less responses (memory-exhaustion guard).
            CURLOPT_NOPROGRESS => false,
            CURLOPT_XFERINFOFUNCTION => static function ($ch, $dltotal, $dlnow) use ($maxResponseSize) {
                return $dlnow > $maxResponseSize ? 1 : 0;
            },
        ];

        // DNS pinning: Force cURL to use our pre-resolved IP to prevent DNS rebinding
        if ($resolvedIp !== null) {
            $curlOptions[CURLOPT_RESOLVE] = ["{$host}:{$port}:{$resolvedIp}"];
        }

        // Fall back to the vendored Mozilla CA bundle so outbound HTTPS works on
        // hosts that ship no curl.cainfo (e.g. WAMP) — but ONLY when the operator
        // hasn't configured their own (so a private/internal CA isn't overridden).
        // Carries into redirect hops too ($redirectOptions copies $curlOptions).
        $caBundle = __DIR__ . '/../../resources/cacert.pem';
        if (!ini_get('curl.cainfo') && !getenv('CURL_CA_BUNDLE') && is_file($caBundle)) {
            $curlOptions[CURLOPT_CAINFO] = $caBundle;
        }

        curl_setopt_array($ch, $curlOptions);

        if ($bodyString !== null && in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $bodyString);
        }

        $response = curl_exec($ch);
        $error = curl_error($ch);
        $errno = curl_errno($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $redirectUrl = curl_getinfo($ch, CURLINFO_REDIRECT_URL);

        curl_close($ch);

        // Handle cURL errors
        if ($errno !== 0) {
            return $this->httpErrorResponse("HTTP request failed");
        }

        // Handle redirects securely (validate each redirect URL)
        $redirectCount = 0;
        $maxRedirects = 5;
        while ($httpCode >= 300 && $httpCode < 400 && !empty($redirectUrl) && $redirectCount < $maxRedirects) {
            $redirectCount++;

            // Validate redirect URL
            if (!filter_var($redirectUrl, FILTER_VALIDATE_URL)) {
                return $this->httpErrorResponse('Invalid redirect URL');
            }

            // Check redirect host for SSRF
            $redirectParsed = parse_url($redirectUrl);
            $redirectHost = $redirectParsed['host'] ?? null;
            if ($redirectHost === null) {
                return $this->httpErrorResponse('Invalid redirect URL');
            }

            $redirectCheck = $this->checkHostSecurity($redirectHost);
            if ($redirectCheck['isPrivate']) {
                return $this->httpErrorResponse('Redirect to private/local address blocked');
            }

            // Per RFC 7231: convert POST/PUT/PATCH to GET on 301/302 redirects
            // and strip the request body. 307/308 preserve method.
            $redirectOptions = $curlOptions;
            if (in_array($httpCode, [301, 302], true) && in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
                $redirectOptions[CURLOPT_CUSTOMREQUEST] = 'GET';
                unset($redirectOptions[CURLOPT_POSTFIELDS]);
            }

            // Strip Authorization header when redirecting to a different host
            // to prevent credential leakage
            if (strtolower($redirectHost) !== strtolower($host)) {
                $filteredHeaders = array_filter($redirectOptions[CURLOPT_HTTPHEADER], function ($h) {
                    return stripos($h, 'Authorization:') !== 0;
                });
                $redirectOptions[CURLOPT_HTTPHEADER] = array_values($filteredHeaders);
            }

            // Follow the redirect with DNS pinning
            $redirectPort = $redirectParsed['port'] ?? (($redirectParsed['scheme'] ?? 'https') === 'https' ? 443 : 80);
            $ch = curl_init();
            $redirectOptions[CURLOPT_URL] = $redirectUrl;
            if ($redirectCheck['resolvedIp'] !== null) {
                $redirectOptions[CURLOPT_RESOLVE] = ["{$redirectHost}:{$redirectPort}:{$redirectCheck['resolvedIp']}"];
            }
            // Enforce the remaining shared HTTP budget on each redirect hop too,
            // so a redirect chain can't extend total blocking time past the deadline.
            $remainingMs = (int) (($this->httpDeadline - microtime(true)) * 1000);
            if ($remainingMs <= 0) {
                return $this->httpErrorResponse('HTTP time budget exceeded');
            }
            $redirectOptions[CURLOPT_TIMEOUT_MS] = $remainingMs;
            $redirectOptions[CURLOPT_CONNECTTIMEOUT_MS] = min($remainingMs, 3000);

            curl_setopt_array($ch, $redirectOptions);

            $response = curl_exec($ch);
            $error = curl_error($ch);
            $errno = curl_errno($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
            $redirectUrl = curl_getinfo($ch, CURLINFO_REDIRECT_URL);

            curl_close($ch);

            if ($errno !== 0) {
                return $this->httpErrorResponse("HTTP request failed");
            }
        }

        if ($redirectCount >= $maxRedirects) {
            return $this->httpErrorResponse('Too many redirects');
        }

        // Parse response
        $responseHeaders = substr($response, 0, $headerSize);
        $responseBody = substr($response, $headerSize);

        // Try to parse JSON response
        $data = json_decode($responseBody, true);
        $isJson = json_last_error() === JSON_ERROR_NONE;

        // Build response object
        return [
            'ok' => $httpCode >= 200 && $httpCode < 300,
            'status' => $httpCode,
            'statusText' => $this->getHttpStatusText($httpCode),
            'headers' => $this->parseResponseHeaders($responseHeaders),
            'body' => $responseBody,
            'data' => $isJson ? $data : null,
            'json' => $isJson,
        ];
    }

    /**
     * Create an error response object.
     *
     * @return array<string, mixed>
     */
    private function httpErrorResponse(string $message): array
    {
        return [
            'ok' => false,
            'status' => 0,
            'statusText' => 'Error',
            'headers' => [],
            'body' => '',
            'data' => null,
            'json' => false,
            'error' => $message,
        ];
    }

    /**
     * Check if a host is private/local (SSRF protection).
     * Returns [isPrivate: bool, resolvedIp: string|null]
     *
     * @return array{isPrivate: bool, resolvedIp: ?string}
     */
    private function checkHostSecurity(string $host): array
    {
        $host = strtolower($host);

        // Check for localhost variants and cloud metadata endpoints
        $localhostPatterns = [
            'localhost',
            '127.0.0.1',
            '::1',
            '0.0.0.0',
            '0',
            '[::1]',
            '[::ffff:127.0.0.1]',
            'localhost.localdomain',
            '127.0.0.1.nip.io', // Common DNS rebinding service
            '169.254.169.254',  // AWS/GCP metadata
            'metadata.google.internal', // GCP metadata
            'metadata.internal', // Generic cloud metadata
        ];

        foreach ($localhostPatterns as $pattern) {
            if ($host === $pattern || str_ends_with($host, '.' . $pattern)) {
                return ['isPrivate' => true, 'resolvedIp' => null];
            }
        }

        // Block numeric localhost variants (127.x.x.x in various formats)
        // Decimal: 2130706433 = 127.0.0.1
        // Octal: 0177.0.0.1
        // Hex: 0x7f.0.0.1
        if (preg_match('/^(0x7f|0177|2130\d+)/i', $host)) {
            return ['isPrivate' => true, 'resolvedIp' => null];
        }

        // Resolve hostname to IP addresses (both IPv4 and IPv6)
        $resolvedIp = null;

        // Try to get all IP addresses for the host
        $records = @dns_get_record($host, DNS_A | DNS_AAAA);
        if ($records === false || empty($records)) {
            // Fall back to gethostbyname for IPv4 only
            $ip = gethostbyname($host);
            if ($ip !== $host) {
                $resolvedIp = $ip;
                if ($this->isPrivateIp($ip)) {
                    return ['isPrivate' => true, 'resolvedIp' => null];
                }
            }
            // Could not resolve - block to be safe (prevents DNS rebinding via no-resolve-then-resolve)
            if ($resolvedIp === null) {
                return ['isPrivate' => true, 'resolvedIp' => null];
            }
        } else {
            // Check all returned IP addresses
            foreach ($records as $record) {
                $ip = $record['ip'] ?? $record['ipv6'] ?? null;
                if ($ip !== null) {
                    if ($this->isPrivateIp($ip)) {
                        return ['isPrivate' => true, 'resolvedIp' => null];
                    }
                    // Use the first valid IP for DNS pinning
                    if ($resolvedIp === null) {
                        $resolvedIp = $ip;
                    }
                }
            }
        }

        return ['isPrivate' => false, 'resolvedIp' => $resolvedIp];
    }

    /**
     * Check if an IP address is private/reserved.
     */
    private function isPrivateIp(string $ip): bool
    {
        // Check IPv4
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            // Use built-in filter for private and reserved ranges
            $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
            if (filter_var($ip, FILTER_VALIDATE_IP, $flags) === false) {
                return true;
            }
            return false;
        }

        // Check IPv6
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
            // Normalize IPv6 address
            $ip = strtolower($ip);

            // Remove brackets if present
            $ip = trim($ip, '[]');

            // Check for loopback (::1)
            if ($ip === '::1' || $ip === '0000:0000:0000:0000:0000:0000:0000:0001') {
                return true;
            }

            // Check for IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
            if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $ip, $matches)) {
                return $this->isPrivateIp($matches[1]);
            }

            // Expand IPv6 for checking
            $expanded = @inet_pton($ip);
            if ($expanded === false) {
                return true; // Invalid IP, block it
            }
            $hex = bin2hex($expanded);

            // Link-local (fe80::/10)
            if (str_starts_with($hex, 'fe8') || str_starts_with($hex, 'fe9') ||
                str_starts_with($hex, 'fea') || str_starts_with($hex, 'feb')) {
                return true;
            }

            // Unique local (fc00::/7 - includes fd00::/8)
            if (str_starts_with($hex, 'fc') || str_starts_with($hex, 'fd')) {
                return true;
            }

            // Site-local (deprecated, fec0::/10)
            if (str_starts_with($hex, 'fec') || str_starts_with($hex, 'fed') ||
                str_starts_with($hex, 'fee') || str_starts_with($hex, 'fef')) {
                return true;
            }

            // Unspecified (::)
            if ($hex === '00000000000000000000000000000000') {
                return true;
            }

            return false;
        }

        // Invalid IP format
        return true;
    }

    /**
     * Check if a header already exists in the headers array.
     *
     * @param array<int, string> $headers
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
     * Parse response headers into an associative array.
     *
     * @return array<string, string>
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
     * Get HTTP status text for a status code.
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
     * Generate a UUID v4.
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
