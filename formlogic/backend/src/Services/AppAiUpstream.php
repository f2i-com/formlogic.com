<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * App AI's jobs on the site's .env upstream (AI_BASE_URL): an OpenAI-compatible server, such as OAIY
 * Studio's gateway, asked without waiting (curl_multi), so a slow picture never holds up the worker's
 * other work. One request per job, in the form Studio's gateway takes (OAIY sends its engines the same):
 *
 * - a picture: `POST {base}/images/generations` {model, prompt, size, n: 1, response_format: b64_json,
 *   incognito: true, seed?}
 * - an edit: the same, with `images: ["<the picture to edit, as a data URL>"]`
 * - chat: `POST {base}/chat/completions` {model, messages, stream: false}
 *
 * Every picture request also carries `X-OAIY-Incognito: 1`, which OAIY reads as "keep no copy" and
 * any other server ignores. Redirects are never followed. Answers and errors use the delivery's codes.
 */
final class AppAiUpstream
{
    /** The largest answer read: a 2048 px PNG in base64 is under this. */
    private const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

    private ?\CurlMultiHandle $multi = null;
    /** @var array<string, array{handle: \CurlHandle, kind: string, seed: ?int, model: string}> */
    private array $running = [];

    /**
     * @param ?array{url: string, key: string, model: string} $config the upstream (AIService::envUpstream()), or null when the site has none
     */
    public function __construct(private ?array $config, private int $pictureTimeout = 240, private int $chatTimeout = 120)
    {
    }

    public function configured(): bool
    {
        return $this->config !== null && $this->config['url'] !== '';
    }

    /** Requests in flight, of a kind ('picture' for pictures and edits, 'chat'), or all. */
    public function count(?string $lane = null): int
    {
        if ($lane === null) return count($this->running);
        return count(array_filter($this->running, static fn(array $run) => ($run['kind'] === 'chat') === ($lane === 'chat')));
    }

    public function has(string $jobId): bool
    {
        return isset($this->running[$jobId]);
    }

    /**
     * Start job $jobId: ['kind' => picture|edit|chat, 'model' => ?string, 'prompt' => string, 'size' => string,
     * 'seed' => ?int, 'reference' => ?data URL, 'messages' => ?list]. A null or empty model is the upstream's own.
     */
    public function start(string $jobId, array $job): void
    {
        if (!$this->configured()) throw new \RuntimeException('The site has no AI upstream');
        $base = rtrim($this->config['url'], '/');
        $chat = $job['kind'] === 'chat';
        $model = (string) ($job['model'] ?? '') !== '' ? (string) $job['model'] : $this->config['model'];
        if ($chat) {
            $path = '/chat/completions';
            $body = ['model' => $model, 'messages' => $job['messages'], 'stream' => false];
        } else {
            $path = '/images/generations';
            $body = ['model' => $model, 'prompt' => $job['prompt'], 'size' => $job['size'], 'n' => 1, 'response_format' => 'b64_json', 'incognito' => true];
            if (($job['seed'] ?? null) !== null) $body['seed'] = (int) $job['seed'];
            if ($job['kind'] === 'edit') $body['images'] = [(string) $job['reference']];
        }
        $headers = ['Content-Type: application/json', 'Accept: application/json'];
        if ($this->config['key'] !== '') $headers[] = 'Authorization: Bearer ' . $this->config['key'];
        if (!$chat) $headers[] = 'X-OAIY-Incognito: 1';
        $handle = curl_init($base . $path);
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => $chat ? $this->chatTimeout : $this->pictureTimeout,
            CURLOPT_MAXFILESIZE => self::MAX_ANSWER_BYTES,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        ]);
        $this->multi ??= curl_multi_init();
        curl_multi_add_handle($this->multi, $handle);
        $this->running[$jobId] = ['handle' => $handle, 'kind' => $chat ? 'chat' : 'picture', 'seed' => isset($job['seed']) ? (int) $job['seed'] : null, 'model' => $model];
        // Under way at once: the request is sent while the worker goes on with its other work.
        $this->pump();
    }

    /**
     * Move the requests along, waiting at most $wait seconds, and answer those that finished, by job:
     * ['ok' => true, 'picture' => bytes, 'seed' => ?int, 'model' => …], ['ok' => true, 'text' => …, 'model' => …],
     * or ['ok' => false, 'code' => …, 'message' => …].
     *
     * @return array<string, array>
     */
    public function poll(float $wait = 0.0): array
    {
        if ($this->multi === null || $this->running === []) return [];
        $active = $this->pump();
        if ($active > 0 && $wait > 0) {
            curl_multi_select($this->multi, $wait);
            $this->pump();
        }
        $done = [];
        while (($message = curl_multi_info_read($this->multi)) !== false) {
            $handle = $message['handle'];
            $jobId = null;
            foreach ($this->running as $id => $run) {
                if ($run['handle'] === $handle) { $jobId = $id; break; }
            }
            if ($jobId === null) continue;
            $run = $this->running[$jobId];
            unset($this->running[$jobId]);
            $answer = (string) curl_multi_getcontent($handle);
            $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
            curl_multi_remove_handle($this->multi, $handle);
            $done[(string) $jobId] = $this->read($run, (int) $message['result'], $status, $answer);
        }
        return $done;
    }

    /** Stop a request: its answer is not wanted. */
    public function abandon(string $jobId): void
    {
        if (!isset($this->running[$jobId])) return;
        if ($this->multi !== null) curl_multi_remove_handle($this->multi, $this->running[$jobId]['handle']);
        unset($this->running[$jobId]);
    }

    private function pump(): int
    {
        $active = 0;
        if ($this->multi === null) return 0;
        do {
            $status = curl_multi_exec($this->multi, $active);
        } while ($status === CURLM_CALL_MULTI_PERFORM);
        return $active;
    }

    /** One finished request, read as the delivery reads results. */
    private function read(array $run, int $curlError, int $status, string $answer): array
    {
        if ($curlError === CURLE_OPERATION_TIMEDOUT) return ['ok' => false, 'code' => 'timeout', 'message' => 'The AI did not answer in time.'];
        if ($curlError !== CURLE_OK) return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI could not be reached.'];
        $json = json_decode($answer, true);
        if ($status < 200 || $status >= 300) {
            $said = null;
            if (is_array($json)) {
                $error = $json['error'] ?? null;
                $said = is_array($error) ? ($error['message'] ?? null) : ($error ?? $json['message'] ?? null);
            }
            $message = is_string($said) && trim($said) !== '' ? mb_substr(trim($said), 0, 300) : 'The AI refused the request (HTTP ' . $status . ').';
            $lower = strtolower($message);
            $code = match (true) {
                $status === 413 => 'too_large',
                $status === 429 || $status === 503 => 'busy',
                $status === 504 => 'timeout',
                str_contains($lower, 'is disabled') || str_contains($lower, 'generation is disabled') || str_contains($lower, 'files are not on this computer') => 'model_disabled',
                str_contains($lower, 'unknown') && str_contains($lower, 'model') || str_contains($lower, 'no image model') || ($status === 404 && str_contains($lower, 'model')) => 'model_unknown',
                $status === 400 || $status === 422 => 'bad_request',
                default => 'engine_failed',
            };
            return ['ok' => false, 'code' => $code, 'message' => $message];
        }
        if (!is_array($json)) return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI answered something unreadable.'];
        if ($run['kind'] === 'chat') {
            $text = $json['choices'][0]['message']['content'] ?? null;
            if (!is_string($text)) return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI answered without a reply.'];
            return ['ok' => true, 'text' => mb_substr($text, 0, 32000), 'model' => is_string($json['model'] ?? null) ? $json['model'] : $run['model']];
        }
        $item = $json['data'][0] ?? null;
        $b64 = is_array($item) ? ($item['b64_json'] ?? null) : null;
        $bytes = is_string($b64) ? base64_decode($b64, true) : false;
        if ($bytes === false || $bytes === '') return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI answered without a picture.'];
        $seed = (is_array($item) ? ($item['seed'] ?? null) : null) ?? $json['seed'] ?? $run['seed'];
        $model = (is_array($item) && is_string($item['model'] ?? null)) ? $item['model'] : (is_string($json['model'] ?? null) ? $json['model'] : $run['model']);
        return ['ok' => true, 'picture' => $bytes, 'seed' => is_int($seed) ? $seed : (is_numeric($seed) ? (int) $seed : null), 'model' => $model];
    }
}
