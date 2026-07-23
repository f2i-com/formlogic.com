<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * E2E AI relay channel (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 1). Two surfaces:
 *   - Web (session-authed, /api/desktop/ai/*): a member ENQUEUES a sealed AI request for their
 *     own linked desktop, reads its status + live queue position, streams the sealed reply
 *     frames over SSE, and posts sealed input frames (confirm mode). Every {id} route is
 *     restricted to the REQUESTING user — account members can't read each other's requests.
 *   - Desktop (flk_ API key, /api/v1/desktop-ai/*): publishes its X25519 public key, long-polls
 *     the lane, claims single-flight, appends sealed reply frames, polls input, completes
 *     (which purges all sealed content). Scope: `ai:relay`, with legacy `connector:relay`
 *     keys grandfathered (plan §7) — checked here per request because ApiKeyMiddleware's
 *     required-scope list is AND-ed, and these routes accept EITHER scope.
 *
 * The backend never sees plaintext content: envelopes/frames are sealed NaCl-box bodies the
 * endpoints encrypt/decrypt; this relay stores and forwards opaque bytes only.
 */
class DesktopAiRelayController
{
    use JsonResponseTrait;

    /** SSE hard lifetime; the stream then ends cleanly and clients reconnect. */
    public const STREAM_LIFETIME_SECONDS = 300;
    /** Heartbeat comment cadence keeping proxies/timeouts from cutting idle streams. */
    public const STREAM_HEARTBEAT_SECONDS = 15;
    private const STREAM_POLL_INTERVAL_MS = 500;

    /** Reserved connector id the AI lane's target resolution pins against (assignment → instance). */
    public const TARGET_CONNECTOR_ID = 'desktop-ai';

    public function __construct(
        private DesktopAiRelayService $relay,
        private DesktopCommandService $commands,
    ) {}

    // ── Web surface (session-authed; userId == owner AND requesting user) ─────────────────

    /**
     * POST /api/desktop/ai/requests — enqueue a sealed AI request {kind, providerId, ephPub,
     * envelope, idempotencyKey?}. The SERVER picks the target machine (connector assignment pin
     * → implicit single fresh desktop → 409 ambiguous_desktop); a client-supplied target is
     * discarded, mirroring the connector-command relay.
     */
    public function enqueue(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) {
            $body = [];
        }

        unset($body['targetInstanceId']);
        $resolved = $this->commands->resolveTargetInstance((string) $userId, self::TARGET_CONNECTOR_ID);
        if ($resolved['error'] === 'ambiguous_desktop') {
            return $this->jsonError(
                $response,
                'More than one FormLogic Desktop is online for this workspace — the owner must assign the AI lane to one machine before requests can be routed.',
                409,
                'ambiguous_desktop',
                ['desktops' => $resolved['desktops']],
            );
        }
        if ($resolved['target'] !== null) {
            $body['targetInstanceId'] = $resolved['target'];
        }

        try {
            $result = $this->relay->enqueue((string) $userId, (string) $userId, $body);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'queue_full_user') {
                return $this->jsonError($response, 'You already have the maximum number of AI requests in flight — wait for one to finish.', 429, 'queue_full_user');
            }
            if ($e->getMessage() === 'queue_full_desktop') {
                return $this->jsonError($response, 'The desktop AI queue is full — wait for a request to finish.', 429, 'queue_full_desktop');
            }
            throw $e;
        }
        $req = $result['request'];
        $payload = [
            'requestId' => $req['requestId'],
            'status' => $req['status'],
            'queuePos' => $this->relay->queuePosition($req['requestId'], (string) $userId) ?? 0,
        ];
        if (($req['targetInstanceId'] ?? null) !== null) {
            $payload['targetInstanceId'] = $req['targetInstanceId'];
        }
        if ($result['created']) {
            return $this->jsonResponse($response, $payload, 201);
        }
        return $this->jsonResponse($response, $payload + ['idempotent' => true], 200);
    }

    /**
     * GET /api/desktop/ai/requests/{id} — status + LIVE queue position. Requesting-user only.
     * The sealed envelope is echoed back so the requester can verify/inspect its own payload;
     * it is null once the request completed (content purged).
     */
    public function getRequest(Request $request, Response $response, array $args): Response
    {
        [$userId, $row, $err] = $this->resolveOwnRequest($request, $response, (string) ($args['id'] ?? ''));
        if ($err !== null) {
            return $err;
        }
        $row['queuePos'] = $this->relay->queuePosition($row['requestId'], (string) $row['ownerUserId']) ?? 0;
        return $this->jsonResponse($response, ['request' => $row]);
    }

    /**
     * GET /api/desktop/ai/requests/{id}/stream?since= — SSE stream of the request's sealed
     * OUT frames plus status transitions. Refusals return ordinary JSON errors; an authorized
     * stream takes over the connection with raw output (the AokieCompanionRelayController SSE
     * pattern: no buffering/gzip, X-Accel-Buffering: no, heartbeat comments, hard lifetime).
     */
    public function stream(Request $request, Response $response, array $args): Response
    {
        [$userId, $row, $err] = $this->resolveOwnRequest($request, $response, (string) ($args['id'] ?? ''));
        if ($err !== null) {
            return $err;
        }
        $since = $this->resumeCursor(
            $request->getHeaderLine('Last-Event-ID'),
            $request->getQueryParams()['since'] ?? null,
        );
        $this->emitStream($row['requestId'], (string) $row['ownerUserId'], $since);
    }

    /**
     * POST /api/desktop/ai/requests/{id}/input — append a sealed IN frame {envelope}
     * (browser → desktop; confirm-mode replies). Requesting-user only.
     */
    public function postInput(Request $request, Response $response, array $args): Response
    {
        [$userId, $row, $err] = $this->resolveOwnRequest($request, $response, (string) ($args['id'] ?? ''));
        if ($err !== null) {
            return $err;
        }
        $body = $request->getParsedBody() ?? [];
        $envelope = is_array($body) && is_string($body['envelope'] ?? null) ? (string) $body['envelope'] : '';
        try {
            $result = $this->relay->appendInput($row['requestId'], (string) $row['ownerUserId'], $envelope);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            // The request left the claimed/streaming window (finished or expired) — the
            // desktop is no longer waiting on input for it.
            return $this->jsonError($response, 'This request is not waiting for input', 409, 'not_claimed');
        }
        return $this->jsonResponse($response, ['accepted' => true, 'seq' => $result['seq']], 201);
    }

    /**
     * GET /api/desktop/ai/pubkey?instanceId= — the desktop's published X25519 public key for
     * the browser's TOFU pin (plan §5.1). 404 e2e_key_unknown until the desktop publishes.
     * instanceId may be omitted: the default target resolves exactly like enqueue does.
     */
    public function getPubkey(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $instanceId = (string) ($request->getQueryParams()['instanceId'] ?? '');
        if ($instanceId === '') {
            // No explicit target: resolve the same way enqueue does (assignment pin → implicit
            // single fresh desktop → 409 ambiguous) so a caller can fetch the default key.
            $resolved = $this->commands->resolveTargetInstance((string) $userId, self::TARGET_CONNECTOR_ID);
            if ($resolved['error'] === 'ambiguous_desktop') {
                return $this->jsonError(
                    $response,
                    'More than one FormLogic Desktop is online for this workspace — pass instanceId explicitly.',
                    409,
                    'ambiguous_desktop',
                    ['desktops' => $resolved['desktops']],
                );
            }
            if ($resolved['target'] === null) {
                return $this->jsonError($response, 'No linked FormLogic Desktop is online', 404, 'e2e_key_unknown');
            }
            $instanceId = (string) $resolved['target'];
        }
        if (strlen($instanceId) > 128) {
            return $this->jsonError($response, 'instanceId is too long', 400);
        }
        $key = $this->relay->getPubkey((string) $userId, $instanceId);
        if ($key === null) {
            return $this->jsonError($response, 'The desktop has not published its encryption key yet', 404, 'e2e_key_unknown');
        }
        return $this->jsonResponse($response, ['instanceId' => $instanceId, 'publicKey' => $key]);
    }

    // ── Desktop surface (flk_ key; userId == owner; scope ai:relay or connector:relay) ────

    /**
     * Server-derived caller identity for the desktop surface (audit FL-01): the API key's
     * connection binding is the authority — a claimed instanceId that belongs to a sibling
     * key is refused BEFORE any service call. @return array{0: ?string, 1: ?Response}
     */
    private function resolveCallerInstance(Request $request, Response $response, string $ownerUserId, ?string $claimed): array
    {
        $apiKeyId = $request->getAttribute('apiKeyId');
        try {
            $resolved = $this->commands->resolveDesktopIdentity(
                $ownerUserId,
                is_string($apiKeyId) && $apiKeyId !== '' ? $apiKeyId : null,
                $claimed
            );
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'instance_mismatch') {
                return [null, $this->jsonError($response, 'This desktop instance identity belongs to a different API key', 403, 'instance_mismatch')];
            }
            throw $e;
        }
        return [$resolved, null];
    }

    /**
     * POST /api/v1/desktop-ai/pubkey {instanceId, publicKey} — publish/rotate the desktop's
     * long-term X25519 public key (plan §5.1: on boot when absent). The instance must already
     * have a connection row (the desktop heartbeats first).
     */
    public function publishPubkeyV1(Request $request, Response $response): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        $body = $request->getParsedBody() ?? [];
        $instanceId = is_array($body) && is_string($body['instanceId'] ?? null) ? trim((string) $body['instanceId']) : '';
        $publicKey = is_array($body) && is_string($body['publicKey'] ?? null) ? trim((string) $body['publicKey']) : '';
        if ($instanceId === '' || strlen($instanceId) > 128 || !preg_match('/^[A-Za-z0-9._-]+$/', $instanceId)) {
            return $this->jsonError($response, 'instanceId must match the desktop instance id shape', 400);
        }
        $decoded = $publicKey !== '' ? base64_decode($publicKey, true) : false;
        if ($decoded === false || strlen($decoded) !== 32 || strlen($publicKey) > 88) {
            return $this->jsonError($response, 'publicKey must be a base64-encoded 32-byte X25519 public key', 400);
        }
        // Audit FL-01: only the key BOUND to this instance may publish/rotate its E2E
        // public key — a sibling key rotating another install's key would let it read
        // that install's sealed traffic.
        [$resolvedInstance, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $instanceId);
        if ($identityError !== null) {
            return $identityError;
        }
        $instanceId = $resolvedInstance ?? $instanceId;
        if (!$this->relay->publishPubkey((string) $userId, $instanceId, $publicKey)) {
            return $this->jsonError($response, 'Unknown desktop instance — heartbeat the connection first', 404, 'unknown_desktop_instance');
        }
        return $this->jsonResponse($response, ['published' => true]);
    }

    /**
     * GET /api/v1/desktop-ai/pending?instanceId=&wait=<ms>&since= — long-poll the lane.
     * A targeted request is visible only to its target instance; untargeted rows fan out.
     */
    public function pendingV1(Request $request, Response $response): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        $q = $request->getQueryParams();
        $since = isset($q['since']) && $q['since'] !== '' ? (string) $q['since'] : null;
        $wait = (int) ($q['wait'] ?? 0);
        $limit = (int) ($q['limit'] ?? 50);
        $claimed = isset($q['instanceId']) && $q['instanceId'] !== '' ? (string) $q['instanceId'] : null;
        [$instanceId, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        $requests = $this->relay->pollPending((string) $userId, $since, $wait, $limit, $instanceId);
        return $this->jsonResponse($response, ['requests' => $requests]);
    }

    /** POST /api/v1/desktop-ai/{id}/claim {instanceId} — pending→claimed, single-flight per target. */
    public function claimV1(Request $request, Response $response, array $args): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        $body = $request->getParsedBody() ?? [];
        $claimed = is_array($body) && is_string($body['instanceId'] ?? null) && $body['instanceId'] !== '' ? (string) $body['instanceId'] : null;
        [$resolvedInstance, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        if (is_array($body)) {
            $body['instanceId'] = $resolvedInstance;
        }
        try {
            $req = $this->relay->claim((string) ($args['id'] ?? ''), (string) $userId, is_array($body) ? $body : []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'lane_busy') {
                return $this->jsonError($response, 'Another AI request is already in flight on this desktop', 409, 'lane_busy');
            }
            if ($e->getMessage() === 'targeted_elsewhere') {
                return $this->jsonError($response, 'This request is targeted at a different desktop instance', 409, 'targeted_elsewhere');
            }
            return $this->jsonError($response, 'This request was already claimed or has expired', 409);
        }
        if (!$req) {
            return $this->jsonError($response, 'Request not found', 404);
        }
        return $this->jsonResponse($response, ['request' => $req, 'claimed' => true]);
    }

    /** POST /api/v1/desktop-ai/{id}/frames {instanceId, envelope} — append one sealed OUT frame. */
    public function postFrameV1(Request $request, Response $response, array $args): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        $body = $request->getParsedBody() ?? [];
        $envelope = is_array($body) && is_string($body['envelope'] ?? null) ? (string) $body['envelope'] : '';
        $claimed = is_array($body) && is_string($body['instanceId'] ?? null) && $body['instanceId'] !== ''
            ? (string) $body['instanceId']
            : null;
        [$instanceId, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        try {
            $result = $this->relay->appendFrame((string) ($args['id'] ?? ''), (string) $userId, $envelope, $instanceId);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'not_found') {
                return $this->jsonError($response, 'Request not found', 404);
            }
            if ($e->getMessage() === 'claimed_elsewhere') {
                return $this->jsonError($response, 'This request was claimed by a different desktop instance', 409, 'claimed_elsewhere');
            }
            return $this->jsonError($response, 'This request is not in a claimed state', 409, 'not_claimed');
        }
        return $this->jsonResponse($response, ['accepted' => true, 'seq' => $result['seq'], 'status' => $result['status']], 201);
    }

    /** GET /api/v1/desktop-ai/{id}/input?since=&instanceId= — claimant-bound IN-frame poll. */
    public function inputV1(Request $request, Response $response, array $args): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        $q = $request->getQueryParams();
        $since = (int) ($q['since'] ?? 0);
        $claimed = isset($q['instanceId']) && $q['instanceId'] !== '' ? (string) $q['instanceId'] : null;
        [$instanceId, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        try {
            $result = $this->relay->fetchInput((string) ($args['id'] ?? ''), (string) $userId, $since, $instanceId);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'claimed_elsewhere') {
                return $this->jsonError($response, 'This request was claimed by a different desktop instance', 409, 'claimed_elsewhere');
            }
            return $this->jsonError($response, 'This request is not in a claimed state', 409, 'not_claimed');
        }
        if ($result === null) {
            return $this->jsonError($response, 'Request not found', 404);
        }
        return $this->jsonResponse($response, $result);
    }

    /** POST /api/v1/desktop-ai/{id}/complete {instanceId, status} — done|failed, purges content. */
    public function completeV1(Request $request, Response $response, array $args): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        $body = $request->getParsedBody() ?? [];
        $claimed = is_array($body) && is_string($body['instanceId'] ?? null) && $body['instanceId'] !== '' ? (string) $body['instanceId'] : null;
        [$resolvedInstance, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        if (is_array($body)) {
            $body['instanceId'] = $resolvedInstance;
        }
        try {
            $req = $this->relay->complete((string) ($args['id'] ?? ''), (string) $userId, is_array($body) ? $body : []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'claimed_elsewhere') {
                return $this->jsonError($response, 'This request was claimed by a different desktop instance', 409, 'claimed_elsewhere');
            }
            return $this->jsonError($response, 'This request is not in a claimed state', 409, 'not_claimed');
        }
        if (!$req) {
            return $this->jsonError($response, 'Request not found', 404);
        }
        return $this->jsonResponse($response, ['request' => $req]);
    }

    // ── Shared helpers ──

    /**
     * Encode one OUT frame as an SSE event. The envelope is base64 sealed bytes — the relay
     * emits it verbatim (never decoded server-side).
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseFrameEvent(array $frame): string
    {
        return 'id: ' . (int) $frame['seq'] . "\n"
            . 'event: frame' . "\n"
            . 'data: ' . json_encode([
                'seq' => (int) $frame['seq'],
                'envelope' => (string) $frame['envelope'],
            ], JSON_UNESCAPED_SLASHES) . "\n\n";
    }

    /**
     * Encode a request-status transition as an SSE event (terminal statuses let the client
     * stop waiting even when the final answer produced no frames).
     *
     * @internal Public only so the SSE wire format has a deterministic regression test.
     */
    public static function sseStatusEvent(string $status): string
    {
        return 'event: status' . "\n"
            . 'data: ' . json_encode(['status' => $status], JSON_UNESCAPED_SLASHES) . "\n\n";
    }

    /**
     * Raw SSE loop (the AokieCompanionRelayController pattern, minus admission expiry — this
     * stream is session-authorized, so the hard lifetime alone bounds worker occupancy):
     * emit OUT frames as they land, status transitions as they happen, a heartbeat comment
     * every STREAM_HEARTBEAT_SECONDS while idle, and a clean end marker on terminal status
     * or lifetime expiry so the client reconnects with Last-Event-ID / ?since=.
     *
     * Bypasses the Slim emitter deliberately and terminates the request when done.
     */
    private function emitStream(string $requestId, string $ownerUserId, int $since): never
    {
        set_time_limit(self::STREAM_LIFETIME_SECONDS + 30);
        ignore_user_abort(false);
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Accel-Buffering: no');
        // Raw takeover bypasses CorsMiddleware — re-emit the allowlisted headers, or a
        // cross-origin (api.<host>) stream reader is blocked despite a passing preflight.
        \FormLogic\Middleware\CorsMiddleware::active()?->emitRawSseHeaders();
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
        $deadline = $clock() + self::STREAM_LIFETIME_SECONDS;
        $lastOutput = $clock();
        $lastStatus = null;
        while ($clock() < $deadline) {
            $changed = false;
            foreach ($this->relay->fetchOutput($requestId, $ownerUserId, $cursor) as $frame) {
                echo self::sseFrameEvent($frame);
                $cursor = (int) $frame['seq'];
                $changed = true;
            }
            $status = $this->relay->getStatus($requestId, $ownerUserId);
            if ($status !== $lastStatus) {
                if ($status !== null) {
                    echo self::sseStatusEvent($status);
                }
                $lastStatus = $status;
                $changed = true;
            }
            if ($changed) {
                flush();
                $lastOutput = $clock();
            }
            // A terminal request (or a vanished one) ends the stream after its final frames.
            if ($status === null || in_array($status, ['done', 'failed', 'expired'], true)) {
                break;
            }
            if ($clock() - $lastOutput >= self::STREAM_HEARTBEAT_SECONDS) {
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
     * Resolve the session user + the request row, enforcing the requesting-user match (plan
     * §7: poll/stream/input are restricted to the requester — not just any account member).
     * @return array{0:?string,1:?array,2:?Response} [userId, request, errorResponse]
     */
    private function resolveOwnRequest(Request $request, Response $response, string $id): array
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return [null, null, $this->jsonError($response, 'Authentication required', 401)];
        }
        $row = $this->relay->getForAccess($id, (string) $userId);
        if ($row === null) {
            return [null, null, $this->jsonError($response, 'Request not found', 404)];
        }
        if (!hash_equals((string) $userId, (string) $row['requestingUserId'])) {
            return [null, null, $this->jsonError($response, 'Only the requesting user may access this AI request', 403, 'forbidden')];
        }
        return [(string) $userId, $row, null];
    }

    /**
     * The desktop-side gate: a valid flk_ key (ApiKeyMiddleware already authenticated it and
     * set userId) carrying the ai:relay scope — or the grandfathered connector:relay scope
     * (plan §7: already-linked desktops keep working; new links request the full set).
     * @return array{0:?string,1:?Response} [ownerUserId, errorResponse]
     */
    private function desktopOwner(Request $request, Response $response): array
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return [null, $this->jsonError($response, 'Authentication required', 401)];
        }
        $scopes = $request->getAttribute('apiKeyScopes');
        $scopes = is_array($scopes) ? $scopes : [];
        if (!in_array('ai:relay', $scopes, true) && !in_array('connector:relay', $scopes, true)) {
            return [null, $this->jsonError(
                $response,
                'Insufficient scope. Required: ai:relay — relink FormLogic Desktop to grant it.',
                403,
                'insufficient_scope',
            )];
        }
        return [(string) $userId, null];
    }

    /** SSE resume cursor: Last-Event-ID wins over the ?since= query param (EventSource parity). */
    private function resumeCursor(string $lastEventId, mixed $since): int
    {
        $raw = trim($lastEventId) !== '' ? $lastEventId : (is_scalar($since) ? (string) $since : '0');
        $cursor = filter_var($raw, FILTER_VALIDATE_INT);
        return $cursor === false || $cursor < 0 ? 0 : (int) $cursor;
    }
}
