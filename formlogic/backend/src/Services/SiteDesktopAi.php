<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The site's AI served by the administrator's own OAIY (docs/AGE_GATE_AND_SITE_AI.md, part 1).
 *
 * The server is the sealing client on the desktop AI lane, as a member's browser is for their own
 * desktop: for each turn it makes a fresh X25519 key, seals the turn to the OAIY key the
 * administrator pinned, queues it for that desktop with the member as the requester, and opens the
 * sealed frames OAIY sends back. PHP's sodium box is the browser's tweetnacl box, byte for byte
 * (docs/contracts/e2e-envelope-vectors.json), so OAIY needs no change for this.
 *
 * A turn never carries a tool grant or a tool mode. Without one OAIY's tunnel runs no tool and no
 * flow, so no member can make the administrator's machine act. OAIY passes on only the messages
 * (and a model), so a caller's own tools and limits do not reach the engine either.
 */
final class SiteDesktopAi
{
    public const PROVIDER = 'oaiy-engine';
    /**
     * Turns the site's OAIY may have waiting or running at once. It answers one at a time, and each
     * waiting turn holds a PHP worker, so past this the next is told busy at once (the lane's own
     * cap, 8 a desktop, would drain a small pool first).
     */
    public const MAX_WAITING = 3;
    private const NONCE_BYTES = 24;
    private const POLL_MICROSECONDS = 250000;
    private const HEARTBEAT_SECONDS = 15;

    /** @var \Closure(int):void how the reader waits between polls; a test steps the desktop here */
    private \Closure $wait;

    public function __construct(
        private DesktopAiRelayService $relay,
        private SiteAiDesktopSettings $settings,
        ?\Closure $wait = null,
    ) {
        $this->wait = $wait ?? static function (int $microseconds): void {
            usleep($microseconds);
        };
    }

    /** The administrator's OAIY this site's AI goes to, or null when it uses the .env upstream. */
    public function active(): ?array
    {
        return $this->settings->current();
    }

    /**
     * One turn, start to finish. $requester is the member asking (their in-flight limit applies);
     * null is the site's owner, for work no member started. Throws SiteAiBusyException when the
     * desktop's queue is full, so a request is answered at once rather than holding a worker.
     *
     * @param array<int, array<string, mixed>> $messages
     * @return array{content: string, usage: array{promptTokens: int, completionTokens: int, totalTokens: int}}
     */
    public function chat(array $messages, ?string $requester, ?callable $onDelta, ?callable $onHeartbeat, int $timeoutSeconds): array
    {
        $site = $this->active() ?? throw new \RuntimeException('This site\'s AI is not served from OAIY.');
        [$id, $pair] = $this->send($site, ['kind' => 'chat', 'messages' => array_values($messages)], $requester);
        try {
            $answer = $this->read($id, $site['ownerUserId'], $pair, $onDelta, $onHeartbeat, $timeoutSeconds);
            unset($answer['final']);
            return $answer;
        } catch (\Throwable $e) {
            // Nobody waits for it now: the computer must not spend its one lane on it later.
            $this->relay->abandon($id, $site['ownerUserId']);
            throw $e;
        } finally {
            sodium_memzero($pair);
        }
    }

    /**
     * Seal one turn to $target (a pinned computer: ownerUserId, connectionId, instanceId, publicKey,
     * providerId) and queue it, the member $requester asking (null: the computer's owner). $body is
     * the turn's own part: `kind` (chat, models or providers), and `messages` and `model` for a chat.
     * Never a tool grant. Returns [requestId, the turn's key pair]: the frames back open with it.
     * Refused at once when the computer is offline or already has MAX_WAITING turns.
     *
     * @return array{0: string, 1: string}
     */
    public function send(array $target, array $body, ?string $requester): array
    {
        $desktopKey = base64_decode((string) ($target['publicKey'] ?? ''), true);
        if ($desktopKey === false || strlen($desktopKey) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) {
            throw new \RuntimeException('The pinned OAIY key is unreadable. Choose the computer again in Admin.');
        }
        $kind = (string) ($body['kind'] ?? 'chat');
        unset($body['kind'], $body['toolGrant'], $body['toolMode']);
        $ephemeral = sodium_crypto_box_keypair();
        $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey(sodium_crypto_box_secretkey($ephemeral), $desktopKey);
        $turn = [
            'v' => 1,
            'kind' => $kind,
            'providerId' => $target['providerId'],
            'threadId' => 'site-' . bin2hex(random_bytes(12)),
            'clientSeq' => 1,
        ] + $body;
        $envelope = self::seal($turn, 0, 0, $pair);
        if (strlen((string) base64_decode($envelope, true)) > DesktopAiRelayService::MAX_ENVELOPE_BYTES) {
            sodium_memzero($ephemeral);
            sodium_memzero($pair);
            throw new SiteAiTooLargeException('This is too large for the site\'s AI on OAIY, which takes about 250 KB a request. Use a smaller picture or fewer of them.');
        }
        if (($refusal = $this->unavailableFor($target)) !== null) {
            sodium_memzero($ephemeral);
            sodium_memzero($pair);
            throw $refusal;
        }

        try {
            $queued = $this->relay->enqueue($target['ownerUserId'], $requester ?? $target['ownerUserId'], [
                'kind' => $kind,
                'providerId' => $target['providerId'],
                'targetInstanceId' => $target['instanceId'],
                'ephPub' => base64_encode(sodium_crypto_box_publickey($ephemeral)),
                'envelope' => $envelope,
            ]);
        } catch (\RuntimeException $e) {
            sodium_memzero($pair);
            if (in_array($e->getMessage(), ['queue_full_user', 'queue_full_desktop'], true)) {
                throw new SiteAiBusyException($e->getMessage() === 'queue_full_user'
                    ? 'You already have requests waiting for the site\'s AI. Try again when they finish.'
                    : 'The site\'s AI is busy with other people\'s requests. Try again in a moment.');
            }
            throw $e;
        } finally {
            sodium_memzero($ephemeral);
        }
        return [(string) $queued['request']['requestId'], $pair];
    }

    /**
     * One turn to $target, waited for to its final frame: for the listings (`models`,
     * `providers`), which a computer answers without running a model. Returns the final frame.
     */
    public function request(array $target, array $body, int $timeoutSeconds): array
    {
        [$id, $pair] = $this->send($target, $body, null);
        try {
            return $this->read($id, $target['ownerUserId'], $pair, null, null, $timeoutSeconds)['final'] ?? [];
        } catch (\Throwable $e) {
            $this->relay->abandon($id, $target['ownerUserId']);
            throw $e;
        } finally {
            sodium_memzero($pair);
        }
    }

    /**
     * What a queued turn has sent back so far, without waiting: its status (pending, claimed,
     * streaming, done, failed, expired), the text so far, the final frame once there is one, and
     * the computer's error when it sent one. Read from the first frame each time, so nothing of
     * the answer is kept between polls.
     *
     * @return array{status: ?string, content: string, final: ?array, error: ?string}
     */
    public function collect(string $id, string $owner, string $pair): array
    {
        $content = '';
        $final = null;
        $error = null;
        $since = 0;
        $expect = 0;
        do {
            $rows = $this->relay->fetchOutput($id, $owner, $since);
            foreach ($rows as $row) {
                $since = $row['seq'];
                $frame = self::open($row['envelope'], 1, $expect++, $pair);
                $kind = $frame['kind'] ?? $frame['type'] ?? null;
                if ($kind === 'delta') {
                    $content .= self::text($frame['delta'] ?? $frame['text'] ?? null);
                } elseif ($kind === 'final' || $kind === 'done') {
                    $final = $frame;
                    if ($content === '') {
                        $content = self::text($frame['completion'] ?? $frame['text'] ?? null);
                    }
                } elseif ($kind === 'error' || $kind === 'failed') {
                    $error = is_string($frame['message'] ?? null) ? $frame['message'] : 'OAIY could not answer.';
                }
            }
        } while (count($rows) >= 200);
        return ['status' => $this->relay->getStatus($id, $owner), 'content' => $content, 'final' => $final, 'error' => $error];
    }

    /** Give up on a queued turn: if the computer has not taken it, it never will. */
    public function abandon(string $id, string $owner): void
    {
        $this->relay->abandon($id, $owner);
    }

    /** Why $target cannot take a turn now, or null. */
    public function unavailableFor(array $target): ?SiteAiBusyException
    {
        if (!$this->settings->online($target)) {
            return new SiteAiBusyException('The computer the site\'s AI runs on is offline. Try again later.', 'site_ai_offline');
        }
        if ($this->relay->inFlightForTarget($target['ownerUserId'], $target['instanceId']) >= self::MAX_WAITING) {
            return new SiteAiBusyException('The site\'s AI is busy with other people\'s requests. Try again in a moment.');
        }
        return null;
    }

    /**
     * Why the site's OAIY cannot take a turn now, or null. Checked before a turn is queued, and by
     * callers that want to say so before they start (AIController::meterGeneration).
     */
    public function unavailable(): ?SiteAiBusyException
    {
        $site = $this->active();
        return $site === null ? null : $this->unavailableFor($site);
    }

    /** The sealed frames of one turn, opened in order, to its final frame. */
    private function read(string $id, string $owner, string $pair, ?callable $onDelta, ?callable $onHeartbeat, int $timeoutSeconds): array
    {
        $content = '';
        $listed = [];
        $since = 0;
        $expect = 0;
        $deadline = microtime(true) + max(5, $timeoutSeconds);
        $beat = microtime(true);
        while (true) {
            foreach ($this->relay->fetchOutput($id, $owner, $since) as $row) {
                $since = $row['seq'];
                $frame = self::open($row['envelope'], 1, $expect++, $pair);
                $kind = $frame['kind'] ?? $frame['type'] ?? null;
                if ($kind === 'delta') {
                    $text = self::text($frame['delta'] ?? $frame['text'] ?? null);
                    if ($text !== '') {
                        $content .= $text;
                        if ($onDelta !== null) {
                            $onDelta($text);
                        }
                    }
                } elseif ($kind === 'models' || $kind === 'providers') {
                    // A listing can come in a frame of its own before the final one.
                    if (is_array($frame[$kind] ?? null)) {
                        $listed[$kind] = $frame[$kind];
                    }
                } elseif ($kind === 'final' || $kind === 'done') {
                    // A final frame after a stream is empty; one without a stream holds the answer.
                    if ($content === '') {
                        $content = self::text($frame['completion'] ?? $frame['text'] ?? null);
                        if ($content !== '' && $onDelta !== null) {
                            $onDelta($content);
                        }
                    }
                    return ['content' => $content, 'usage' => ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0], 'final' => $frame + $listed];
                } elseif ($kind === 'error' || $kind === 'failed') {
                    $message = is_string($frame['message'] ?? null) ? $frame['message'] : 'OAIY could not answer.';
                    throw new \RuntimeException('The site\'s AI (OAIY) could not answer: ' . $message);
                }
            }
            $status = $this->relay->getStatus($id, $owner);
            if (in_array($status, ['failed', 'expired'], true) || $status === null) {
                throw new \RuntimeException($status === 'expired'
                    ? 'The site\'s AI did not pick this up in time. The computer it runs on may be off.'
                    : 'The site\'s AI (OAIY) could not answer.');
            }
            if ($status === 'done') {
                // Done with every frame read: the answer is what came.
                return ['content' => $content, 'usage' => ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0], 'final' => $listed];
            }
            if (microtime(true) > $deadline) {
                throw new \RuntimeException('The site\'s AI took too long to answer.');
            }
            if ($onHeartbeat !== null && microtime(true) - $beat >= self::HEARTBEAT_SECONDS) {
                $beat = microtime(true);
                $onHeartbeat();
            }
            ($this->wait)(self::POLL_MICROSECONDS);
        }
    }

    /** base64(nonce || box): byte 0 of the nonce is the direction, its last 8 bytes the counter. */
    public static function seal(array $body, int $direction, int $counter, string $pair): string
    {
        $nonce = self::nonce($direction, $counter);
        return base64_encode($nonce . sodium_crypto_box(json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), $nonce, $pair));
    }

    /** One frame opened; refused unless it is the next one from the desktop. */
    public static function open(string $envelope, int $direction, int $counter, string $pair): array
    {
        $raw = base64_decode($envelope, true);
        if ($raw === false || strlen($raw) <= self::NONCE_BYTES) {
            throw new \RuntimeException('OAIY sent an unreadable frame.');
        }
        $nonce = substr($raw, 0, self::NONCE_BYTES);
        if (!hash_equals(self::nonce($direction, $counter), $nonce)) {
            throw new \RuntimeException('OAIY sent a frame out of order.');
        }
        $plain = sodium_crypto_box_open(substr($raw, self::NONCE_BYTES), $nonce, $pair);
        if ($plain === false) {
            throw new \RuntimeException('A frame did not open with this site\'s key: OAIY may have a new key. Choose the computer again in Admin.');
        }
        $frame = json_decode($plain, true);
        return is_array($frame) ? $frame : [];
    }

    public static function nonce(int $direction, int $counter): string
    {
        return chr($direction) . str_repeat("\0", 15) . pack('J', $counter);
    }

    /** Text from a frame's value: a string, or an OpenAI completion or chunk. */
    private static function text(mixed $value): string
    {
        if (is_string($value)) {
            return $value;
        }
        if (!is_array($value) || !is_array($value['choices'] ?? null)) {
            return '';
        }
        $text = '';
        foreach ($value['choices'] as $choice) {
            if (!is_array($choice)) {
                continue;
            }
            $piece = $choice['delta']['content'] ?? $choice['message']['content'] ?? $choice['text'] ?? null;
            $text .= is_string($piece) ? $piece : '';
        }
        return $text;
    }
}
