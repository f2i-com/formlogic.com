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
 * - a chat's `[long:N]` answers N characters whatever `max_tokens` says: a model that runs on;
 * - a chat asked for with `stream: true` is answered as server-sent events, a few characters at a
 *   time, and a line asked for as `response_format: "pcm"` as raw sound, a tone for each sentence and
 *   a fifth of a second of silence after it (`[unhurried]`: with a wait between the pieces;
 *   `[whole]`: answered whole all the same, as a server that does not stream answers;
 *   `[cut]`: a chat's stream stops after two pieces with an `error` event and then `[DONE]`, still
 *   200, as OAIY's server ends one whose model failed part-way; `[refused]`: the error comes first);
 * - a line to say (`POST /v1/audio/speech`, as OAIY Voice takes one) is answered with a WAV of a tone;
 *   `[words]` answers JSON where a sound was asked for, `[long]` half a minute of sound;
 * - a recording to put into words (`POST /v1/audio/transcriptions` {audio: a WAV in base64,
 *   response_format: "json"}, as OAIY Voice takes one, for AppListening) is answered `{text}`: how
 *   many samples it holds, at what rate, in how many channels, with a space before and a line end
 *   after, as a model leaves them. A recording has no prompt, so what it asks for is read from the
 *   first bytes of its sound: `[busy]`, `[broken]`, `[toolarge]` and `[slow:N]` as above; `[silent]`
 *   answers no words (`{text: ""}`), `[wordless]` an answer with no `text`, `[prose]` words that are
 *   not JSON, and `[endless]` 400,000 characters. One that is not a WAV, or asks for another
 *   format, is refused 400.
 *
 * Every request is appended to STUB_IMAGES_LOG as one JSON line: method, path, headers, body (a
 * picture to edit and a recording by their length and first characters).
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
    if (is_string($logged['audio'] ?? null)) $logged['audio'] = ['length' => strlen($logged['audio']), 'prefix' => substr($logged['audio'], 0, 30)];
    file_put_contents($log, json_encode(['method' => $method, 'path' => $path, 'headers' => $headers, 'body' => $logged], JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
}

$answer = static function (int $status, array $json): never {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($json, JSON_UNESCAPED_SLASHES);
    exit;
};
// A recording to put into words: the WAV itself, or false where the request carries none.
$recording = $path === '/v1/audio/transcriptions' && is_string($body['audio'] ?? null) ? base64_decode($body['audio'], true) : false;
$said = match ($path) {
    '/v1/chat/completions' => (string) (is_array($body['messages'] ?? null) && $body['messages'] !== [] ? (end($body['messages'])['content'] ?? '') : ''),
    '/v1/audio/speech' => (string) ($body['input'] ?? ''),
    // The first bytes of its sound, after the 44 of its header.
    '/v1/audio/transcriptions' => $recording === false ? '' : substr($recording, 44, 64),
    default => (string) ($body['prompt'] ?? ''),
};
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

$unhurried = str_contains($said, '[unhurried]');
if ($path === '/v1/chat/completions' && ($body['stream'] ?? false) === true && !str_contains($said, '[whole]')) {
    // A chat asked for as it is written: server-sent events, the reply five characters at a time.
    $text = preg_match('/\[long:(\d+)\]/', $said, $m) ? substr(str_repeat('All work and no play. ', (int) ceil((int) $m[1] / 22)), 0, (int) $m[1]) : 'Hello from the stub.';
    http_response_code(200);
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache');
    while (ob_get_level() > 0) ob_end_flush();
    $cut = str_contains($said, '[refused]') ? 0 : (str_contains($said, '[cut]') ? 2 : null);
    foreach (str_split($text, 5) as $sent => $piece) {
        if ($sent === $cut) {
            echo 'data: ' . json_encode(['error' => ['message' => 'the model stopped', 'type' => 'server_error']]) . "\n\n";
            break;
        }
        echo 'data: ' . json_encode(['id' => 'chat-1', 'model' => $model, 'choices' => [['index' => 0, 'delta' => ['content' => $piece]]]]) . "\n\n";
        flush();
        if ($unhurried) usleep(150000);
    }
    echo "data: [DONE]\n\n";
    exit;
}
if ($path === '/v1/audio/speech' && ($body['response_format'] ?? '') === 'pcm' && !str_contains($said, '[whole]') && !str_contains($said, '[words]')) {
    // A line asked for as it is spoken, as OAIY Voice streams one: raw 16-bit mono sound at 24 kHz.
    // Each sentence is a tone, a twentieth of a second a character, then a fifth of a second of silence.
    $rate = 24000;
    http_response_code(200);
    header('Content-Type: audio/pcm');
    header('X-Sample-Rate: ' . $rate);
    while (ob_get_level() > 0) ob_end_flush();
    foreach (preg_split('/(?<=[.!?])\s+/', trim($said)) ?: [] as $sentence) {
        $data = '';
        $samples = (int) round($rate * 0.05 * mb_strlen($sentence));
        for ($i = 0; $i < $samples; $i++) $data .= pack('v', (int) round(sin($i * 2 * M_PI * 220 / $rate) * 8000) & 0xFFFF);
        echo $data . str_repeat("\0\0", (int) ($rate * 0.2));
        flush();
        if ($unhurried) usleep(300000);
    }
    exit;
}

if ($path === '/v1/chat/completions') {
    if (preg_match('/\[long:(\d+)\]/', $said, $m)) {
        $answer(200, ['id' => 'chat-1', 'model' => $model, 'choices' => [['index' => 0, 'message' => ['role' => 'assistant', 'content' => substr(str_repeat('All work and no play. ', (int) ceil((int) $m[1] / 22)), 0, (int) $m[1])]]]]);
    }
    $answer(200, ['id' => 'chat-1', 'model' => $model, 'choices' => [['index' => 0, 'message' => ['role' => 'assistant', 'content' => 'Hello from the stub.']]]]);
}
if ($path === '/v1/audio/speech') {
    // A line said, as OAIY Voice answers one: the sound itself, a WAV (24 kHz, 16-bit, one channel) of
    // a tone, a twentieth of a second for each character of the line.
    if (str_contains($said, '[words]')) $answer(200, ['text' => 'I would rather write.']);
    $rate = 24000;
    $samples = str_contains($said, '[long]') ? 30 * $rate : max(1, (int) round($rate * 0.05 * mb_strlen($said)));
    $data = '';
    for ($i = 0; $i < $samples; $i++) $data .= pack('v', (int) round(sin($i * 2 * M_PI * 220 / $rate) * 8000) & 0xFFFF);
    http_response_code(200);
    header('Content-Type: audio/wav');
    echo 'RIFF' . pack('V', 36 + strlen($data)) . 'WAVEfmt ' . pack('VvvVVvv', 16, 1, 1, $rate, $rate * 2, 2, 16) . 'data' . pack('V', strlen($data)) . $data;
    exit;
}
if ($path === '/v1/audio/transcriptions') {
    // A recording put into words, as OAIY Voice answers one: `{text}`. Only a WAV under the usual
    // 44-byte header is taken here, which is what AppListening sends whatever it was sent.
    if ($recording === false || strlen($recording) < 44 || substr($recording, 0, 4) !== 'RIFF' || substr($recording, 8, 8) !== 'WAVEfmt ' || substr($recording, 36, 4) !== 'data') {
        $answer(400, ['error' => ['message' => 'invalid WAV: not a RIFF/WAVE file', 'type' => 'invalid_request_error']]);
    }
    if (($body['response_format'] ?? 'json') !== 'json') $answer(400, ['error' => ['message' => 'only response_format "json" is answered here', 'type' => 'invalid_request_error']]);
    $format = unpack('vtag/vchannels/Vrate/Vbytes/valign/vbits', $recording, 20);
    $samples = intdiv(strlen($recording) - 44, max(1, (int) $format['align']));
    if (str_contains($said, '[silent]')) $answer(200, ['text' => '']);
    if (str_contains($said, '[wordless]')) $answer(200, ['task' => 'transcribe']);
    if (str_contains($said, '[prose]')) {
        http_response_code(200);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'I heard you.';
        exit;
    }
    if (str_contains($said, '[endless]')) $answer(200, ['text' => str_repeat('and on ', 57143)]);
    $answer(200, ['text' => " {$samples} samples at {$format['rate']} Hz in {$format['channels']}.\n"]);
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
