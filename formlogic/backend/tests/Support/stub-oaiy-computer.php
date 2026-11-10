<?php

declare(strict_types=1);

/**
 * A stand-in for an OAIY server linked to a FormLogic site, for App AI's browser tests. It never
 * reaches a real model and is not OAIY: it speaks OAIY's side of the site's wire, over HTTP only.
 *
 *   php stub-oaiy-computer.php <site> <one-time code> [device name]
 *
 * It links with the code (POST /api/oauth/oaiy-link), checks in, publishes an X25519 key, and then
 * answers what the site queues for it on the sealed AI lane (GET /api/v1/desktop-ai/pending, claim,
 * frames, complete), as OAIY-LANE describes:
 *
 * - `providers`: OAIY's own engine;
 * - `models`: one language model and two picture models (`flux-3-image-klein`, `stub-image-xl`);
 * - `image`: a small PNG drawn here, with the seed and model asked for. A prompt holding `[broken]`
 *   is answered with an engine error; `[slow:N]` takes N seconds first, with a progress frame every
 *   second (OAIY sends one every 5 s);
 * - `chat`: a short answer, in two pieces. A last message holding `[long:N]` is answered with N
 *   characters, 40 a frame and 20 frames a second, whatever `maxTokens` says: a model that runs on.
 *
 * A frame, or the outcome, answered 409 `{code: "cancelled"}` ends the turn there, as OAIY does
 * (contract §0.13): nothing more is sent for it, and the next request is taken.
 *
 * It stops when the file named by STUB_OAIY_STOP exists, when the site refuses its key (unlinked),
 * or after STUB_OAIY_SECONDS (600 by default). Every turn is written to standard output as it is
 * taken and as it ends: `image taken`, `image answered`, `chat maxTokens=2000 answered`,
 * `image cancelled after 3 frames` (the frames the site took before it said so).
 */

[$site, $code, $name] = [rtrim((string) ($argv[1] ?? ''), '/'), (string) ($argv[2] ?? ''), (string) ($argv[3] ?? 'Studio PC')];
if ($site === '' || $code === '') {
    fwrite(STDERR, "usage: php stub-oaiy-computer.php <site> <one-time code> [device name]\n");
    exit(2);
}
$stopFile = (string) getenv('STUB_OAIY_STOP');
$deadline = time() + max(5, (int) (getenv('STUB_OAIY_SECONDS') ?: 600));
$say = static function (string $line): void {
    fwrite(STDOUT, '[stub-oaiy] ' . $line . "\n");
};

/** One HTTP request; returns [status, decoded JSON body]. */
$http = static function (string $method, string $path, ?array $json = null, ?string $key = null, ?array $form = null) use ($site): array {
    $headers = ['Accept: application/json', 'User-Agent: stub-oaiy-computer'];
    $content = null;
    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
        $content = json_encode($json, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    } elseif ($form !== null) {
        $headers[] = 'Content-Type: application/x-www-form-urlencoded';
        $content = http_build_query($form);
    }
    if ($key !== null) $headers[] = 'Authorization: Bearer ' . $key;
    $context = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers), 'content' => $content ?? '', 'ignore_errors' => true, 'timeout' => 30]]);
    $body = @file_get_contents($site . $path, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) $status = (int) $m[1];
    }
    $decoded = is_string($body) ? json_decode($body, true) : null;
    return [$status, is_array($decoded) ? $decoded : []];
};

// Link: the code is the credential, and the answer holds this computer's key for the site.
[$status, $linked] = $http('POST', '/api/oauth/oaiy-link', null, null, ['code' => $code, 'device_name' => $name]);
$key = is_string($linked['formlogic_api_key'] ?? null) ? $linked['formlogic_api_key'] : '';
if ($status !== 200 || $key === '') {
    fwrite(STDERR, 'The code was refused (' . $status . '): ' . (string) ($linked['error_description'] ?? '') . "\n");
    exit(1);
}
$instance = 'stub-oaiy-' . bin2hex(random_bytes(6));
$pair = sodium_crypto_box_keypair();
$secret = sodium_crypto_box_secretkey($pair);
$say("linked as {$name} ({$instance})");

$checkIn = static function () use ($http, $key, $instance, $name): int {
    return $http('POST', '/api/v1/desktop-connections', ['desktopInstanceId' => $instance, 'deviceName' => $name], $key)[0];
};
if ($checkIn() !== 201) {
    fwrite(STDERR, "The first check-in was refused.\n");
    exit(1);
}
[$status] = $http('POST', '/api/v1/desktop-ai/pubkey', ['instanceId' => $instance, 'publicKey' => base64_encode(sodium_crypto_box_publickey($pair))], $key);
if ($status !== 200) {
    fwrite(STDERR, "The key was not published ({$status}).\n");
    exit(1);
}
$say('online, key published');

/** base64(nonce || box): byte 0 of the nonce is the direction (0 the site, 1 this computer), its last 8 the counter. */
$nonce = static fn(int $direction, int $counter): string => chr($direction) . str_repeat("\0", 15) . pack('J', $counter);

/** The frames that answer one opened turn, each made as it is due: the caller stops asking when one is refused. */
$answer = static function (array $turn): \Generator {
    $kind = (string) ($turn['kind'] ?? '');
    if ($kind === 'providers') {
        yield ['v' => 1, 'kind' => 'final', 'providers' => [['id' => 'oaiy-engine', 'label' => 'OAIY Engine', 'model' => 'stub-chat-model', 'capabilities' => ['chat'], 'enabled' => true]]];
        return;
    }
    if ($kind === 'models') {
        yield ['v' => 1, 'kind' => 'final', 'models' => [
            ['id' => 'stub-chat-model', 'name' => 'Stub chat model'],
            ['id' => 'stub-image-xl', 'name' => 'Stub XL', 'type' => 'image'],
            ['id' => 'flux-3-image-klein', 'name' => 'FLUX 3 Klein', 'type' => 'image'],
        ]];
        return;
    }
    if ($kind === 'image') {
        $prompt = (string) ($turn['prompt'] ?? '');
        if (preg_match('/\[slow:(\d+)\]/', $prompt, $m)) {
            // Still drawing: a progress frame a second, which is also where a cancel is heard.
            for ($second = 0; $second < (int) $m[1]; $second++) {
                sleep(1);
                yield ['v' => 1, 'type' => 'progress', 'kind' => 'progress', 'progress' => 'drawing'];
            }
        }
        if (str_contains($prompt, '[broken]')) {
            yield ['v' => 1, 'kind' => 'final', 'error' => ['code' => 'engine_failed', 'message' => 'The engine stopped.']];
            return;
        }
        [$width, $height] = array_map('intval', explode('x', (string) ($turn['size'] ?? '512x512')) + [1 => 512]);
        $seed = is_int($turn['seed'] ?? null) ? $turn['seed'] : 1234567;
        // A badge: small, but a real picture the site can check, resize and show.
        $side = 256;
        $image = imagecreatetruecolor($side, max(16, (int) round($side * $height / max(1, $width))));
        $middle = [(int) ($side / 2), (int) (imagesy($image) / 2)];
        imagefill($image, 0, 0, imagecolorallocate($image, 250, 247, 240));
        imagefilledellipse($image, $middle[0], $middle[1], 200, 200, imagecolorallocate($image, 190, 110, 50));
        imagefilledellipse($image, $middle[0], $middle[1], 170, 170, imagecolorallocate($image, 252, 236, 200));
        imagefilledrectangle($image, $middle[0] - 38, $middle[1] - 22, $middle[0] + 30, $middle[1] + 40, imagecolorallocate($image, 110, 62, 28));
        imagesetthickness($image, 8);
        imagearc($image, $middle[0] + 36, $middle[1] + 6, 36, 40, 270, 90, imagecolorallocate($image, 110, 62, 28));
        ob_start();
        imagepng($image);
        $bytes = (string) ob_get_clean();
        yield ['v' => 1, 'kind' => 'final', 'picture' => ['mimeType' => 'image/png', 'data' => base64_encode($bytes), 'width' => imagesx($image), 'height' => imagesy($image),
            'seed' => $seed, 'model' => (string) ($turn['model'] ?? 'flux-3-image-klein')]];
        return;
    }
    if ($kind === 'chat') {
        $messages = is_array($turn['messages'] ?? null) ? $turn['messages'] : [];
        $last = $messages === [] ? '' : (string) (end($messages)['content'] ?? '');
        if (preg_match('/\[long:(\d+)\]/', $last, $m)) {
            // A model that runs on: as many characters as asked, as a real one writes them.
            $text = substr(str_repeat('All work and no play. ', (int) ceil((int) $m[1] / 22)), 0, (int) $m[1]);
            foreach (str_split($text, 40) as $piece) {
                usleep(50000);
                yield ['v' => 1, 'kind' => 'delta', 'delta' => $piece];
            }
            yield ['v' => 1, 'kind' => 'final'];
            return;
        }
        yield ['v' => 1, 'kind' => 'delta', 'delta' => 'Hello from '];
        yield ['v' => 1, 'kind' => 'delta', 'delta' => 'the stub computer.'];
        yield ['v' => 1, 'kind' => 'final'];
        return;
    }
    yield ['v' => 1, 'kind' => 'error', 'message' => 'This stand-in does not answer ' . $kind . '.'];
};

$checkedIn = time();
while (time() < $deadline && !($stopFile !== '' && is_file($stopFile))) {
    if (time() - $checkedIn >= 20) {
        $checkedIn = time();
        if ($checkIn() === 401) break;
    }
    [$status, $pending] = $http('GET', '/api/v1/desktop-ai/pending?instanceId=' . rawurlencode($instance) . '&wait=0', null, $key);
    if ($status === 401) break;
    foreach (is_array($pending['requests'] ?? null) ? $pending['requests'] : [] as $waiting) {
        $id = (string) ($waiting['requestId'] ?? '');
        [$status, $claimed] = $http('POST', "/api/v1/desktop-ai/{$id}/claim", ['instanceId' => $instance], $key);
        if ($status !== 200 || !is_array($claimed['request'] ?? null)) continue;
        $request = $claimed['request'];
        $shared = sodium_crypto_box_keypair_from_secretkey_and_publickey($secret, (string) base64_decode((string) $request['ephPub'], true));
        $raw = (string) base64_decode((string) $request['envelope'], true);
        $plain = sodium_crypto_box_open(substr($raw, 24), substr($raw, 0, 24), $shared);
        $turn = is_string($plain) && hash_equals($nonce(0, 0), substr($raw, 0, 24)) ? json_decode($plain, true) : null;
        $frames = is_array($turn) ? $answer($turn) : [['v' => 1, 'kind' => 'error', 'message' => 'The turn did not open with this computer\'s key.']];
        $what = is_array($turn) ? (string) ($turn['kind'] ?? '?') : 'unreadable';
        if ($what === 'chat' && is_int($turn['maxTokens'] ?? null)) $what .= ' maxTokens=' . $turn['maxTokens'];
        $say($what . ' taken');
        // The site's answer to a frame or to the outcome: 409 {code: "cancelled"} means stop here.
        $stop = static fn(array $answered): bool => $answered[0] === 409 && ($answered[1]['code'] ?? null) === 'cancelled';
        $sent = 0;
        $cancelled = false;
        $last = [];
        foreach ($frames as $frame) {
            $last = $frame;
            $sealedNonce = $nonce(1, $sent);
            $envelope = base64_encode($sealedNonce . sodium_crypto_box(json_encode($frame, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), $sealedNonce, $shared));
            if ($stop($http('POST', "/api/v1/desktop-ai/{$id}/frames", ['instanceId' => $instance, 'envelope' => $envelope], $key))) {
                $cancelled = true;
                break;
            }
            $sent++;
        }
        $failed = in_array($last['kind'] ?? '', ['error', 'failed'], true);
        if (!$cancelled) $cancelled = $stop($http('POST', "/api/v1/desktop-ai/{$id}/complete", ['instanceId' => $instance, 'status' => $failed ? 'failed' : 'done'], $key));
        $say($what . ' ' . ($cancelled ? "cancelled after {$sent} frames" : ($failed ? 'failed' : 'answered')));
    }
    usleep(300000);
}
$say('stopped');
