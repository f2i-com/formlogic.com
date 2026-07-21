<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\DesktopFlowRelayService;
use FormLogic\Services\FlowService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * E2E flow-run relay channel (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 5 §5.7). Two surfaces:
 *   - Web (session-authed, /api/desktop/flows/*): a member ENQUEUES a sealed run of one of their
 *     OWN flows ('desktop' execution location) for their linked desktop, reads its status + live
 *     queue position + (read-once) sealed result, and streams the sealed progress frames over SSE.
 *     Every {id} route is restricted to the REQUESTING user — account members can't read each
 *     other's runs.
 *   - Desktop (flk_ API key, /api/v1/desktop-flows/*): long-polls the lane, claims single-flight,
 *     appends sealed progress frames, and completes with a sealed result (which purges the
 *     request envelope + frames). Scope: `flows:relay`, with legacy `connector:relay` keys
 *     grandfathered (plan §7) — checked here per request because ApiKeyMiddleware's
 *     required-scope list is AND-ed, and these routes accept EITHER scope.
 *
 * The backend never sees plaintext content: envelopes/frames are sealed NaCl-box bodies the
 * endpoints encrypt/decrypt; this relay stores and forwards opaque bytes only. flow_id is the
 * one piece of routing metadata beyond the AI lane's set: the desktop must know WHICH flow to
 * run, and the server validates it against the owner's flow library at enqueue.
 */
class DesktopFlowRelayController
{
    use JsonResponseTrait;

    /** SSE hard lifetime; the stream then ends cleanly and clients reconnect. */
    public const STREAM_LIFETIME_SECONDS = 300;
    /** Heartbeat comment cadence keeping proxies/timeouts from cutting idle streams. */
    public const STREAM_HEARTBEAT_SECONDS = 15;
    private const STREAM_POLL_INTERVAL_MS = 500;

    /** Reserved connector id the flow lane's target resolution pins against (assignment → instance). */
    public const TARGET_CONNECTOR_ID = 'desktop-flow';

    public function __construct(
        private DesktopFlowRelayService $relay,
        private DesktopCommandService $commands,
        private FlowService $flows,
    ) {}

    // ── Web surface (session-authed; userId == owner AND requesting user) ─────────────────

    /**
     * POST /api/desktop/flows/run — enqueue a sealed flow run {flowId, ephPub, envelope,
     * idempotencyKey?}. The flow must belong to the session user (a run of a foreign flow can
     * never be enqueued — the desktop would execute it with the owner's authority). The SERVER
     * picks the target machine (connector assignment pin → implicit single fresh desktop → 409
     * ambiguous_desktop); a client-supplied target is discarded, mirroring the AI lane.
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

        $flowId = is_string($body['flowId'] ?? null) ? (string) $body['flowId'] : '';
        $flow = $flowId !== '' ? $this->flows->getOwnedFlow((string) $userId, $flowId) : null;
        if ($flow === null) {
            return $this->jsonError($response, 'Flow not found', 404);
        }

        unset($body['targetInstanceId']);
        $resolved = $this->commands->resolveTargetInstance((string) $userId, self::TARGET_CONNECTOR_ID);
        if ($resolved['error'] === 'ambiguous_desktop') {
            return $this->jsonError(
                $response,
                'More than one FormLogic Desktop is online for this workspace — the owner must assign the flow lane to one machine before runs can be routed.',
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
                return $this->jsonError($response, 'You already have the maximum number of flow runs in flight — wait for one to finish.', 429, 'queue_full_user');
            }
            if ($e->getMessage() === 'queue_full_desktop') {
                return $this->jsonError($response, 'The desktop flow-run queue is full — wait for a run to finish.', 429, 'queue_full_desktop');
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
     * GET /api/desktop/flows/runs/{id} — status + LIVE queue position. Requesting-user only.
     * For a terminal run with a stored sealed result, the result rides this response EXACTLY
     * ONCE (read-once-then-purge, the flow lane's E2E result design): the first read returns
     * resultEnvelope and clears it server-side; later reads show resultAvailable=false.
     */
    public function getRun(Request $request, Response $response, array $args): Response
    {
        [$userId, $row, $err] = $this->resolveOwnRequest($request, $response, (string) ($args['id'] ?? ''));
        if ($err !== null) {
            return $err;
        }
        $row['queuePos'] = $this->relay->queuePosition($row['requestId'], (string) $row['ownerUserId']) ?? 0;
        $row['resultEnvelope'] = null;
        if (($row['resultAvailable'] ?? false) === true) {
            $row['resultEnvelope'] = $this->relay->consumeResultEnvelope($row['requestId'], (string) $row['ownerUserId']);
            $row['resultAvailable'] = $row['resultEnvelope'] !== null;
        }
        return $this->jsonResponse($response, ['request' => $row]);
    }

    /**
     * GET /api/desktop/flows/runs/{id}/stream?since= — SSE stream of the run's sealed progress
     * frames plus status transitions. Refusals return ordinary JSON errors; an authorized
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

    // ── Desktop surface (flk_ key; userId == owner; scope flows:relay or connector:relay) ──

    /**
     * GET /api/v1/desktop-flows/pending?instanceId=&wait=<ms>&since= — long-poll the lane.
     * A targeted run is visible only to its target instance; untargeted rows fan out.
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
        $instanceId = isset($q['instanceId']) && $q['instanceId'] !== '' ? (string) $q['instanceId'] : null;
        $requests = $this->relay->pollPending((string) $userId, $since, $wait, $limit, $instanceId);
        return $this->jsonResponse($response, ['requests' => $requests]);
    }

    /** POST /api/v1/desktop-flows/{id}/claim {instanceId} — pending→claimed, single-flight per target. */
    public function claimV1(Request $request, Response $response, array $args): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        try {
            $req = $this->relay->claim((string) ($args['id'] ?? ''), (string) $userId, $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'lane_busy') {
                return $this->jsonError($response, 'Another flow run is already in flight on this desktop', 409, 'lane_busy');
            }
            if ($e->getMessage() === 'targeted_elsewhere') {
                return $this->jsonError($response, 'This run is targeted at a different desktop instance', 409, 'targeted_elsewhere');
            }
            return $this->jsonError($response, 'This run was already claimed or has expired', 409);
        }
        if (!$req) {
            return $this->jsonError($response, 'Run not found', 404);
        }
        return $this->jsonResponse($response, ['request' => $req, 'claimed' => true]);
    }

    /** POST /api/v1/desktop-flows/{id}/frames {instanceId, envelope} — append one sealed progress frame. */
    public function postFrameV1(Request $request, Response $response, array $args): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        $body = $request->getParsedBody() ?? [];
        $envelope = is_array($body) && is_string($body['envelope'] ?? null) ? (string) $body['envelope'] : '';
        $instanceId = is_array($body) && is_string($body['instanceId'] ?? null) && $body['instanceId'] !== ''
            ? (string) $body['instanceId']
            : null;
        try {
            $result = $this->relay->appendFrame((string) ($args['id'] ?? ''), (string) $userId, $envelope, $instanceId);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'not_found') {
                return $this->jsonError($response, 'Run not found', 404);
            }
            if ($e->getMessage() === 'claimed_elsewhere') {
                return $this->jsonError($response, 'This run was claimed by a different desktop instance', 409, 'claimed_elsewhere');
            }
            return $this->jsonError($response, 'This run is not in a claimed state', 409, 'not_claimed');
        }
        return $this->jsonResponse($response, ['accepted' => true, 'seq' => $result['seq'], 'status' => $result['status']], 201);
    }

    /**
     * POST /api/v1/desktop-flows/{id}/complete {instanceId, status, resultEnvelope?} —
     * done|failed; purges the request envelope + frames, stores the sealed result until the
     * requester reads it once.
     */
    public function completeV1(Request $request, Response $response, array $args): Response
    {
        [$userId, $err] = $this->desktopOwner($request, $response);
        if ($err !== null) {
            return $err;
        }
        try {
            $req = $this->relay->complete((string) ($args['id'] ?? ''), (string) $userId, $request->getParsedBody() ?? []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'claimed_elsewhere') {
                return $this->jsonError($response, 'This run was claimed by a different desktop instance', 409, 'claimed_elsewhere');
            }
            return $this->jsonError($response, 'This run is not in a claimed state', 409, 'not_claimed');
        }
        if (!$req) {
            return $this->jsonError($response, 'Run not found', 404);
        }
        return $this->jsonResponse($response, ['request' => $req]);
    }

    // ── Shared helpers ──

    /**
     * Encode one progress frame as an SSE event. The envelope is base64 sealed bytes — the
     * relay emits it verbatim (never decoded server-side).
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
     * Encode a run-status transition as an SSE event (terminal statuses let the client
     * stop waiting even when the run produced no frames).
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
     * emit progress frames as they land, status transitions as they happen, a heartbeat
     * comment every STREAM_HEARTBEAT_SECONDS while idle, and a clean end marker on terminal
     * status or lifetime expiry so the client reconnects with Last-Event-ID / ?since=.
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
            // A terminal run (or a vanished one) ends the stream after its final frames.
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
     * Resolve the session user + the run row, enforcing the requesting-user match (plan
     * §7: poll/stream are restricted to the requester — not just any account member).
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
            return [null, null, $this->jsonError($response, 'Run not found', 404)];
        }
        if (!hash_equals((string) $userId, (string) $row['requestingUserId'])) {
            return [null, null, $this->jsonError($response, 'Only the requesting user may access this flow run', 403, 'forbidden')];
        }
        return [(string) $userId, $row, null];
    }

    /**
     * The desktop-side gate: a valid flk_ key (ApiKeyMiddleware already authenticated it and
     * set userId) carrying the flows:relay scope — or the grandfathered connector:relay scope
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
        if (!in_array('flows:relay', $scopes, true) && !in_array('connector:relay', $scopes, true)) {
            return [null, $this->jsonError(
                $response,
                'Insufficient scope. Required: flows:relay — relink FormLogic Desktop to grant it.',
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
