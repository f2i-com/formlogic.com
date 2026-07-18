<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use FormLogic\Services\AokieCompanionRelayService;
use FormLogic\Services\AppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Hosted Aokie Companion relay transport (pack services wave 2).
 *
 * An authenticated frame mailbox between the desktop plugin and Companion
 * mobiles: POST upstream, SSE (or long-poll fallback) downstream. Frames are
 * the existing v2 signalling documents and stay OPAQUE — they are
 * Ed25519-signed by the endpoints themselves; the relay stores and forwards
 * without ever interpreting their interior beyond "valid JSON within the
 * size cap". The one document the relay does compose is the endpoint
 * challenge that opens a session — kept a SEPARATE resource precisely so the
 * mailbox itself never has to look inside a frame.
 *
 * Party identity comes ONLY from the verified admission token (the same
 * `aokie-adm-v2` bearer the realtime gateway consumes): role 'plugin' is the
 * desktop party; a mobile is 'mobile:<holderKeyThumbprint>'. Admissions are
 * short-lived (90s default), so clients re-admit and reconnect with `since`.
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
            $serialized[] = $encoded;
        }
        try {
            $result = $this->relay->append($identity['appId'], $identity['party'], $to, $serialized);
        } catch (\OverflowException $error) {
            return $this->error($response, 429, 'relay_backpressure', $error->getMessage());
        }
        return $this->jsonResponse($response, $result)
            ->withHeader('Cache-Control', 'no-store');
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
        $rows = $this->relay->pollSince(
            $identity['appId'],
            $identity['party'],
            $since,
            is_int($wait) ? $wait : 0,
        );
        $frames = [];
        $lastSeq = $since;
        foreach ($rows as $row) {
            $frames[] = [
                'seq' => $row['seq'],
                'from' => $row['from'],
                // Non-assoc decode: {} must stay an object in the response.
                'frame' => json_decode($row['frame'], false),
            ];
            $lastSeq = max($lastSeq, $row['seq']);
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
        $this->emitStream($identity['appId'], $identity['party'], $since);
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
    private function emitStream(string $appId, string $party, int $since): never
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

        $cursor = $since;
        $deadline = microtime(true) + self::STREAM_LIFETIME_SECONDS;
        $lastOutput = microtime(true);
        while (microtime(true) < $deadline) {
            $rows = $this->relay->fetchSince($appId, $party, $cursor);
            foreach ($rows as $row) {
                echo AokieCompanionRelayService::sseEvent($row);
                $cursor = $row['seq'];
            }
            if ($rows !== []) {
                flush();
                $lastOutput = microtime(true);
            } elseif (microtime(true) - $lastOutput >= self::STREAM_HEARTBEAT_SECONDS) {
                echo ': keepalive' . "\n\n";
                flush();
                $lastOutput = microtime(true);
            }
            if (connection_aborted() !== 0) {
                exit;
            }
            usleep(self::STREAM_POLL_INTERVAL_MS * 1000);
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
