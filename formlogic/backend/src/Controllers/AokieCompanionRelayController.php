<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use FormLogic\Services\AokieCompanionDeviceService;
use FormLogic\Services\AokieCompanionRelayService;
use FormLogic\Services\AppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Hosted Aokie Companion relay transport (pack services wave 2).
 *
 * An authenticated frame mailbox between the desktop plugin and Companion
 * mobiles: POST upstream, SSE (or long-poll fallback) downstream. Frames are
 * the existing v2 signalling documents, Ed25519-signed by the endpoints.
 * The relay never rewrites their interior. The HTTP boundary reads only the
 * root protocol `kind` and strict `transferOffered` boolean, solely to apply
 * server-owned consent and availability to `assistance_request`. The one
 * document the relay does compose is the endpoint
 * challenge that opens a session — kept a separate resource so ordinary
 * stored frame contents otherwise remain opaque.
 *
 * Party identity comes ONLY from the verified admission token (the same
 * `aokie-adm-v2` bearer the realtime gateway consumes): role 'plugin' is the
 * desktop party; a mobile is 'mobile:<holderKeyThumbprint>'. Admissions are
 * short-lived (90s default), and every stream is bounded by the exact verified
 * admission expiry before clients re-admit and reconnect with `since`.
 */
final class AokieCompanionRelayController
{
    use JsonResponseTrait;

    /** SSE hard lifetime; the stream then ends cleanly and clients reconnect. */
    public const STREAM_LIFETIME_SECONDS = 300;
    /** Heartbeat comment cadence keeping proxies/timeouts from cutting idle streams. */
    public const STREAM_HEARTBEAT_SECONDS = 15;
    private const STREAM_POLL_INTERVAL_MS = 500;

    /** Mirrors `aokie_protocol::v2::SCHEMA_VERSION`; the frame is refused otherwise. */
    public const CHALLENGE_SCHEMA_VERSION = 2;
    /**
     * Endpoint-challenge lifetime.
     *
     * ⚠️ HARD-BOUNDED BY THE PROTOCOL, not a free choice.
     * `EndpointChallengeFrame::validate()` refuses a frame whose `expiresAt`
     * has already passed AND one that is more than
     * `ENDPOINT_PROOF_MAX_LIFETIME` (30s) ahead of the verifier's clock — a
     * longer window is rejected as `Expired`, failing every handshake. 25s
     * keeps the protocol's own `ENDPOINT_PROOF_CLOCK_SKEW` (5s) of headroom
     * for an endpoint clock that runs slow, while tolerating one up to 25s
     * fast, and leaves the derived hello proof its full usable lifetime.
     */
    public const CHALLENGE_LIFETIME_SECONDS = 25;

    public function __construct(
        private readonly ?AokieCompanionAdmissionSigner $signer,
        private readonly AppService $apps,
        private readonly AokieCompanionRelayService $relay,
        private readonly AokieCompanionDeviceService $devices,
    ) {}

    /**
     * GET /api/aokie-companion/relay/challenge — the endpoint challenge an
     * endpoint requires before it will sign its hello. Issued to BOTH parties:
     * the plugin gets its roster shape, a Companion mobile its peer shape.
     *
     * A DEDICATED resource rather than a frame injected into the mailbox: the
     * mailbox stays strictly opaque, and the endpoint's existing challenge
     * validation and hello signing run verbatim over the relay transport.
     *
     * It grants NOTHING, and serving mobiles widens nothing: every non-random
     * field is copied from the presented bearer's OWN verified claims, so a
     * challenge can only ever describe the identity that asked for it — there
     * is no request input to influence, and no new server state to keep. A
     * mobile's challenge names the plugin its admission was already minted
     * against, which the bearer itself already carries.
     */
    public function getChallenge(Request $request, Response $response): Response
    {
        $identity = $this->relayIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $claims = $identity['claims'];
        // ⚠️ THE TWO ROLE SHAPES ARE MUTUALLY EXCLUSIVE, NOT MERELY DIFFERENT.
        // `aokie_protocol::v2::validate_peer_policy` refuses a mobile challenge
        // that carries ANY roster field, and refuses a plugin challenge that
        // carries expectedPeerKeyThumbprint at all — reading its mere presence
        // as an identity mismatch. Each branch therefore OMITS the other's keys
        // entirely rather than sending them empty or null. The frame struct
        // defaults every one of them, so absence decodes cleanly.
        if ($identity['role'] === 'plugin') {
            try {
                // The peer policy rides the same HMAC as the rest of the claims, but
                // verify() checks only what every role shares. Re-validating it here
                // keeps a malformed roster from being echoed into a frame the
                // endpoint would refuse only after the round trip.
                $approvedPeers = AokieCompanionAdmissionSigner::validatePluginPeerPolicy(
                    $claims['approvedPeerKeyThumbprints'] ?? null,
                    $claims['peerRosterRevision'] ?? null,
                    $claims['peerRosterHash'] ?? null,
                );
            } catch (\InvalidArgumentException) {
                return $this->error(
                    $response,
                    401,
                    'invalid_token',
                    'The admission token does not carry a plugin endpoint identity',
                );
            }
            // ⚠️ The LAST roster rule, and the only one validatePluginPeerPolicy
            // structurally cannot make: it is never handed the holder. The
            // protocol refuses a roster that approves the endpoint's OWN key
            // (v2.rs:2466, the mirror of the mobile branch's self-reference
            // check below), so echoing one would mint a challenge the plugin
            // rejects only after the round trip — and because a roster revision
            // may only ever advance, that failure would be STICKY rather than
            // self-correcting. Refusing here can never cost a working session:
            // any roster the endpoint would have accepted already satisfies it.
            if (in_array((string) $claims['holderKeyThumbprint'], $approvedPeers, true)) {
                return $this->error(
                    $response,
                    401,
                    'invalid_token',
                    'The admission token does not carry a plugin endpoint identity',
                );
            }
            $peerPolicy = [
                // ⚠️ expectedPeerKeyThumbprint is DELIBERATELY ABSENT. It belongs to
                // mobile-role challenges; on a plugin-role frame the endpoint reads
                // its mere presence as an identity mismatch and refuses the socket.
                'approvedPeerKeyThumbprints' => $approvedPeers,
                'peerRosterRevision' => (int) $claims['peerRosterRevision'],
                'peerRosterHash' => (string) $claims['peerRosterHash'],
            ];
        } elseif ($identity['role'] === 'mobile') {
            // Same reasoning as the plugin roster above: verify() does not look
            // at expectedPeerKeyThumbprint, so it is re-checked here — including
            // the protocol's "must differ from the holder" rule — rather than
            // echoing a frame the endpoint would refuse after the round trip.
            $expectedPeer = $claims['expectedPeerKeyThumbprint'] ?? null;
            if (!AokieCompanionAdmissionSigner::validThumbprint($expectedPeer)
                || $expectedPeer === ($claims['holderKeyThumbprint'] ?? null)) {
                return $this->error(
                    $response,
                    401,
                    'invalid_token',
                    'The admission token does not carry a mobile endpoint identity',
                );
            }
            $peerPolicy = [
                // ⚠️ approvedPeerKeyThumbprints / peerRosterRevision / peerRosterHash
                // are DELIBERATELY ABSENT. They describe a plugin's roster; on a
                // mobile-role frame any one of them is refused outright.
                'expectedPeerKeyThumbprint' => (string) $expectedPeer,
            ];
        } else {
            // Unreachable while ROLES is {mobile, plugin} — verify() refuses any
            // other role before this point. Kept so a future role fails closed.
            return $this->error(
                $response,
                403,
                'relay_challenge_unsupported',
                'Relay challenges are issued to the plugin and mobile parties only',
            );
        }
        return $this->jsonResponse($response, [
            'kind' => 'endpoint_challenge',
            'schemaVersion' => self::CHALLENGE_SCHEMA_VERSION,
            'appId' => (string) $claims['appId'],
            'subjectId' => (string) $claims['subjectId'],
            'role' => $identity['role'],
            'connectionId' => 'relay_' . bin2hex(random_bytes(16)),
            'challengeNonce' => 'challenge_' . bin2hex(random_bytes(16)),
            'admissionJti' => (string) $claims['jti'],
            'holderKeyThumbprint' => (string) $claims['holderKeyThumbprint'],
            ...$peerPolicy,
            'expiresAt' => time() + self::CHALLENGE_LIFETIME_SECONDS,
        ])
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('Pragma', 'no-cache');
    }

    /** POST /api/aokie-companion/relay/frames — {to, frames[]} → {accepted, seq}. */
    public function postFrames(Request $request, Response $response): Response
    {
        $identity = $this->relayIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        // Parse the RAW body non-associatively: PHP's assoc decoding collapses
        // an empty JSON object into an empty array, which would corrupt an
        // opaque signed frame ({} != []). stdClass round-trips faithfully.
        try {
            $body = json_decode((string) $request->getBody(), false, 96, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return $this->error($response, 400, 'invalid_request', 'A JSON object body is required');
        }
        if (!is_object($body)) {
            return $this->error($response, 400, 'invalid_request', 'A JSON object body is required');
        }
        $to = $body->to ?? null;
        if (!AokieCompanionRelayService::validParty($to)) {
            return $this->error(
                $response,
                400,
                'invalid_request',
                "to must be 'plugin' or 'mobile:<endpoint key thumbprint>'",
            );
        }
        /** @var string $to */
        if ($identity['role'] === 'mobile' && $to !== AokieCompanionRelayService::PARTY_PLUGIN) {
            return $this->error(
                $response,
                403,
                'relay_target_forbidden',
                'A Companion mobile may only send frames to the plugin party',
            );
        }
        if ($identity['role'] === 'plugin' && $to === AokieCompanionRelayService::PARTY_PLUGIN) {
            return $this->error(
                $response,
                403,
                'relay_target_forbidden',
                'The plugin sends frames to mobile parties, never to itself',
            );
        }
        if ($identity['role'] === 'plugin') {
            // A syntactically valid mobile mailbox is not sufficient. The
            // plugin admission is minted against one exact, revisioned peer
            // roster; letting that bearer address an out-of-roster endpoint
            // would bypass the approval ceremony and could disclose caller
            // state or private assistance context. Revalidate the signed
            // roster shape here (verify() covers only common claims), then
            // fence every plugin->mobile frame family to one approved peer.
            try {
                $approvedPeers = AokieCompanionAdmissionSigner::validatePluginPeerPolicy(
                    $identity['claims']['approvedPeerKeyThumbprints'] ?? null,
                    $identity['claims']['peerRosterRevision'] ?? null,
                    $identity['claims']['peerRosterHash'] ?? null,
                );
            } catch (\InvalidArgumentException) {
                return $this->error(
                    $response,
                    401,
                    'invalid_token',
                    'The admission token does not carry a valid plugin peer roster',
                );
            }
            $holder = $identity['claims']['holderKeyThumbprint'] ?? null;
            if (!is_string($holder) || in_array($holder, $approvedPeers, true)) {
                return $this->error(
                    $response,
                    401,
                    'invalid_token',
                    'The admission token does not carry a valid plugin peer roster',
                );
            }
            $targetThumbprint = substr($to, strlen(AokieCompanionRelayService::PARTY_MOBILE_PREFIX));
            if (!in_array($targetThumbprint, $approvedPeers, true)) {
                return $this->error(
                    $response,
                    403,
                    'relay_target_forbidden',
                    'The target mobile is not approved by this plugin admission',
                );
            }
        }
        $frames = $body->frames ?? null;
        if (!is_array($frames)
            || $frames === []
            || count($frames) > AokieCompanionRelayService::MAX_FRAMES_PER_POST
            || !array_is_list($frames)) {
            return $this->error(
                $response,
                400,
                'invalid_request',
                'frames must be a JSON list of 1..' . AokieCompanionRelayService::MAX_FRAMES_PER_POST . ' entries',
            );
        }
        $serialized = [];
        foreach ($frames as $frame) {
            $encoded = json_encode($frame, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($encoded === false) {
                return $this->error($response, 400, 'invalid_request', 'Every frame must be a JSON value');
            }
            if (strlen($encoded) > AokieCompanionRelayService::MAX_FRAME_BYTES) {
                return $this->error(
                    $response,
                    413,
                    'relay_frame_too_large',
                    'Each frame must serialize to at most ' . AokieCompanionRelayService::MAX_FRAME_BYTES . ' bytes',
                );
            }
            // Assistance and transfer share the exact assistance_request
            // protocol frame. The hosted carrier used to trust the plugin's
            // already-learned peer list here, bypassing FormLogic's current
            // consent and durable Available/Busy/DND/Offline routing sources
            // of truth. Inspect only the root dispatch discriminator and the
            // protocol's strict transfer boolean; the signed frame remains
            // otherwise opaque and is never rewritten. A non-assistance frame
            // in the same batch (notably plugin_hello) must still be delivered.
            if ($identity['role'] === 'plugin'
                && is_object($frame)
                && ($frame->kind ?? null) === 'assistance_request'
                && (!$this->currentConsentAllowsAssistance($identity['appId'], $frame)
                    || !$this->devices->canReceiveRelayAssistance(
                        $identity['appId'],
                        substr($to, strlen(AokieCompanionRelayService::PARTY_MOBILE_PREFIX)),
                    ))) {
                continue;
            }
            $serialized[] = $encoded;
        }
        // A policy-suppressed assistance request is an intentional terminal
        // no-op for this recipient, not a transport failure. A 2xx keeps the
        // plugin session healthy and prevents a Busy/DND endpoint from being
        // hammered with retries; accepted=0 truthfully records that no mailbox
        // row (and therefore no later delivery) was created.
        if ($serialized === []) {
            return $this->jsonResponse($response, ['accepted' => 0, 'seq' => 0])
                ->withHeader('Cache-Control', 'no-store');
        }
        try {
            // Authority metadata is derived exclusively from the admission
            // bearer that relayIdentity() just verified. It is deliberately
            // outside the opaque frame, and no POST-body field can influence
            // it. The service re-validates the list shape before persistence.
            $verifiedGrants = is_array($identity['claims']['scopes'] ?? null)
                ? $identity['claims']['scopes']
                : [];
            $verifiedSubjectId = is_string($identity['claims']['subjectId'] ?? null)
                ? $identity['claims']['subjectId']
                : null;
            $result = $this->relay->append(
                $identity['appId'],
                $identity['party'],
                $to,
                $serialized,
                $verifiedGrants,
                $verifiedSubjectId,
            );
        } catch (\OverflowException $error) {
            return $this->error($response, 429, 'relay_backpressure', $error->getMessage());
        }
        return $this->jsonResponse($response, $result)
            ->withHeader('Cache-Control', 'no-store');
    }

    /**
     * Fail-closed mirror of the app's strict remoteConsent contract.
     *
     * Only `transferOffered` is inspected from the endpoint-signed frame:
     * every fresh assistance request needs remoteAssistance, and a request
     * that also offers transfer needs remoteTakeover. A missing/malformed
     * transfer discriminator is not safe to downgrade to ordinary assistance.
     */
    private function currentConsentAllowsAssistance(string $appId, object $frame): bool
    {
        if (!property_exists($frame, 'transferOffered') || !is_bool($frame->transferOffered)) {
            return false;
        }
        $app = $this->apps->getApp($appId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $companion = is_array($settings['aokieCompanion'] ?? null)
            ? $settings['aokieCompanion'] : [];
        $consent = $companion['remoteConsent'] ?? null;
        $keys = [
            'remoteMonitoring',
            'remoteConsult',
            'remoteTakeover',
            'remoteCaptions',
            'remoteAssistance',
        ];
        if (!is_array($consent)
            || array_diff(array_keys($consent), $keys) !== []
            || array_diff($keys, array_keys($consent)) !== []) {
            return false;
        }
        foreach ($keys as $key) {
            if (!is_bool($consent[$key])) {
                return false;
            }
        }
        return $consent['remoteAssistance']
            && (!$frame->transferOffered || $consent['remoteTakeover']);
    }

    /** GET /api/aokie-companion/relay/frames?since=&wait= — long-poll fallback. */
    public function pollFrames(Request $request, Response $response): Response
    {
        $identity = $this->relayIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $query = $request->getQueryParams();
        $since = AokieCompanionRelayService::resumeCursor(
            $request->getHeaderLine('Last-Event-ID'),
            $query['since'] ?? null,
        );
        $wait = filter_var($query['wait'] ?? 0, FILTER_VALIDATE_INT);
        $clock = static fn (): float => microtime(true);
        $deadline = self::streamDeadline((int) $identity['claims']['exp'], $clock());
        $batch = self::pollStreamBatch(
            $since,
            is_int($wait) ? $wait : 0,
            $deadline,
            fn (int $boundedWait): array => $this->relay->pollSince(
                $identity['appId'],
                $identity['party'],
                $since,
                $boundedWait,
            ),
            $clock,
        );
        $rows = $batch['rows'];
        $frames = [];
        $lastSeq = $batch['lastSeq'];
        foreach ($rows as $row) {
            $frames[] = [
                'seq' => $row['seq'],
                'from' => $row['from'],
                // Relay-authenticated metadata; never decoded from `frame`.
                'subjectId' => $row['subjectId'],
                'grants' => $row['grants'],
                // Non-assoc decode: {} must stay an object in the response.
                'frame' => json_decode($row['frame'], false),
            ];
        }
        return $this->jsonResponse($response, ['frames' => $frames, 'lastSeq' => $lastSeq])
            ->withHeader('Cache-Control', 'no-store');
    }

    /**
     * GET /api/aokie-companion/relay/stream?since= — SSE downstream.
     *
     * Refusals return ordinary JSON errors (an EventSource sees the status and
     * stops); an authorized stream takes over the connection with raw output.
     */
    public function stream(Request $request, Response $response): Response
    {
        $identity = $this->relayIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $since = AokieCompanionRelayService::resumeCursor(
            $request->getHeaderLine('Last-Event-ID'),
            $request->getQueryParams()['since'] ?? null,
        );
        $this->emitStream(
            $identity['appId'],
            $identity['party'],
            $since,
            (int) $identity['claims']['exp'],
        );
    }

    /**
     * Absolute authorization deadline for one SSE request.
     *
     * The signer's bounded clock skew is part of verify()'s exact acceptance
     * window, so the stream may use that same window but never the independent
     * 300-second worker cap beyond it.
     *
     * @internal Public only so the never-returning raw SSE seam has a
     * deterministic regression test.
     */
    public static function streamDeadline(int $admissionExpiresAt, ?float $now = null): float
    {
        $now ??= microtime(true);
        return max(
            $now,
            min(
                $now + self::STREAM_LIFETIME_SECONDS,
                (float) $admissionExpiresAt + AokieCompanionAdmissionSigner::CLOCK_SKEW_SECONDS,
            ),
        );
    }

    /**
     * Perform one long poll without allowing its wait to cross authorization.
     *
     * @param callable(int):list<array{seq:int,from:string,subjectId:?string,grants:list<string>,frame:string}> $poll
     * @param callable():float $clock
     * @return array{rows:list<array{seq:int,from:string,subjectId:?string,grants:list<string>,frame:string}>,lastSeq:int,expired:bool}
     * @internal Public only for deterministic auth-boundary regressions.
     */
    public static function pollStreamBatch(
        int $since,
        int $requestedWaitMs,
        float $deadline,
        callable $poll,
        callable $clock,
    ): array {
        $remainingMs = (int) floor(($deadline - $clock()) * 1_000);
        if ($remainingMs <= 0) {
            return ['rows' => [], 'lastSeq' => $since, 'expired' => true];
        }
        $boundedWait = min(max(0, $requestedWaitMs), $remainingMs);
        $rows = $poll($boundedWait);
        if ($clock() >= $deadline) {
            return ['rows' => [], 'lastSeq' => $since, 'expired' => true];
        }
        $lastSeq = $since;
        foreach ($rows as $row) {
            $lastSeq = max($lastSeq, $row['seq']);
        }
        return ['rows' => $rows, 'lastSeq' => $lastSeq, 'expired' => false];
    }

    /**
     * Fetch and emit one SSE mailbox batch while authorization is current.
     *
     * The post-fetch check is security-significant: a database read that
     * begins before expiry may finish after it, and those rows belong to the
     * next freshly admitted stream rather than this expired one.
     *
     * @param callable(int):list<array{seq:int,from:string,subjectId:?string,grants:list<string>,frame:string}> $fetch
     * @param callable(array{seq:int,from:string,subjectId:?string,grants:list<string>,frame:string}):string $encode
     * @param callable(string):void $emit
     * @param callable():float $clock
     * @return array{cursor:int,emitted:bool,expired:bool}
     * @internal Public only for a deterministic auth-boundary regression.
     */
    public static function fetchAndEmitStreamBatch(
        int $cursor,
        float $deadline,
        callable $fetch,
        callable $encode,
        callable $emit,
        callable $clock,
    ): array {
        $rows = $fetch($cursor);
        if ($clock() >= $deadline) {
            return ['cursor' => $cursor, 'emitted' => false, 'expired' => true];
        }

        $emitted = false;
        foreach ($rows as $row) {
            if ($clock() >= $deadline) {
                return ['cursor' => $cursor, 'emitted' => $emitted, 'expired' => true];
            }
            $event = $encode($row);
            // Encoding includes the opaque mailbox frame and can itself cross
            // the auth boundary. Check at the final output seam, not merely
            // before serialization.
            if ($clock() >= $deadline) {
                return ['cursor' => $cursor, 'emitted' => $emitted, 'expired' => true];
            }
            $emit($event);
            $cursor = $row['seq'];
            $emitted = true;
        }
        return ['cursor' => $cursor, 'emitted' => $emitted, 'expired' => false];
    }

    /**
     * Raw SSE loop.
     *
     * ⚠️ Worker occupancy: under PHP-FPM/Apache each open stream PINS one PHP
     * worker for its whole lifetime (like the desktop relay's 25s long-poll,
     * but up to 300s). That is why the lifetime is HARD-capped: the stream
     * ends with `event: end` and the client reconnects with Last-Event-ID /
     * ?since=, releasing the worker at a bounded cadence. Deployments with
     * few workers can steer Companions to the long-poll fallback instead.
     *
     * Bypasses the Slim emitter deliberately (Slim's chunked echo cannot
     * interleave flushes with real-time data), so it writes headers/output
     * directly and terminates the request when done.
     */
    private function emitStream(string $appId, string $party, int $since, int $admissionExpiresAt): never
    {
        set_time_limit(self::STREAM_LIFETIME_SECONDS + 30);
        ignore_user_abort(false);
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Accel-Buffering: no');
        // Defeat server-side buffering/compression: gzip would buffer events.
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', '0');
        while (ob_get_level() > 0) {
            @ob_end_flush();
        }
        echo 'retry: 2000' . "\n\n";
        echo ': connected' . "\n\n";
        flush();

        $clock = static fn (): float => microtime(true);
        $cursor = $since;
        $deadline = self::streamDeadline($admissionExpiresAt, $clock());
        $lastOutput = $clock();
        while ($clock() < $deadline) {
            $batch = self::fetchAndEmitStreamBatch(
                $cursor,
                $deadline,
                fn (int $after): array => $this->relay->fetchSince($appId, $party, $after),
                static fn (array $row): string => AokieCompanionRelayService::sseEvent($row),
                static function (string $event): void {
                    echo $event;
                },
                $clock,
            );
            $cursor = $batch['cursor'];
            if ($batch['expired']) {
                break;
            }
            if ($batch['emitted']) {
                flush();
                $lastOutput = $clock();
            } elseif ($clock() - $lastOutput >= self::STREAM_HEARTBEAT_SECONDS) {
                echo ': keepalive' . "\n\n";
                flush();
                $lastOutput = $clock();
            }
            if (connection_aborted() !== 0) {
                exit;
            }
            $remainingMicroseconds = (int) floor(($deadline - $clock()) * 1_000_000);
            if ($remainingMicroseconds <= 0) {
                break;
            }
            usleep(min(self::STREAM_POLL_INTERVAL_MS * 1000, $remainingMicroseconds));
        }
        // Clean end-of-lifetime marker; the client reconnects with `since`.
        echo 'id: ' . $cursor . "\n" . 'event: end' . "\n" . 'data: {}' . "\n\n";
        flush();
        exit;
    }

    /**
     * Resolve the bearer to a relay identity. Every endpoint runs the same
     * chain: verify the admission token → resolve the published app it names →
     * gate on the owner's `companion-relay` service toggle → derive the party.
     *
     * The verified claims ride along so callers that need more of the bearer's
     * own identity (the endpoint challenge echoes its roster) read them from
     * here instead of running a second, divergent verification.
     *
     * @return array{ok:bool,status:int,code:string,message:string,appId:string,party:string,role:string,claims:array<string,mixed>}
     */
    private function relayIdentity(Request $request): array
    {
        $refused = static fn (int $status, string $code, string $message): array => [
            'ok' => false,
            'status' => $status,
            'code' => $code,
            'message' => $message,
            'appId' => '',
            'party' => '',
            'role' => '',
            'claims' => [],
        ];
        if ($this->signer === null) {
            return $refused(503, 'companion_unavailable', 'Aokie Companion admission is not configured');
        }
        $bearer = $this->bearer($request);
        if ($bearer === null) {
            return $refused(401, 'invalid_token', 'An Aokie admission bearer is required');
        }
        $claims = $this->signer->verify($bearer);
        if ($claims === null) {
            return $refused(401, 'invalid_token', 'The admission token is invalid or expired — request a new admission');
        }
        $party = AokieCompanionRelayService::partyForClaims($claims);
        if ($party === null) {
            return $refused(401, 'invalid_token', 'The admission token does not carry a relay identity');
        }
        $app = $this->apps->getApp((string) $claims['appId']);
        if ($app === null || ($app['status'] ?? null) !== 'published') {
            return $refused(403, 'forbidden', 'The app is unavailable');
        }
        if (!AokieCompanionController::companionRelayEnabled($app)) {
            return $refused(
                403,
                'service_disabled',
                'The Companion app relay is turned off for this app — an owner can re-enable it under App Settings › Included services',
            );
        }
        return [
            'ok' => true,
            'status' => 200,
            'code' => '',
            'message' => '',
            'appId' => (string) $claims['appId'],
            'party' => $party,
            'role' => (string) $claims['role'],
            'claims' => $claims,
        ];
    }

    private function bearer(Request $request): ?string
    {
        return preg_match('/^Bearer\s+([^\s]+)$/i', $request->getHeaderLine('Authorization'), $match)
            ? $match[1]
            : null;
    }

    private function error(Response $response, int $status, string $code, string $message): Response
    {
        return $this->jsonResponse($response, ['error' => true, 'code' => $code, 'message' => $message], $status)
            ->withHeader('Cache-Control', 'no-store');
    }
}
