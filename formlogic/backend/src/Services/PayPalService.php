<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Thin client for the PayPal Orders API v2 (one-time captures — no subscriptions).
 *
 * Used for pay-as-you-go cloud months: create an order for a server-validated amount,
 * the buyer approves it in PayPal, then we capture it server-side and verify the result
 * before crediting anything. Reads credentials from the environment; when they are not
 * set, isConfigured() is false and the billing endpoints degrade gracefully.
 */
class PayPalService
{
    private string $clientId;
    private string $secret;
    private string $baseUrl;
    private string $webhookId;
    /** A stand-in's address named outside development: refused, and payments read as not set up. */
    private bool $standInRefused = false;
    /** A stand-in answers in PayPal's place: named by the code (tests), or by PAYPAL_BASE_URL in development. */
    private bool $standIn = false;
    private ?string $cachedToken = null;

    public function __construct(?array $config = null)
    {
        $config = $config ?? [];
        $this->clientId = (string) ($config['clientId'] ?? $_ENV['PAYPAL_CLIENT_ID'] ?? '');
        $this->secret = (string) ($config['secret'] ?? $_ENV['PAYPAL_SECRET'] ?? '');
        $env = strtolower((string) ($config['env'] ?? $_ENV['PAYPAL_ENV'] ?? 'sandbox'));
        $this->baseUrl = $env === 'live'
            ? 'https://api-m.paypal.com'
            : 'https://api-m.sandbox.paypal.com';
        $this->webhookId = (string) ($config['webhookId'] ?? $_ENV['PAYPAL_WEBHOOK_ID'] ?? '');
        // A stand-in for PayPal (tests/Support/stub-paypal-server.php): named by the code, or by
        // PAYPAL_BASE_URL in development only. Anything but an exact APP_ENV=development is production,
        // as config/settings.php reads it: there the address is refused, and payments are unavailable
        // until it is removed (standInRefused()), never sent to whatever it names.
        $override = $config['baseUrl'] ?? null;
        $fromEnv = $_ENV['PAYPAL_BASE_URL'] ?? null;
        if ($override === null && is_string($fromEnv) && $fromEnv !== '') {
            if (($_ENV['APP_ENV'] ?? 'production') !== 'development') {
                $this->standInRefused = true;
                error_log('FormLogic PayPalService: PAYPAL_BASE_URL is refused outside development; app payments are unavailable until it is removed.');
            } else {
                $override = $fromEnv;
            }
        }
        if (is_string($override) && preg_match('~^https?://[^\s/?#:]+(?::\d+)?$~D', rtrim($override, '/'))) {
            $this->baseUrl = rtrim($override, '/');
            $this->standIn = true;
        }
    }

    public function isConfigured(): bool
    {
        return $this->clientId !== '' && $this->secret !== '';
    }

    /** Whether PAYPAL_BASE_URL named a stand-in outside development (refused: see the constructor). */
    public function standInRefused(): bool
    {
        return $this->standInRefused;
    }

    /**
     * Whether a stand-in answers in PayPal's place: PAYPAL_BASE_URL with APP_ENV exactly
     * `development` (or an address the code itself named, as the tests do). Never true on a site
     * that takes real payments: there the address is refused (standInRefused()).
     */
    public function standIn(): bool
    {
        return $this->standIn;
    }

    /**
     * Development only: approve an order at the stand-in, as a buyer does in PayPal's own window
     * (the stand-in's `POST /stub/orders/{id}/approve`). PayPal's own script cannot do it: it knows
     * neither the stand-in's client id nor its orders. Refused wherever PayPal is PayPal.
     *
     * @throws \RuntimeException when no stand-in is in use, or it did not approve the order
     */
    public function approveStandInOrder(string $orderId): void
    {
        if (!$this->standIn) {
            throw new \RuntimeException('No stand-in for PayPal is in use');
        }
        $answer = $this->request('POST', '/stub/orders/' . rawurlencode($orderId) . '/approve', ['outcome' => 'completed']);
        if (($answer['_httpCode'] ?? 0) !== 200 || ($answer['approved'] ?? null) !== $orderId) {
            throw new \RuntimeException('The stand-in for PayPal did not approve the order (HTTP ' . ($answer['_httpCode'] ?? 0) . ')');
        }
    }

    public function getClientId(): string
    {
        return $this->clientId;
    }

    /**
     * Create a CAPTURE-intent order for a fixed amount. Returns the PayPal order id.
     *
     * @throws \RuntimeException on any PayPal/transport error
     */
    public function createOrder(int $amountCents, string $currency, string $description, string $customId): string
    {
        $value = number_format($amountCents / 100, 2, '.', '');
        $payload = [
            'intent' => 'CAPTURE',
            'purchase_units' => [[
                'amount' => ['currency_code' => $currency, 'value' => $value],
                'description' => $description,
                'custom_id' => $customId,
            ]],
            'application_context' => [
                'shipping_preference' => 'NO_SHIPPING',
                'user_action' => 'PAY_NOW',
            ],
        ];
        $res = $this->request('POST', '/v2/checkout/orders', $payload);
        if (empty($res['id'])) {
            throw new \RuntimeException('PayPal did not return an order id');
        }
        return (string) $res['id'];
    }

    /**
     * Capture an approved order. Returns the parsed PayPal response so the caller can
     * verify status, captured amount, and the capture id before crediting.
     *
     * A stable $requestId is sent as PayPal-Request-Id so a replayed capture (e.g. after a
     * lost response) returns the ORIGINAL result instead of an ORDER_ALREADY_CAPTURED error.
     *
     * @throws \RuntimeException on transport error (a non-2xx still returns the body so
     *         the caller can inspect e.g. ORDER_ALREADY_CAPTURED).
     */
    public function captureOrder(string $orderId, ?string $requestId = null): array
    {
        $headers = $requestId ? ['PayPal-Request-Id: ' . $requestId] : [];
        return $this->request('POST', '/v2/checkout/orders/' . rawurlencode($orderId) . '/capture', new \stdClass(), $headers);
    }

    /** Fetch an order's authoritative state (used to recover after a lost/ambiguous capture). */
    public function getOrder(string $orderId): array
    {
        return $this->request('GET', '/v2/checkout/orders/' . rawurlencode($orderId), null);
    }

    public function getWebhookId(): string
    {
        return $this->webhookId;
    }

    /**
     * Verify an inbound webhook's signature with PayPal so we only act on genuine events.
     * Returns false if no webhook id is configured or verification doesn't return SUCCESS.
     */
    public function verifyWebhookSignature(array $headers, array $event): bool
    {
        $webhookId = $this->getWebhookId();
        if ($webhookId === '') {
            return false;
        }
        $h = array_change_key_case($headers, CASE_LOWER);
        $get = fn(string $k) => is_array($h[$k] ?? null) ? ($h[$k][0] ?? '') : ($h[$k] ?? '');
        $payload = [
            'transmission_id' => $get('paypal-transmission-id'),
            'transmission_time' => $get('paypal-transmission-time'),
            'cert_url' => $get('paypal-cert-url'),
            'auth_algo' => $get('paypal-auth-algo'),
            'transmission_sig' => $get('paypal-transmission-sig'),
            'webhook_id' => $webhookId,
            'webhook_event' => $event,
        ];
        try {
            $res = $this->request('POST', '/v1/notifications/verify-webhook-signature', $payload);
            return ($res['verification_status'] ?? '') === 'SUCCESS';
        } catch (\Throwable $e) {
            return false;
        }
    }

    private function getAccessToken(): string
    {
        if ($this->cachedToken !== null) {
            return $this->cachedToken;
        }
        $ch = curl_init($this->baseUrl . '/v1/oauth2/token');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_USERPWD => $this->clientId . ':' . $this->secret,
            CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_POSTFIELDS => 'grant_type=client_credentials',
            CURLOPT_TIMEOUT => 20,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false || $code < 200 || $code >= 300) {
            throw new \RuntimeException('PayPal authentication failed' . ($err ? ": $err" : " (HTTP $code)"));
        }
        $data = json_decode((string) $body, true);
        if (!isset($data['access_token'])) {
            throw new \RuntimeException('PayPal did not return an access token');
        }
        return $this->cachedToken = (string) $data['access_token'];
    }

    private function request(string $method, string $path, mixed $payload, array $extraHeaders = []): array
    {
        $token = $this->getAccessToken();
        $ch = curl_init($this->baseUrl . $path);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => array_merge([
                'Content-Type: application/json',
                'Authorization: Bearer ' . $token,
            ], $extraHeaders),
            CURLOPT_TIMEOUT => 30,
            CURLOPT_SSL_VERIFYPEER => true,
        ];
        if ($payload !== null) {
            $opts[CURLOPT_POSTFIELDS] = json_encode($payload);
        }
        curl_setopt_array($ch, $opts);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            throw new \RuntimeException('PayPal request failed' . ($err ? ": $err" : ''));
        }
        $data = json_decode((string) $body, true);
        if (!is_array($data)) {
            throw new \RuntimeException('PayPal returned an unexpected response (HTTP ' . $code . ')');
        }
        // Surface hard transport/auth errors; let the caller interpret 2xx and
        // semantic 4xx (e.g. ORDER_ALREADY_CAPTURED) from the returned body.
        if ($code >= 500) {
            throw new \RuntimeException('PayPal request failed (HTTP ' . $code . ')');
        }
        $data['_httpCode'] = $code;
        return $data;
    }
}
