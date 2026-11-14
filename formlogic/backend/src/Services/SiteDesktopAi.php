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
 *
 * The same lane carries the work FormLogic sends to a person's own computer ("Use my OAIY" for an
 * app, a computer's listings): what is said when it cannot take a turn names that computer, not the
 * site's AI, whenever the person asking is its owner.
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
    /**
     * Pictures a computer may have waiting or being drawn at once (App AI). They have a lane of their
     * own (DesktopAiRelayService::PICTURE_KIND), so a picture never takes one of the chat places, and
     * OAIY draws one at a time: a second would wait unclaimed, and could run out of time waiting.
     */
    public const MAX_PICTURES_WAITING = 1;
    /** How long a computer's listing (listing, listed) is waited for before it is cancelled. */
    public const LISTING_SECONDS = 20;
    private const NONCE_BYTES = 24;
    /**
     * The largest frame the server opens: the most OAIY seals in one (256 KiB of plain text, its
     * MAX_ENVELOPE_PLAINTEXT_BYTES), with the nonce and the box's tag. The lane keeps frames of up to
     * DesktopAiRelayService::MAX_FRAME_BYTES for browsers that read their own computer's answers; a
     * larger one is no frame OAIY sent, and is refused without being read into this process.
     */
    public const MAX_FRAME_BYTES = 262144 + self::NONCE_BYTES + SODIUM_CRYPTO_BOX_MACBYTES;
    /** Frames read at a time: at most about 8 MB of the largest, never the lane's 200 of 4 MiB. */
    private const FRAMES_PER_READ = 32;
    /**
     * The most text collect() reads of a turn whose reader names no limit: a picture's turn (its
     * picture comes whole in its final frame, after progress frames with no text), a camera check's
     * short answer, a listing (its lists come in frames of their own). Past it a turn is no answer
     * OAIY gives, and its reader is not made to hold it.
     */
    public const MAX_COLLECTED_BYTES = 1048576;
    private const POLL_MICROSECONDS = 250000;
    private const HEARTBEAT_SECONDS = 15;

    /** @var \Closure(int):void how the reader waits between polls; a test steps the desktop here */
    private \Closure $wait;
    /** @var array<string, string> turns this process is reading (id => owner), cancelled should it end first (guard) */
    private array $reading = [];
    private bool $guarded = false;

    /**
     * @param ?string $secret the server's key for a listing's turn keys (listing, listed), derived from
     *                        the JWT secret by the container; listings are refused without one
     */
    public function __construct(
        private DesktopAiRelayService $relay,
        private SiteAiDesktopSettings $settings,
        ?\Closure $wait = null,
        private ?string $secret = null,
    ) {
        $this->wait = $wait ?? static function (int $microseconds): void {
            usleep($microseconds);
        };
    }

    /** The administrator's OAIY this site's AI goes to, or null when it uses the .env upstream or its computer is gone. */
    public function active(): ?array
    {
        return $this->settings->current();
    }

    /**
     * Whether the administrator chose to serve the site's AI from OAIY, whether or not that computer
     * still stands. A computer that was unlinked, given a new key or whose administrator lost the role
     * is not replaced by the .env upstream: work nobody chose to send there is refused instead
     * (unavailable()). The .env upstream serves only when no computer was chosen.
     */
    public function chosen(): bool
    {
        return $this->settings->current() !== null || $this->settings->gone() !== null;
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
        // A provider stored in OAIY is asked for the model chosen for it; OAIY's own engine uses its own.
        $body = ['kind' => 'chat', 'messages' => array_values($messages)] + (($site['model'] ?? null) !== null ? ['model' => $site['model']] : []);
        [$id, $pair] = $this->send($site, $body, $requester);
        $this->guard($id, $site['ownerUserId']);
        try {
            $answer = $this->read($id, $site['ownerUserId'], $pair, $onDelta, $onHeartbeat, $timeoutSeconds, self::owns($site, $requester));
            unset($answer['final']);
            return $answer;
        } catch (\Throwable $e) {
            // Nobody waits for it now: the computer is told to stop, whether it has started on it or not.
            $this->letGo($id, $site['ownerUserId']);
            throw $e;
        } finally {
            $this->unguard($id);
            sodium_memzero($pair);
        }
    }

    /**
     * Seal one turn to $target (a pinned computer: ownerUserId, connectionId, instanceId, publicKey,
     * providerId) and queue it, the member $requester asking (null: the computer's owner). $body is
     * the turn's own part: `kind` (chat, models, providers, or image for App AI's pictures), and
     * `messages` and `model` for a chat, or a picture's fields (OAIY-LANE: model, prompt, size,
     * seed, reference, incognito; a picture has no chat thread). Never a tool grant. $source is
     * DesktopAiRelayService::SOURCE_APP_AI for App AI's worker, which keeps its own limits.
     * $keypair is the turn's own X25519 key pair (sodium's 64 bytes) where the caller derives one
     * (listing); else a fresh one is made. Returns [requestId, the turn's box key pair]: the frames
     * back open with it. Refused at once when the computer is offline, or already has MAX_WAITING
     * turns (MAX_PICTURES_WAITING pictures), counted under the lane's lock as the turn is queued.
     *
     * @return array{0: string, 1: string}
     */
    public function send(array $target, array $body, ?string $requester, ?string $source = null, ?string $keypair = null): array
    {
        $own = self::owns($target, $requester);
        $desktopKey = base64_decode((string) ($target['publicKey'] ?? ''), true);
        if ($desktopKey === false || strlen($desktopKey) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) {
            throw new \RuntimeException($own
                ? 'The chat key pinned for that computer is unreadable. Choose the computer again.'
                : 'The pinned OAIY key is unreadable. Choose the computer again in Admin.');
        }
        if ($keypair !== null && strlen($keypair) !== SODIUM_CRYPTO_BOX_KEYPAIRBYTES) {
            throw new \InvalidArgumentException('A turn\'s key pair is ' . SODIUM_CRYPTO_BOX_KEYPAIRBYTES . ' bytes.');
        }
        $turn = self::turn($target, $body);
        $kind = (string) $turn['kind'];
        $picture = $kind === DesktopAiRelayService::PICTURE_KIND;
        $ephemeral = $keypair ?? sodium_crypto_box_keypair();
        $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey(sodium_crypto_box_secretkey($ephemeral), $desktopKey);
        $envelope = self::seal($turn, 0, 0, $pair);
        if (strlen((string) base64_decode($envelope, true)) > DesktopAiRelayService::MAX_ENVELOPE_BYTES) {
            sodium_memzero($ephemeral);
            sodium_memzero($pair);
            throw new SiteAiTooLargeException($own
                ? 'This is too large for OAIY, which takes about 250 KB a request. Use a smaller picture or fewer of them.'
                : 'This is too large for the site\'s AI on OAIY, which takes about 250 KB a request. Use a smaller picture or fewer of them.');
        }
        // Said before anything is queued. How many turns wait is counted as this one is queued, under
        // the lane's lock (enqueue): counted here, two at once could both find the last place free.
        if (!$this->settings->online($target)) {
            sodium_memzero($ephemeral);
            sodium_memzero($pair);
            throw self::offline($own);
        }

        try {
            $queued = $this->relay->enqueue($target['ownerUserId'], $requester ?? $target['ownerUserId'], [
                'kind' => $kind,
                'providerId' => $target['providerId'],
                'targetInstanceId' => $target['instanceId'],
                'ephPub' => base64_encode(sodium_crypto_box_publickey($ephemeral)),
                'envelope' => $envelope,
            ], $source, $picture ? self::MAX_PICTURES_WAITING : self::MAX_WAITING);
        } catch (\RuntimeException $e) {
            sodium_memzero($pair);
            $busy = match ($e->getMessage()) {
                'queue_full_user' => new SiteAiBusyException($own
                    ? 'You already have requests waiting for that computer. Try again when they finish.'
                    : 'You already have requests waiting for the site\'s AI. Try again when they finish.'),
                'queue_full_desktop' => self::busy($own, false),
                'queue_full_lane' => self::busy($own, $picture),
                default => null,
            };
            throw $busy ?? $e;
        } finally {
            sodium_memzero($ephemeral);
        }
        return [(string) $queued['request']['requestId'], $pair];
    }

    /**
     * The turn as it is sealed for $target: `v`, `kind` and `providerId`, a chat's thread of its own
     * (a picture, DesktopAiRelayService::PICTURE_KIND, has none), then $body's own fields. Never a
     * tool grant or a tool mode.
     */
    private static function turn(array $target, array $body): array
    {
        $kind = (string) ($body['kind'] ?? 'chat');
        unset($body['kind'], $body['toolGrant'], $body['toolMode']);
        $head = ['v' => 1, 'kind' => $kind, 'providerId' => $target['providerId']];
        if ($kind !== DesktopAiRelayService::PICTURE_KIND) {
            $head += ['threadId' => 'site-' . bin2hex(random_bytes(12)), 'clientSeq' => 1];
        }
        return $head + $body;
    }

    /**
     * How many more bytes a turn to $target with $body could carry and still be sealed within the
     * lane's request limit (DesktopAiRelayService::MAX_ENVELOPE_BYTES): App AI fits the picture an
     * edit sends to it, whatever the prompt's characters take once written as JSON.
     */
    public static function room(array $target, array $body): int
    {
        $plain = strlen(json_encode(self::turn($target, $body), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        return DesktopAiRelayService::MAX_ENVELOPE_BYTES - self::NONCE_BYTES - SODIUM_CRYPTO_BOX_MACBYTES - $plain;
    }

    /**
     * One turn to $target, waited for to its final frame: for a listing (`models`, `providers`)
     * where the caller can wait. Returns the final frame. The listing routes ask with listing() and
     * listed() instead, so no PHP worker is held while the computer answers.
     */
    public function request(array $target, array $body, int $timeoutSeconds): array
    {
        [$id, $pair] = $this->send($target, $body, null);
        $this->guard($id, $target['ownerUserId']);
        try {
            return $this->read($id, $target['ownerUserId'], $pair, null, null, $timeoutSeconds, true)['final'] ?? [];
        } catch (\Throwable $e) {
            $this->letGo($id, $target['ownerUserId']);
            throw $e;
        } finally {
            $this->unguard($id);
            sodium_memzero($pair);
        }
    }

    /**
     * Ask $target for a listing ($body: kind `models` or `providers`) and return at once, with the
     * handle to read it by (listed): "<requestId>.<token>". The turn's key pair is derived from the
     * token and the server's secret (listingKeys), so nothing is kept between the asking and the
     * reading, and only a handle this server gave out opens what comes back. The computer's owner
     * asks: only their own requests are read back (DesktopAiRelayService's owner scope).
     */
    public function listing(array $target, array $body): string
    {
        $token = bin2hex(random_bytes(16));
        $keypair = $this->listingKeys($token);
        try {
            [$id, $pair] = $this->send($target, $body, null, null, $keypair);
        } finally {
            sodium_memzero($keypair);
        }
        sodium_memzero($pair);
        return $id . '.' . $token;
    }

    /**
     * What the listing $handle (listing) has come back with, read once without waiting: its final
     * frame with the listing kept from its own frames (as request() answers it), or null while the
     * computer has not answered. Throws when the computer failed or never took it, when it is not
     * $target's owner's (it reads as gone, as one long purged does), or once LISTING_SECONDS have
     * passed since it was asked, when it is cancelled first.
     */
    public function listed(array $target, string $handle): ?array
    {
        [$id, $owner, $keypair] = $this->listingOf($target, $handle);
        $desktopKey = base64_decode((string) ($target['publicKey'] ?? ''), true);
        if ($desktopKey === false || strlen($desktopKey) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) {
            sodium_memzero($keypair);
            throw new \RuntimeException('The chat key pinned for that computer is unreadable. Choose the computer again.');
        }
        $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey(sodium_crypto_box_secretkey($keypair), $desktopKey);
        sodium_memzero($keypair);
        try {
            $seen = $this->collect($id, $owner, $pair);
        } finally {
            sodium_memzero($pair);
        }
        if ($seen['error'] !== null) {
            throw new \RuntimeException('OAIY on that computer could not answer: ' . $seen['error']);
        }
        if ($seen['final'] !== null) {
            return $seen['final'] + $seen['listed'];
        }
        return match ($seen['status']) {
            'done' => $seen['listed'],
            'failed' => throw new \RuntimeException('OAIY on that computer could not answer.'),
            'expired' => throw new \RuntimeException($seen['taken'] ? 'That computer stopped answering before it sent the list.' : 'That computer did not pick this up in time. It may be off.'),
            null => throw new \RuntimeException('That computer\'s answer is no longer here. Ask again.'),
            default => $this->stillWaiting($id, $owner, $seen['age']),
        };
    }

    /** A listing not answered yet: null while there is time, else cancelled, and said. */
    private function stillWaiting(string $id, string $owner, int $age): ?array
    {
        if ($age < self::LISTING_SECONDS) return null;
        $this->letGo($id, $owner);
        throw new \RuntimeException('That computer took too long to answer.');
    }

    /**
     * Let go of the listing $handle before it is answered: its page stopped reading it (another
     * computer chosen, the page closed, or it gave up waiting), so the computer is not left to answer
     * nobody, and the place it holds (a person's own, and one of the computer's) is free at once.
     * Answers whether one was still open. Only a listing this site gave out (listingOf).
     */
    public function letGoListing(array $target, string $handle): bool
    {
        [$id, $owner, $keypair] = $this->listingOf($target, $handle);
        sodium_memzero($keypair);
        return $this->relay->cancel($id, $owner);
    }

    /**
     * The listing $handle names, as [requestId, owner, key pair], refused unless it is one this site
     * gave $target's owner: a request of theirs whose kind is a listing and that was sealed with the
     * key the handle's token makes (listingKeys). So a request id with any other token, or any other
     * request of the owner's, is no listing here, and is neither read nor let go. The caller zeroes
     * the key pair.
     *
     * @return array{0: string, 1: string, 2: string}
     */
    private function listingOf(array $target, string $handle): array
    {
        $refused = static fn () => new \InvalidArgumentException('That listing is not one this site asked for. Ask again.');
        if (!preg_match('/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{32})$/D', $handle, $m)) {
            throw $refused();
        }
        [, $id, $token] = $m;
        $owner = (string) $target['ownerUserId'];
        $progress = $this->relay->progress($id, $owner);
        if ($progress === null) {
            throw new \RuntimeException('That computer\'s answer is no longer here. Ask again.');
        }
        $keypair = $this->listingKeys($token);
        $made = base64_encode(sodium_crypto_box_publickey($keypair));
        if (!in_array($progress['kind'], ['models', 'providers'], true) || !hash_equals($progress['ephPub'], $made)) {
            sodium_memzero($keypair);
            throw $refused();
        }
        return [$id, $owner, $keypair];
    }

    /**
     * A listing turn's X25519 key pair: sodium's seed key pair of an HMAC of its token under the
     * server's secret. Anyone may hold a token; without the secret it opens nothing.
     */
    private function listingKeys(string $token): string
    {
        if ($this->secret === null || strlen($this->secret) < 16) {
            throw new \RuntimeException('Listings need the server\'s secret, and none is set here.');
        }
        return sodium_crypto_box_seed_keypair(hash_hmac('sha256', 'oaiy-listing|' . $token, $this->secret, true));
    }

    /**
     * What a queued turn has sent back so far, without waiting: its status (pending, claimed,
     * streaming, done, failed, expired), the text so far, the final frame once there is one, the
     * computer's error when it sent one, the listings it sent in frames of their own (`listed`:
     * kind => list, as read() keeps them), whether the computer ever took it (`taken`), and how
     * many seconds ago it was asked (`age`, by the database's clock). Read from the first frame
     * each time, so nothing of the answer is kept between polls. Reading stops once $enough bytes
     * of text are in, MAX_COLLECTED_BYTES where a reader says nothing: a reader that wants no more
     * is not made to hold the rest, and none is made to hold all a computer may send (a turn's
     * frames may come to 64 MiB, read again on every poll). $gapless: a frame missing is an error
     * (readFrames), for a reader that decides on the whole answer.
     *
     * @return array{status: ?string, content: string, final: ?array, error: ?string, listed: array<string, array>, taken: bool, age: int}
     */
    public function collect(string $id, string $owner, string $pair, ?int $enough = null, bool $gapless = false): array
    {
        $enough ??= self::MAX_COLLECTED_BYTES;
        // The status first: a computer sends its frames before it completes a turn, so a turn read as
        // done here has every frame it will ever have below, and its final frame is never missed.
        $progress = $this->relay->progress($id, $owner);
        $content = '';
        $final = null;
        $error = null;
        $listed = [];
        $this->readFrames($id, $owner, $pair, 0, -1, static function (array $frame) use (&$content, &$final, &$error, &$listed, $enough): bool {
            $kind = $frame['kind'] ?? $frame['type'] ?? null;
            if ($kind === 'delta') {
                $content .= self::text($frame['delta'] ?? $frame['text'] ?? null);
            } elseif ($kind === 'models' || $kind === 'providers') {
                if (is_array($frame[$kind] ?? null)) {
                    $listed[$kind] = $frame[$kind];
                }
            } elseif ($kind === 'final' || $kind === 'done') {
                $final = $frame;
                if ($content === '') {
                    $content = self::text($frame['completion'] ?? $frame['text'] ?? null);
                }
            } elseif ($kind === 'error' || $kind === 'failed') {
                $error = is_string($frame['message'] ?? null) ? $frame['message'] : 'OAIY could not answer.';
            }
            return strlen($content) < $enough;
        }, $gapless);
        return [
            'status' => $progress['status'] ?? null, 'content' => $content, 'final' => $final, 'error' => $error,
            'listed' => $listed, 'taken' => $progress['taken'] ?? false, 'age' => $progress['age'] ?? 0,
        ];
    }

    /** Give up on a queued turn: if the computer has not taken it, it never will. */
    public function abandon(string $id, string $owner): void
    {
        $this->relay->abandon($id, $owner);
    }

    /**
     * Cancel a turn whatever it is doing: one not yet taken never is, and a computer already
     * working on one is told `cancelled` on its next frame, for it to stop (contract §0.13;
     * DesktopAiRelayService::cancel). App AI's cancelled, timed-out and overlong jobs.
     */
    public function cancel(string $id, string $owner): void
    {
        $this->relay->cancel($id, $owner);
    }

    /**
     * cancel(), saying what the turn was doing as it was let go (DesktopAiRelayService::cancelSaying):
     * 'pending' (no computer had taken it, so the AI was asked nothing), 'claimed' or 'streaming', or
     * null (it was over already).
     */
    public function cancelTurn(string $id, string $owner): ?string
    {
        return $this->relay->cancelSaying($id, $owner);
    }

    /**
     * Why $target cannot take a turn now ($picture: a picture), or null, worded for whose computer it
     * is ($own: the person asking owns it). Said before a turn is started; a turn is counted again
     * under the lane's lock as it is queued (send).
     */
    public function unavailableFor(array $target, bool $picture = false, bool $own = false): ?SiteAiBusyException
    {
        if (!$this->settings->online($target)) {
            return self::offline($own);
        }
        if ($this->relay->inFlightForTarget($target['ownerUserId'], $target['instanceId'], $picture) >= ($picture ? self::MAX_PICTURES_WAITING : self::MAX_WAITING)) {
            return self::busy($own, $picture);
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
        if ($site === null) {
            return $this->settings->gone() !== null
                ? new SiteAiBusyException('The computer this site\'s AI runs on was unlinked or has a new key. An administrator can choose it again.', 'site_ai_gone')
                : null;
        }
        return $this->unavailableFor($site);
    }

    /** Whether the person asking ($requester; null: nobody but the owner) owns the computer $target. */
    private static function owns(array $target, ?string $requester): bool
    {
        return $requester === null || $requester === (string) ($target['ownerUserId'] ?? '');
    }

    /** The computer is offline, said to its owner ($own) or to someone using the site's AI on it. */
    private static function offline(bool $own): SiteAiBusyException
    {
        return new SiteAiBusyException($own
            ? 'That computer is offline. Open OAIY on it, then try again.'
            : 'The computer the site\'s AI runs on is offline. Try again later.', 'site_ai_offline');
    }

    /** The computer's lane is full ($picture: its picture lane), said to its owner ($own) or to someone using the site's AI. */
    private static function busy(bool $own, bool $picture): SiteAiBusyException
    {
        if ($picture) {
            return new SiteAiBusyException('The computer is drawing another picture. This one waits its turn.');
        }
        return new SiteAiBusyException($own
            ? 'That computer is busy with other requests. Try again in a moment.'
            : 'The site\'s AI is busy with other people\'s requests. Try again in a moment.');
    }

    /**
     * The sealed frames of one turn, opened in order, to its final frame. Each round reads the
     * status first and then every frame there is, a page at a time until a page comes back short,
     * so an answer read as done is read whole. $own words what is said for the computer's owner.
     */
    private function read(string $id, string $owner, string $pair, ?callable $onDelta, ?callable $onHeartbeat, int $timeoutSeconds, bool $own = false): array
    {
        $content = '';
        $listed = [];
        $final = null;
        $failure = null;
        $since = 0;
        $last = -1;
        $deadline = microtime(true) + max(5, $timeoutSeconds);
        $beat = microtime(true);
        $usage = ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0];
        while (true) {
            // The status before the frames: a computer sends its frames before it completes a turn.
            $status = $this->relay->getStatus($id, $owner);
            [$since, $last] = $this->readFrames($id, $owner, $pair, $since, $last, static function (array $frame) use (&$content, &$listed, &$final, &$failure, $onDelta): bool {
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
                    $final = $frame;
                    return false;
                } elseif ($kind === 'error' || $kind === 'failed') {
                    $failure = is_string($frame['message'] ?? null) ? $frame['message'] : 'OAIY could not answer.';
                    return false;
                }
                return true;
            });
            if ($failure !== null) {
                throw new \RuntimeException(($own ? 'OAIY on that computer could not answer: ' : 'The site\'s AI (OAIY) could not answer: ') . $failure);
            }
            if ($final !== null) {
                // A final frame after a stream is empty; one without a stream holds the answer.
                if ($content === '') {
                    $content = self::text($final['completion'] ?? $final['text'] ?? null);
                    if ($content !== '' && $onDelta !== null) {
                        $onDelta($content);
                    }
                }
                return ['content' => $content, 'usage' => $usage, 'final' => $final + $listed];
            }
            if (in_array($status, ['failed', 'expired'], true) || $status === null) {
                throw new \RuntimeException(match (true) {
                    $status === 'expired' && $own => 'That computer did not pick this up in time. It may be off.',
                    $status === 'expired' => 'The site\'s AI did not pick this up in time. The computer it runs on may be off.',
                    $own => 'OAIY on that computer could not answer.',
                    default => 'The site\'s AI (OAIY) could not answer.',
                });
            }
            if ($status === 'done') {
                // Done before every frame above was read: the answer is what came.
                return ['content' => $content, 'usage' => $usage, 'final' => $listed];
            }
            if (microtime(true) > $deadline) {
                throw new \RuntimeException($own ? 'That computer took too long to answer.' : 'The site\'s AI took too long to answer.');
            }
            if ($onHeartbeat !== null && microtime(true) - $beat >= self::HEARTBEAT_SECONDS) {
                $beat = microtime(true);
                $onHeartbeat();
            }
            ($this->wait)(self::POLL_MICROSECONDS);
        }
    }

    /**
     * Read turn $id's frames after the cursor $since, each opened as one coming after counter $last
     * (openAfter), a page at a time until a page comes back short or $take answers false. A frame
     * larger than any OAIY sends (MAX_FRAME_BYTES) is refused unread. $gapless: no frame may be
     * missing (a reader that decides on the whole answer, as the camera check does, fails closed
     * rather than decide on part of it). Answers the cursor and the counter it got to, for a reader
     * that carries on from there.
     *
     * @param callable(array): bool $take
     * @return array{0: int, 1: int}
     */
    private function readFrames(string $id, string $owner, string $pair, int $since, int $last, callable $take, bool $gapless = false): array
    {
        do {
            $rows = $this->relay->fetchOutput($id, $owner, $since, self::FRAMES_PER_READ, self::MAX_FRAME_BYTES);
            foreach ($rows as $row) {
                $since = (int) $row['seq'];
                if (!is_string($row['envelope'] ?? null)) {
                    throw new \RuntimeException('OAIY sent a frame larger than any it sends.');
                }
                [$counter, $frame] = self::openAfter($row['envelope'], $last, $pair);
                if ($gapless && $counter !== $last + 1) {
                    throw new \RuntimeException('OAIY\'s answer has a frame missing.');
                }
                $last = $counter;
                if (!$take($frame)) {
                    return [$since, $last];
                }
            }
        } while (count($rows) >= self::FRAMES_PER_READ);
        return [$since, $last];
    }

    /**
     * Note that this process is reading turn $id. Should it end before the read does (the person
     * closed the page and PHP stopped at its next flush, or the request ran out of time), the turn
     * is cancelled as PHP shuts down, so the computer is told to stop rather than answer nobody:
     * PHP runs shutdown functions however a request ends, where it skips a `finally`.
     */
    private function guard(string $id, string $owner): void
    {
        $this->reading[$id] = $owner;
        if ($this->guarded) {
            return;
        }
        $this->guarded = true;
        register_shutdown_function(function (): void {
            foreach ($this->reading as $id => $owner) {
                $this->letGo((string) $id, $owner);
            }
            $this->reading = [];
        });
    }

    private function unguard(string $id): void
    {
        unset($this->reading[$id]);
    }

    /** Cancel a turn nobody waits for; one the relay cannot reach now is let go by it in its own time. */
    private function letGo(string $id, string $owner): void
    {
        try {
            $this->relay->cancel($id, $owner);
        } catch (\Throwable) {
            // The relay reaps a turn left silent (DesktopAiRelayService::CLAIMED_STALE_SECONDS).
        }
    }

    /** base64(nonce || box): byte 0 of the nonce is the direction, its last 8 bytes the counter. */
    public static function seal(array $body, int $direction, int $counter, string $pair): string
    {
        $nonce = self::nonce($direction, $counter);
        return base64_encode($nonce . sodium_crypto_box(json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), $nonce, $pair));
    }

    /** One frame opened; refused unless its nonce is exactly $direction and $counter (a turn's own request is counter 0). */
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
        return self::unbox($raw, $nonce, $pair);
    }

    /**
     * One frame from the computer opened, refused unless its nonce says it comes from the computer
     * (direction 1) after counter $last. A counter may skip: OAIY goes on past a frame whose post
     * failed (it logs the gap and carries on), and the browser's reader takes a gap too, so a lost
     * frame costs its own few words, not the whole answer. An equal or lower counter is a replay,
     * and is refused. Answers [counter, frame].
     *
     * @return array{0: int, 1: array}
     */
    public static function openAfter(string $envelope, int $last, string $pair): array
    {
        $raw = base64_decode($envelope, true);
        if ($raw === false || strlen($raw) <= self::NONCE_BYTES) {
            throw new \RuntimeException('OAIY sent an unreadable frame.');
        }
        $nonce = substr($raw, 0, self::NONCE_BYTES);
        $counter = (int) unpack('J', $nonce, 16)[1];
        if (substr($nonce, 0, 16) !== chr(1) . str_repeat("\0", 15) || $counter <= $last) {
            throw new \RuntimeException('OAIY sent a frame out of order.');
        }
        return [$counter, self::unbox($raw, $nonce, $pair)];
    }

    private static function unbox(string $raw, string $nonce, string $pair): array
    {
        $plain = sodium_crypto_box_open(substr($raw, self::NONCE_BYTES), $nonce, $pair);
        if ($plain === false) {
            throw new \RuntimeException('A frame did not open with this turn\'s key: the computer may have a new key. Choose it again.');
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
