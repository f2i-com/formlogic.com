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
 * - chat: `POST {base}/chat/completions` {model, messages, stream: false, max_tokens}
 * - speech: `POST {speech base}/audio/speech` {input, response_format: "wav", voice?, model?}, to the
 *   server the site names for speech (AI_SPEECH_BASE_URL), never to the one above: OAIY Voice takes
 *   exactly this, as does any OpenAI-style speech server. Its answer is the sound itself, a WAV.
 *
 * A chat or a line may be asked for in parts (`stream` on the job, for an app that takes parts): the
 * chat with `stream: true`, answered as server-sent events, and the line as `response_format: "pcm"`,
 * answered as raw 16-bit mono sound while it is made (OAIY Voice streams it from its first frame).
 * What has come so far is there to read while the request runs (progress); the answer in the end is
 * the same as one asked for whole. A server that answers whole all the same is read as it always was.
 *
 * Every picture request also carries `X-OAIY-Incognito: 1`, which OAIY reads as "keep no copy" and
 * any other server ignores. Redirects are never followed. Answers and errors use the delivery's codes.
 */
final class AppAiUpstream
{
    /** The largest answer read: a 2048 px PNG in base64 is under this. */
    private const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
    /** The most of a chat's answer that is kept when the job says no less (AppAiService::MAX_ANSWER_CHARACTERS). */
    private const MAX_CHAT_CHARACTERS = 32000;
    /** The most sound read for one line: more than a delivery carries (AppAiWorker::MAX_SPEECH_BYTES), so that one too long is told from one cut short. */
    private const MAX_SPEECH_BYTES = 8 * 1024 * 1024;
    /** What a line streamed as raw sound plays at when its server does not say (OAIY Voice: 24 kHz). */
    private const PCM_RATE = 24000;

    private ?\CurlMultiHandle $multi = null;
    /**
     * The requests in flight, by job. `stream`: the answer is read as it comes, into `body`
     * (`type` and `rate` are what the server's headers said of it; `read` is how far `body` has
     * been read as events, `text` the reply those events make so far, `said` an error one named).
     *
     * @var array<string, array{handle: \CurlHandle, kind: string, seed: ?int, model: string, characters: int, voice?: string, stream: bool, body: string, type: string, rate: int, read: int, text: string, said: ?string}>
     */
    private array $running = [];

    /**
     * $config is the upstream (AIService::envUpstream()), or null when the site has none; a closure is
     * asked each time, so a worker that runs for hours (--watch) follows the administrator's switches.
     * $speech is the server that speaks (AIService::envSpeech()), in the same way, or null for none.
     *
     * @param (\Closure(): (array{url: string, key: string, model: string}|null))|array{url: string, key: string, model: string}|null $config
     * @param (\Closure(): (array{url: string, key: string, model: string, voice: string}|null))|array{url: string, key: string, model: string, voice: string}|null $speech
     */
    public function __construct(private \Closure|array|null $config, private int $pictureTimeout = 240, private int $chatTimeout = 120, private \Closure|array|null $speech = null, private int $speechTimeout = 90)
    {
    }

    /** @return ?array{url: string, key: string, model: string} */
    private function config(): ?array
    {
        return $this->config instanceof \Closure ? ($this->config)() : $this->config;
    }

    /** @return ?array{url: string, key: string, model: string, voice: string} */
    private function speech(): ?array
    {
        return $this->speech instanceof \Closure ? ($this->speech)() : $this->speech;
    }

    public function configured(): bool
    {
        $config = $this->config();
        return $config !== null && $config['url'] !== '';
    }

    /** Whether the site names a server that speaks. */
    public function speaks(): bool
    {
        $speech = $this->speech();
        return $speech !== null && $speech['url'] !== '';
    }

    /** Requests in flight, of a lane ('picture' for pictures and edits, 'chat', 'speech'), or all. */
    public function count(?string $lane = null): int
    {
        if ($lane === null) return count($this->running);
        return count(array_filter($this->running, static fn(array $run) => $run['kind'] === $lane));
    }

    public function has(string $jobId): bool
    {
        return isset($this->running[$jobId]);
    }

    /**
     * The jobs asked for and not yet answered, by id.
     *
     * @return list<string>
     */
    public function ids(): array
    {
        return array_map('strval', array_keys($this->running));
    }

    /**
     * Start job $jobId: ['kind' => picture|edit|chat|speech, 'model' => ?string, 'prompt' => string, 'size' => string,
     * 'seed' => ?int, 'reference' => ?data URL, 'messages' => ?list, 'maxTokens' => ?int, 'maxCharacters' => ?int].
     * A null or empty model is the upstream's own. A chat's `maxTokens` is sent as `max_tokens`, and
     * `maxCharacters` is how much of its answer is kept. A speech job's `prompt` is the words to say.
     */
    public function start(string $jobId, array $job): void
    {
        $speech = $job['kind'] === 'speech';
        $config = $speech ? $this->speech() : $this->config();
        if ($config === null || $config['url'] === '') throw new \RuntimeException($speech ? 'The site has no server that speaks' : 'The site has no AI upstream');
        $base = rtrim($config['url'], '/');
        $chat = $job['kind'] === 'chat';
        $model = (string) ($job['model'] ?? '') !== '' ? (string) $job['model'] : $config['model'];
        // In parts: what comes is read as it comes, for the worker to pass on (progress).
        $stream = ($speech || $chat) && ($job['stream'] ?? false) === true;
        if ($speech) {
            $path = '/audio/speech';
            // The sound whole, as a WAV: what a page plays and reads the loudness of. In parts, the
            // sound itself as it is made (16-bit mono), which is put in a WAV here.
            $body = ['input' => (string) $job['prompt'], 'response_format' => $stream ? 'pcm' : 'wav'];
            if ($model !== '') $body['model'] = $model;
            if (($config['voice'] ?? '') !== '') $body['voice'] = $config['voice'];
        } elseif ($chat) {
            $path = '/chat/completions';
            $body = ['model' => $model, 'messages' => $job['messages'], 'stream' => $stream];
            // How long the answer may be, in tokens (the app's `max_output` within the site's ceiling).
            if (is_int($job['maxTokens'] ?? null) && $job['maxTokens'] > 0) $body['max_tokens'] = $job['maxTokens'];
        } else {
            $path = '/images/generations';
            $body = ['model' => $model, 'prompt' => $job['prompt'], 'size' => $job['size'], 'n' => 1, 'response_format' => 'b64_json', 'incognito' => true];
            if (($job['seed'] ?? null) !== null) $body['seed'] = (int) $job['seed'];
            if ($job['kind'] === 'edit') $body['images'] = [(string) $job['reference']];
        }
        $headers = ['Content-Type: application/json', $speech ? ($stream ? 'Accept: audio/pcm, audio/wav' : 'Accept: audio/wav') : ($stream ? 'Accept: text/event-stream, application/json' : 'Accept: application/json')];
        if ($config['key'] !== '') $headers[] = 'Authorization: Bearer ' . $config['key'];
        if (!$chat) $headers[] = 'X-OAIY-Incognito: 1';
        $handle = curl_init($base . $path);
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => $speech ? $this->speechTimeout : ($chat ? $this->chatTimeout : $this->pictureTimeout),
            CURLOPT_MAXFILESIZE => $speech ? self::MAX_SPEECH_BYTES : self::MAX_ANSWER_BYTES,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        ]);
        $this->running[$jobId] = ['handle' => $handle, 'kind' => $speech ? 'speech' : ($chat ? 'chat' : 'picture'), 'seed' => isset($job['seed']) ? (int) $job['seed'] : null, 'model' => $model,
            // How much of a chat's answer is read, whatever the upstream sends back.
            'characters' => is_int($job['maxCharacters'] ?? null) && $job['maxCharacters'] > 0 ? $job['maxCharacters'] : self::MAX_CHAT_CHARACTERS,
            'voice' => $speech ? (string) ($config['voice'] ?? '') : '',
            // An answer in parts: what has come of it, what it says it is, and how far it has been read.
            'stream' => $stream, 'body' => '', 'type' => '', 'rate' => self::PCM_RATE, 'read' => 0, 'text' => '', 'said' => null];
        if ($stream) {
            $limit = $speech ? self::MAX_SPEECH_BYTES : self::MAX_ANSWER_BYTES;
            curl_setopt($handle, CURLOPT_HEADERFUNCTION, function ($handle, string $line) use ($jobId): int {
                if (isset($this->running[$jobId]) && preg_match('/^(content-type|x-sample-rate)\s*:\s*(.+)$/i', trim($line), $found) === 1) {
                    if (strtolower($found[1]) === 'content-type') $this->running[$jobId]['type'] = strtolower(trim($found[2]));
                    elseif (ctype_digit(trim($found[2])) && (int) $found[2] >= 8000 && (int) $found[2] <= 96000) $this->running[$jobId]['rate'] = (int) $found[2];
                }
                return strlen($line);
            });
            curl_setopt($handle, CURLOPT_WRITEFUNCTION, function ($handle, string $data) use ($jobId, $limit): int {
                // Too much, or nobody waiting for it any more: the transfer is ended.
                if (!isset($this->running[$jobId]) || strlen($this->running[$jobId]['body']) + strlen($data) > $limit) return 0;
                $this->running[$jobId]['body'] .= $data;
                return strlen($data);
            });
        }
        $this->multi ??= curl_multi_init();
        curl_multi_add_handle($this->multi, $handle);
        // Under way at once: the request is sent while the worker goes on with its other work.
        $this->pump();
    }

    /**
     * Move the requests along, waiting at most $wait seconds, and answer those that finished, by job:
     * ['ok' => true, 'picture' => bytes, 'seed' => ?int, 'model' => …], ['ok' => true, 'text' => …, 'model' => …],
     * ['ok' => true, 'audio' => a WAV's bytes, 'voice' => …, 'model' => …], or ['ok' => false, 'code' => …, 'message' => …].
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
            $answer = $run['stream'] ? $run['body'] : (string) curl_multi_getcontent($handle);
            $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
            curl_multi_remove_handle($this->multi, $handle);
            $done[(string) $jobId] = $this->read($run, (int) $message['result'], $status, $answer);
        }
        return $done;
    }

    /**
     * What has come so far of the answers asked for in parts, by job: a chat's reply as far as it is
     * written (['text' => …]), a line's sound as far as it is made (['pcm' => 16-bit mono sound,
     * 'rate' => samples a second]). A job whose server answers whole, or has sent nothing yet, is
     * not here. Call it after poll(), which moves the requests along.
     *
     * @return array<string, array{text: string}|array{pcm: string, rate: int}>
     */
    public function progress(): array
    {
        $so = [];
        foreach ($this->running as $jobId => $run) {
            if (!$run['stream'] || $run['body'] === '') continue;
            if ($run['kind'] === 'chat' && str_contains($run['type'], 'text/event-stream')) {
                $this->readEvents($this->running[$jobId], false);
                if ($this->running[$jobId]['text'] !== '') $so[(string) $jobId] = ['text' => mb_substr($this->running[$jobId]['text'], 0, (int) $run['characters'])];
            } elseif ($run['kind'] === 'speech' && self::isPcm($run['type'])) {
                $so[(string) $jobId] = ['pcm' => substr($run['body'], 0, strlen($run['body']) & ~1), 'rate' => (int) $run['rate']];
            }
        }
        return $so;
    }

    /** Raw sound in a WAV: 16-bit mono at $rate samples a second, under the usual 44-byte header. */
    public static function wav(string $pcm, int $rate): string
    {
        $pcm = substr($pcm, 0, strlen($pcm) & ~1);
        return 'RIFF' . pack('V', 36 + strlen($pcm)) . 'WAVEfmt ' . pack('VvvVVvv', 16, 1, 1, $rate, $rate * 2, 2, 16) . 'data' . pack('V', strlen($pcm)) . $pcm;
    }

    private static function isPcm(string $type): bool
    {
        return str_starts_with($type, 'audio/pcm') || str_starts_with($type, 'audio/l16');
    }

    /**
     * Read what has come of a chat answered as server-sent events (`data: {…}` lines, each a piece of
     * the reply in `choices[0].delta.content`) into the run's text, from where the last reading stopped.
     * Only whole lines are read, unless this is the end ($ended).
     */
    private function readEvents(array &$run, bool $ended): void
    {
        $end = $ended ? strlen($run['body']) : strrpos($run['body'], "\n");
        if ($end === false || $end <= $run['read']) return;
        $fresh = substr($run['body'], $run['read'], $end - $run['read']);
        $run['read'] = $end;
        foreach (preg_split('/\r?\n/', $fresh) ?: [] as $line) {
            if (!str_starts_with($line, 'data:')) continue;
            $data = trim(substr($line, 5));
            if ($data === '' || $data === '[DONE]') continue;
            $event = json_decode($data, true);
            if (!is_array($event)) continue;
            if (isset($event['error'])) {
                $error = $event['error'];
                $run['said'] = mb_substr(is_array($error) ? (string) ($error['message'] ?? 'The AI could not answer.') : (string) $error, 0, 300);
                continue;
            }
            if (is_string($event['model'] ?? null) && $event['model'] !== '') $run['model'] = $event['model'];
            $piece = $event['choices'][0]['delta']['content'] ?? null;
            if (is_string($piece)) $run['text'] .= $piece;
        }
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
        // (An answer in parts that ran past what is read ended its own transfer: too large, not unreachable.)
        if ($curlError === CURLE_WRITE_ERROR && $run['stream']) return ['ok' => false, 'code' => 'too_large', 'message' => 'The AI\'s answer was too long to take.'];
        if ($curlError !== CURLE_OK) return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI could not be reached.'];
        // An answer that came in parts, read to its end.
        if ($run['stream'] && $status >= 200 && $status < 300) {
            if ($run['kind'] === 'chat' && str_contains($run['type'], 'text/event-stream')) {
                $this->readEvents($run, true);
                if ($run['text'] === '') return ['ok' => false, 'code' => 'engine_failed', 'message' => $run['said'] ?? 'The AI answered without a reply.'];
                return ['ok' => true, 'text' => mb_substr($run['text'], 0, (int) $run['characters']), 'model' => $run['model']];
            }
            if ($run['kind'] === 'speech' && self::isPcm($run['type'])) {
                if (strlen($answer) < 2) return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI answered without a sound.'];
                return ['ok' => true, 'audio' => self::wav($answer, (int) $run['rate']), 'voice' => (string) ($run['voice'] ?? ''), 'model' => $run['model']];
            }
        }
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
        if ($run['kind'] === 'speech') {
            // The sound itself, a WAV, and nothing else: words where a sound was asked for are no speech.
            if (strlen($answer) < 44 || substr($answer, 0, 4) !== 'RIFF' || substr($answer, 8, 4) !== 'WAVE') return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI answered without a sound.'];
            return ['ok' => true, 'audio' => $answer, 'voice' => (string) ($run['voice'] ?? ''), 'model' => $run['model']];
        }
        if (!is_array($json)) return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI answered something unreadable.'];
        if ($run['kind'] === 'chat') {
            $text = $json['choices'][0]['message']['content'] ?? null;
            if (!is_string($text)) return ['ok' => false, 'code' => 'engine_failed', 'message' => 'The AI answered without a reply.'];
            return ['ok' => true, 'text' => mb_substr($text, 0, (int) ($run['characters'] ?? self::MAX_CHAT_CHARACTERS)), 'model' => is_string($json['model'] ?? null) ? $json['model'] : $run['model']];
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
