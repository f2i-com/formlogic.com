<?php

declare(strict_types=1);

/**
 * A stand-in for OAIY Studio's OpenAI-compatible gateway, for App AI's tests (`php -S` router): the
 * .env upstream's pictures and chat, in the form Studio takes them (AppAiUpstream). It never reaches
 * a real model. What a request asks for is read from its prompt (or its last chat message):
 *
 * - `[busy]` 503 "the media queue is full"; `[disabled]` 400 "image model … is disabled";
 *   `[missing]` the same for a model whose files are not on the computer; `[unknown]` 400 unknown model;
 *   `[toolarge]` 413; `[broken]` 500; `[garbage]` 200 with bytes that are not a picture;
 *   `[slow:N]` waits N seconds first;
 * - `[jpeg]` answers a JPEG; `[big]` a noisy 1024 px PNG of several megabytes; otherwise a small PNG;
 * - a chat's `[long:N]` answers N characters whatever `max_tokens` says: a model that runs on.
 *
 * Every request is appended to STUB_IMAGES_LOG as one JSON line: method, path, headers, body.
 */

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
$raw = (string) file_get_contents('php://input');
$body = json_decode($raw, true);
$body = is_array($body) ? $body : [];
$headers = [];
foreach ($_SERVER as $key => $value) {
    if (str_starts_with((string) $key, 'HTTP_')) $headers[strtolower(str_replace('_', '-', substr((string) $key, 5)))] = $value;
}
$log = getenv('STUB_IMAGES_LOG');
if (is_string($log) && $log !== '') {
    $logged = $body;
    foreach (['images'] as $key) {
        if (isset($logged[$key]) && is_array($logged[$key])) $logged[$key] = array_map(static fn($item) => is_string($item) ? ['length' => strlen($item), 'prefix' => substr($item, 0, 30)] : $item, $logged[$key]);
    }
    file_put_contents($log, json_encode(['method' => $method, 'path' => $path, 'headers' => $headers, 'body' => $logged], JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
}

$answer = static function (int $status, array $json): never {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($json, JSON_UNESCAPED_SLASHES);
    exit;
};
$said = $path === '/v1/chat/completions'
    ? (string) (is_array($body['messages'] ?? null) && $body['messages'] !== [] ? (end($body['messages'])['content'] ?? '') : '')
    : (string) ($body['prompt'] ?? '');
if (preg_match('/\[slow:(\d+)\]/', $said, $m)) sleep((int) $m[1]);
$model = (string) ($body['model'] ?? 'stub-model');

if ($method === 'GET' && $path === '/v1/models') {
    $answer(200, ['object' => 'list', 'data' => [['id' => 'stub-chat'], ['id' => 'stub-image', 'type' => 'image']]]);
}
if ($method === 'GET' && $path === '/health') {
    $answer(200, ['ok' => true]);
}
if ($method !== 'POST') $answer(404, ['error' => ['message' => 'not found']]);

if (str_contains($said, '[busy]')) $answer(503, ['error' => ['message' => 'the media queue is full; try again shortly']]);
if (str_contains($said, '[disabled]')) $answer(400, ['error' => ['message' => "image model {$model} is disabled"]]);
if (str_contains($said, '[missing]')) $answer(400, ['error' => ['message' => "image model {$model} is set up in OAIY Engines, but its files are not on this computer (missing: transformer, vae): download them under Models"]]);
if (str_contains($said, '[unknown]')) $answer(400, ['error' => ['message' => "unknown image model \"{$model}\""]]);
if (str_contains($said, '[toolarge]')) $answer(413, ['error' => ['message' => 'the reference is too large']]);
if (str_contains($said, '[broken]')) $answer(500, ['error' => ['message' => 'the engine stopped']]);

if ($path === '/v1/chat/completions') {
    if (preg_match('/\[long:(\d+)\]/', $said, $m)) {
        $answer(200, ['id' => 'chat-1', 'model' => $model, 'choices' => [['index' => 0, 'message' => ['role' => 'assistant', 'content' => substr(str_repeat('All work and no play. ', (int) ceil((int) $m[1] / 22)), 0, (int) $m[1])]]]]);
    }
    $answer(200, ['id' => 'chat-1', 'model' => $model, 'choices' => [['index' => 0, 'message' => ['role' => 'assistant', 'content' => 'Hello from the stub.']]]]);
}
if ($path !== '/v1/images/generations') $answer(404, ['error' => ['message' => 'not found']]);

[$width, $height] = array_map('intval', explode('x', (string) ($body['size'] ?? '512x512')) + [1 => 512]);
$seed = is_int($body['seed'] ?? null) ? $body['seed'] : 1234567;
if (str_contains($said, '[garbage]')) {
    $answer(200, ['created' => time(), 'data' => [['b64_json' => base64_encode('not a picture at all'), 'seed' => $seed]]]);
}
$big = str_contains($said, '[big]');
$side = $big ? 1024 : 96;
$image = imagecreatetruecolor($side, (int) round($side * $height / max(1, $width)));
if ($big) {
    // Noise does not compress: a PNG of several megabytes, as a large engine picture can be.
    mt_srand($seed);
    for ($y = 0; $y < imagesy($image); $y++) {
        for ($x = 0; $x < imagesx($image); $x++) imagesetpixel($image, $x, $y, mt_rand(0, 0xFFFFFF));
    }
} else {
    imagefill($image, 0, 0, imagecolorallocate($image, 240, 200, 80));
    imagefilledellipse($image, (int) ($side / 2), (int) (imagesy($image) / 2), (int) ($side / 2), (int) ($side / 2), imagecolorallocate($image, 120, 60, 20));
}
ob_start();
if (str_contains($said, '[jpeg]')) imagejpeg($image, null, 90); else imagepng($image);
$bytes = (string) ob_get_clean();
$answer(200, ['created' => time(), 'data' => [['b64_json' => base64_encode($bytes), 'seed' => $seed, 'model' => $model]]]);
