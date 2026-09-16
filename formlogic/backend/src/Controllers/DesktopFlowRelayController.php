<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\DesktopFlowRelayService;
use FormLogic\Services\FlowService;
use FormLogic\Services\Flows\DesktopEngineUnavailableException;
use FormLogic\Services\Flows\FlowLogicLanguages;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * E2E flow-run relay channel (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 5 §5.7). Two surfaces:
 *   - Web (session-authed, /api/desktop/flows/*): a member ENQUEUES a sealed run of one of their
 *     OWN flows ('desktop' execution location) for their linked desktop, reads its status + live
 *     queue position + repeatable sealed result, and streams the sealed progress frames over SSE.
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
     * validates an explicit target against the owner's linked computers, or resolves the
     * flow assignment / single fresh desktop when no target was selected. The target's last
     * heartbeat must say it can run the flow: a ZIPP-era Desktop whose engine is not reporting
     * healthy takes nothing (409 engine_unavailable), and a flow whose code needs a language
     * other than JavaScript is queued only for a target that advertises it (409
     * language_unsupported; formlogic-python/1).
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

        if (isset($body['targetInstanceId']) && !is_string($body['targetInstanceId'])) {
            return $this->jsonError($response, 'Invalid desktop instance id', 400);
        }
        try {
            $resolved = $this->commands->resolveSealedTarget((string) $userId, self::TARGET_CONNECTOR_ID, $body['targetInstanceId'] ?? null);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        }
        if ($resolved['error'] === 'desktop_not_linked') {
            return $this->jsonError($response, 'The selected computer is not linked to this account', 404, 'desktop_not_linked');
        }
        unset($body['targetInstanceId']);
        if ($resolved['error'] === 'ambiguous_desktop') {
            return $this->jsonError(
                $response,
                'More than one linked desktop runtime is online for this workspace — the owner must assign the flow lane to one machine before runs can be routed.',
                409,
                'ambiguous_desktop',
                ['desktops' => $resolved['desktops']],
            );
        }
        if ($resolved['target'] !== null) {
            $body['targetInstanceId'] = $resolved['target'];
        }

        // The Desktop that claims this run fetches the flow and runs it, so the target is judged
        // on its last heartbeat (FlowLogicLanguages::desktopRuns) for EVERY flow, JavaScript-only
        // and code-free ones included:
        //  - a ZIPP-era target whose engine is not reporting healthy runs nothing, so nothing is
        //    queued for it (409 engine_unavailable) — the browser runs the flow instead;
        //  - formlogic-python/1: a Desktop built before Python ignores data.language and runs
        //    Python as JavaScript, so a flow whose code needs a language other than JavaScript is
        //    queued only for a target whose heartbeat advertises it ('logic-language:<id>'). With
        //    no target (no Desktop online) any Desktop could claim it, so none is known to run
        //    it: refused too (409 language_unsupported).
        $target = $resolved['target'];
        $targetRuns = $target !== null ? $this->flows->desktopLogicLanguages((string) $userId, $target) : null;
        if ($targetRuns === []) {
            return $this->engineUnavailable(
                $response,
                'The selected computer\'s engine is not reporting healthy, so it cannot run flows right now. '
                . 'Check OAIY on that computer, pick another computer, or run the flow in the browser.'
            );
        }
        $missing = FlowLogicLanguages::missing($this->flows->logicLanguagesOf($flow), $targetRuns);
        if ($missing !== []) {
            return $this->languageUnsupported($response, $missing, $target !== null
                ? 'the selected computer does not advertise it. Update OAIY on that computer'
                : 'no linked computer that runs it is online. Open an up-to-date OAIY');
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
     * Ciphertext reads are repeatable until explicit receipt acknowledgement or retention
     * expiry. A lost HTTP response must not destroy the only retrievable answer.
     */
    public function getRun(Request $request, Response $response, array $args): Response
    {
        [$userId, $row, $err] = $this->resolveOwnRequest($request, $response, (string) ($args['id'] ?? ''));
        if ($err !== null) {
            return $err;
        }
        $row['queuePos'] = $this->relay->queuePosition($row['requestId'], (string) $row['ownerUserId']) ?? 0;
        $row['resultEnvelope'] = null;
        $row['resultReceipt'] = null;
        if (($row['resultAvailable'] ?? false) === true) {
            $row['resultEnvelope'] = $this->relay->consumeResultEnvelope($row['requestId'], (string) $row['ownerUserId']);
            $row['resultAvailable'] = $row['resultEnvelope'] !== null;
            if ($row['resultEnvelope'] !== null) {
                $row['resultReceipt'] = hash('sha256', base64_decode($row['resultEnvelope'], true));
            }
        }
        return $this->jsonResponse($response, ['request' => $row]);
    }

    /** POST /api/desktop/flows/runs/{id}/ack — call only after accepting/storing the result. */
    public function acknowledgeResult(Request $request, Response $response, array $args): Response
    {
        [, $row, $err] = $this->resolveOwnRequest($request, $response, (string) ($args['id'] ?? ''));
        if ($err !== null) {
            return $err;
        }
        $body = $request->getParsedBody();
        $receipt = is_array($body) ? ($body['resultReceipt'] ?? null) : null;
        if (!is_string($receipt) || !preg_match('/^[a-f0-9]{64}$/', $receipt)) {
            return $this->jsonError($response, 'A SHA-256 resultReceipt is required', 400);
        }
        if (!$this->relay->acknowledgeResultEnvelope($row['requestId'], (string) $row['ownerUserId'], $receipt)) {
            return $this->jsonError($response, 'Result receipt does not match an available terminal result', 409);
        }
        return $this->jsonResponse($response, ['acknowledged' => true]);
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
        $claimed = isset($q['instanceId']) && $q['instanceId'] !== '' ? (string) $q['instanceId'] : null;
        [$instanceId, $identityError] = $this->resolveCallerInstance($request, $response, (string) $userId, $claimed);
        if ($identityError !== null) {
            return $identityError;
        }
        $requests = $this->relay->pollPending((string) $userId, $since, $wait, $limit, $instanceId);
        return $this->jsonResponse($response, ['requests' => $requests]);
    }

    /**
     * POST /api/v1/desktop-flows/{id}/claim {instanceId, logicLanguages?} — pending→claimed,
     * single-flight per target. The claimant is judged on its declared languages reconciled with
     * the stored heartbeat of the instance it is (FlowService::callerLogicLanguages): a ZIPP-era
     * Desktop whose engine is not reporting healthy is 409 engine_unavailable, and a claim that
     * does not run every language the flow's code needs (absent = JavaScript only) is 409
     * language_unsupported. Either changes nothing; the run stays pending.
     */
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
        // The claimant runs the flow as it is now, so it must be able to: its declared languages
        // (`logicLanguages`; absent = a Desktop from before Python, JavaScript only) reconciled
        // with its stored heartbeat, which alone says whether its engine is up. Checked before
        // the claim, which then changes nothing.
        try {
            $claimantLanguages = FlowLogicLanguages::fromCaller(is_array($body) ? ($body['logicLanguages'] ?? null) : null);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        }
        $claimantLanguages = $this->flows->callerLogicLanguages((string) $userId, $resolvedInstance, $claimantLanguages);
        $pending = $this->relay->get((string) ($args['id'] ?? ''), (string) $userId);
        if ($pending !== null && $claimantLanguages === []) {
            return $this->engineUnavailable(
                $response,
                'This runtime\'s engine is not reporting healthy (its last heartbeat did not carry '
                . FlowLogicLanguages::ENGINE_CAPABILITY . '), so it cannot claim runs. '
                . 'The run stays pending for a computer whose engine is up, or run the flow in the browser.'
            );
        }
        $flow = $pending !== null ? $this->flows->getOwnedFlow((string) $userId, (string) $pending['flowId']) : null;
        if ($flow !== null && !FlowLogicLanguages::runsAll($claimantLanguages)) {
            $missing = FlowLogicLanguages::missing($this->flows->logicLanguagesOf($flow), $claimantLanguages);
            if ($missing !== []) {
                return $this->languageUnsupported($response, $missing, 'this runtime does not declare it. Update OAIY');
            }
        }
        try {
            $req = $this->relay->claim((string) ($args['id'] ?? ''), (string) $userId, is_array($body) ? $body : []);
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
     * 409 engine_unavailable (FlowLogicLanguages::desktopRuns gave []): a ZIPP-era Desktop whose
     * last heartbeat did not report its engine healthy — the code OAIY's own CLI answers with for
     * the same condition. The shape FlowController answers with: {error, code, message}. Nothing
     * was queued or claimed.
     */
    private function engineUnavailable(Response $response, string $message): Response
    {
        return $this->jsonResponse($response, [
            'error' => true,
            'code' => DesktopEngineUnavailableException::CODE,
            'message' => $message,
        ], 409);
    }

    /**
     * 409 language_unsupported (FlowLogicLanguages), the shape FlowController answers reserve and
     * claim refusals with: {error, code, languages, message}. Nothing was queued or claimed.
     *
     * @param list<string> $languages what the Desktop lacks
     */
    private function languageUnsupported(Response $response, array $languages, string $why): Response
    {
        $names = array_map(
            static fn (string $l): string => ['python' => 'Python', 'javascript' => 'JavaScript'][$l] ?? $l,
            $languages
        );
        return $this->jsonResponse($response, [
            'error' => true,
            'code' => 'language_unsupported',
            'languages' => $languages,
            'message' => 'This flow has ' . implode(', ', $names) . ' code, and ' . $why
                . ', or run the flow in the browser.',
        ], 409);
    }

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
                'Insufficient scope. Required: flows:relay — relink linked desktop runtime to grant it.',
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
