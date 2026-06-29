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
    }

    public function isConfigured(): bool
    {
        return $this->clientId !== '' && $this->secret !== '';
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
     * @throws \RuntimeException on transport error (a non-2xx still returns the body so
     *         the caller can inspect e.g. ORDER_ALREADY_CAPTURED).
     */
    public function captureOrder(string $orderId): array
    {
        return $this->request('POST', '/v2/checkout/orders/' . rawurlencode($orderId) . '/capture', new \stdClass());
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

    private function request(string $method, string $path, mixed $payload): array
    {
        $token = $this->getAccessToken();
        $ch = curl_init($this->baseUrl . $path);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $token,
            ],
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_TIMEOUT => 30,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
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
