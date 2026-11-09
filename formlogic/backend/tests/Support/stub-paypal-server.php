<?php

declare(strict_types=1);

/**
 * A stand-in for PayPal's REST API, for app payments' tests (`php -S` router; PAYPAL_BASE_URL points
 * PayPalService at it outside production). It keeps its orders in STUB_PAYPAL_STATE (a JSON file):
 *
 * - `POST /v1/oauth2/token`; `POST /v2/checkout/orders`; `GET /v2/checkout/orders/{id}`;
 *   `POST /v2/checkout/orders/{id}/capture` (one capture per order, the same answer to a repeated
 *   PayPal-Request-Id); `POST /v1/notifications/verify-webhook-signature` (SUCCESS when the
 *   transmission signature is `stub-valid`); `POST /v2/payments/captures/{id}/refund`.
 * - Control, for the tests and the end-to-end fake SDK: `POST /stub/orders/{id}/approve`
 *   {outcome: completed | pending | declined | lost | mismatch}: what capturing it will do;
 *   `GET /stub/state`. These answer CORS, so a page can call them.
 */

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
$body = json_decode((string) file_get_contents('php://input'), true);
$body = is_array($body) ? $body : [];
$stateFile = (string) (getenv('STUB_PAYPAL_STATE') ?: sys_get_temp_dir() . '/stub-paypal-state.json');

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization, PayPal-Request-Id');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if ($method === 'OPTIONS') { http_response_code(204); exit; }

$answer = static function (int $status, array $json): never {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($json, JSON_UNESCAPED_SLASHES);
    exit;
};

// One request at a time changes the state, under a lock.
$lock = fopen($stateFile . '.lock', 'c');
flock($lock, LOCK_EX);
$state = json_decode((string) @file_get_contents($stateFile), true);
$state = is_array($state) ? $state : ['orders' => [], 'requests' => [], 'next' => 1];
$save = static function () use (&$state, $stateFile): void { file_put_contents($stateFile, json_encode($state, JSON_UNESCAPED_SLASHES)); };

if ($method === 'POST' && $path === '/v1/oauth2/token') $answer(200, ['access_token' => 'stub-token', 'token_type' => 'Bearer', 'expires_in' => 32400]);

if ($method === 'POST' && $path === '/v2/checkout/orders') {
    $unit = $body['purchase_units'][0] ?? [];
    $id = 'STUBORDER' . str_pad((string) $state['next']++, 6, '0', STR_PAD_LEFT);
    $state['orders'][$id] = ['id' => $id, 'status' => 'CREATED', 'amount' => $unit['amount'] ?? null, 'custom_id' => $unit['custom_id'] ?? null, 'description' => $unit['description'] ?? null, 'outcome' => null, 'capture' => null];
    $save();
    $answer(201, ['id' => $id, 'status' => 'CREATED', 'links' => [['rel' => 'approve', 'href' => 'https://www.sandbox.paypal.com/checkoutnow?token=' . $id]]]);
}

if ($method === 'POST' && preg_match('#^/stub/orders/([A-Z0-9]+)/approve$#', $path, $m)) {
    if (!isset($state['orders'][$m[1]])) $answer(404, ['name' => 'RESOURCE_NOT_FOUND']);
    $state['orders'][$m[1]]['status'] = 'APPROVED';
    $state['orders'][$m[1]]['outcome'] = (string) ($body['outcome'] ?? 'completed');
    $save();
    $answer(200, ['approved' => $m[1]]);
}
if ($method === 'GET' && $path === '/stub/state') $answer(200, $state);

$orderView = static function (array $order): array {
    $view = ['id' => $order['id'], 'status' => $order['status'], 'purchase_units' => [['amount' => $order['amount'], 'custom_id' => $order['custom_id']]]];
    if ($order['capture'] !== null) $view['purchase_units'][0]['payments'] = ['captures' => [$order['capture']]];
    return $view;
};

if ($method === 'GET' && preg_match('#^/v2/checkout/orders/([A-Z0-9]+)$#', $path, $m)) {
    $order = $state['orders'][$m[1]] ?? null;
    if ($order === null) $answer(404, ['name' => 'RESOURCE_NOT_FOUND']);
    $answer(200, $orderView($order));
}

if ($method === 'POST' && preg_match('#^/v2/checkout/orders/([A-Z0-9]+)/capture$#', $path, $m)) {
    $order = $state['orders'][$m[1]] ?? null;
    if ($order === null) $answer(404, ['name' => 'RESOURCE_NOT_FOUND']);
    if ($order['capture'] !== null) {
        // Captured already: what PayPal answers a capture without the same request id.
        $requestId = (string) ($_SERVER['HTTP_PAYPAL_REQUEST_ID'] ?? '');
        if ($requestId !== '' && $requestId === ($order['request_id'] ?? null)) $answer(201, $orderView($order));
        $answer(422, ['name' => 'UNPROCESSABLE_ENTITY', 'details' => [['issue' => 'ORDER_ALREADY_CAPTURED']]]);
    }
    if ($order['status'] !== 'APPROVED') $answer(422, ['name' => 'UNPROCESSABLE_ENTITY', 'details' => [['issue' => 'ORDER_NOT_APPROVED']]]);
    $outcome = $order['outcome'];
    $amount = $order['amount'];
    if ($outcome === 'mismatch') $amount = ['currency_code' => 'USD', 'value' => '0.01'];
    $status = match ($outcome) { 'pending' => 'PENDING', 'declined' => 'DECLINED', default => 'COMPLETED' };
    $capture = ['id' => 'STUBCAP' . substr($order['id'], 9), 'status' => $status, 'amount' => $amount];
    $state['orders'][$m[1]]['capture'] = $capture;
    $state['orders'][$m[1]]['status'] = 'COMPLETED';
    $state['orders'][$m[1]]['request_id'] = (string) ($_SERVER['HTTP_PAYPAL_REQUEST_ID'] ?? '');
    $save();
    // `lost`: the money moves, but the answer never arrives.
    if ($outcome === 'lost') $answer(500, ['name' => 'INTERNAL_SERVER_ERROR']);
    $answer(201, $orderView($state['orders'][$m[1]]));
}

if ($method === 'POST' && $path === '/v1/notifications/verify-webhook-signature') {
    $answer(200, ['verification_status' => ($body['transmission_sig'] ?? '') === 'stub-valid' ? 'SUCCESS' : 'FAILURE']);
}

if ($method === 'POST' && preg_match('#^/v2/payments/captures/([A-Z0-9]+)/refund$#', $path, $m)) {
    $answer(201, ['id' => 'STUBREFUND' . $m[1], 'status' => 'COMPLETED', 'links' => [['rel' => 'up', 'href' => 'https://api-m.sandbox.paypal.com/v2/payments/captures/' . $m[1]]]]);
}

$answer(404, ['name' => 'NOT_FOUND', 'path' => $path]);
