<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\DesktopCommandService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Desktop ops relay (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.3, Phase 3): account-scoped
 * service/plugin lifecycle commands for the linked FormLogic Desktop, enqueued into
 * desktop_commands under the RESERVED connector id 'desktop' (the desktop's relay loop
 * intercepts that connector before ordinary connector dispatch — plan §5.3 step 2).
 *
 * Tiers (plan §5.3): read ops (list/health) are available to any signed-in user with a
 * linked desktop; lifecycle ops (start/stop/restart/repair) require the same permission
 * the connector-assignment routes use — those are session routes scoped to the account
 * owner by construction, which in this account model is the session user's own workspace
 * (the same owner resolution the Wave-1 AI relay uses), so the gate is owning the linked
 * desktop account the op targets. The split lives in one predicate so a future
 * member→owner account resolution only changes that one method.
 */
class DesktopOpsController
{
    use JsonResponseTrait;

    /** Reserved connector id the desktop intercepts before connector dispatch (plan §5.3). */
    public const OPS_CONNECTOR_ID = 'desktop';

    /** Read-only ops: any signed-in user with a linked desktop. */
    private const READ_OPS = [
        'desktop.services.list',
        'desktop.plugins.list',
        'desktop.plugins.health',
    ];

    /** Lifecycle ops: gated by lifecyclePermission() (connector-assignment parity). */
    private const LIFECYCLE_OPS = [
        'desktop.services.start',
        'desktop.services.stop',
        'desktop.services.restart',
        'desktop.services.repair',
        'desktop.plugins.start',
        'desktop.plugins.stop',
        'desktop.plugins.restart',
    ];

    private const MAX_ID = 128;
    private const ID_PATTERN = '/^[A-Za-z0-9._-]+$/';

    public function __construct(
        private DesktopCommandService $commands,
    ) {
    }

    /** @return string[] the full op allow-list (read + lifecycle). */
    public static function allowedOps(): array
    {
        return array_merge(self::READ_OPS, self::LIFECYCLE_OPS);
    }

    /**
     * POST /api/desktop/ops {op, serviceId?|pluginId?, idempotencyKey?} — enqueue one op.
     * The SERVER picks the target machine (assignment pin → implicit single fresh desktop
     * → 409 ambiguous_desktop), mirroring the connector-command relay; a client-supplied
     * target is discarded.
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

        $op = is_string($body['op'] ?? null) ? trim((string) $body['op']) : '';
        if (!in_array($op, self::allowedOps(), true)) {
            return $this->jsonError($response, 'op must be one of: ' . implode(', ', self::allowedOps()), 400, 'unknown_op');
        }
        $isLifecycle = in_array($op, self::LIFECYCLE_OPS, true);

        // The exact target the op acts on: services.* (except list) need serviceId,
        // plugins.* (except list) need pluginId. Both ride the command payload.
        $payload = [];
        $targetKey = str_starts_with($op, 'desktop.services.') ? 'serviceId' : 'pluginId';
        $targetRequired = !str_ends_with($op, '.list');
        $targetId = $body[$targetKey] ?? null;
        if ($targetRequired) {
            if (!is_string($targetId) || $targetId === '' || strlen($targetId) > self::MAX_ID || !preg_match(self::ID_PATTERN, $targetId)) {
                return $this->jsonError($response, $targetKey . ' is required for ' . $op . ' (max ' . self::MAX_ID . ' chars, letters/digits/._-)', 400);
            }
            $payload[$targetKey] = $targetId;
        } elseif (is_string($targetId) && $targetId !== '') {
            // Tolerated on list ops but shape-checked like everything else.
            if (strlen($targetId) > self::MAX_ID || !preg_match(self::ID_PATTERN, $targetId)) {
                return $this->jsonError($response, $targetKey . ' must be letters/digits/._- (max ' . self::MAX_ID . ' chars)', 400);
            }
            $payload[$targetKey] = $targetId;
        }

        // Tier gate: both tiers need a linked desktop; lifecycle ops additionally need the
        // connector-assignment permission (owner of the desktop account — see class doc).
        if (!$this->commands->hasLinkedDesktop((string) $userId)) {
            return $this->jsonError($response, 'No FormLogic Desktop is linked to this account', 404, 'no_linked_desktop');
        }
        if ($isLifecycle && !$this->lifecyclePermission((string) $userId)) {
            return $this->jsonError($response, 'Only the account owner may run desktop lifecycle operations', 403, 'forbidden');
        }

        $resolved = $this->commands->resolveTargetInstance((string) $userId, self::OPS_CONNECTOR_ID);
        if ($resolved['error'] === 'ambiguous_desktop') {
            return $this->jsonError(
                $response,
                'More than one FormLogic Desktop is online for this workspace — the owner must assign one machine before ops can be routed.',
                409,
                'ambiguous_desktop',
                ['desktops' => $resolved['desktops']],
            );
        }

        $data = [
            'connectorId' => self::OPS_CONNECTOR_ID,
            // The command column carries the SHORT verb ('services.list'): the 'desktop.'
            // prefix IS the connector id, mirroring aokie rows ('call.answer'). The
            // desktop's DesktopOp::from_command pins exactly these short names.
            'command' => substr($op, strlen(self::OPS_CONNECTOR_ID) + 1),
        ];
        if ($payload !== []) {
            $data['payload'] = $payload;
        }
        if (is_string($body['idempotencyKey'] ?? null) && $body['idempotencyKey'] !== '') {
            $data['idempotencyKey'] = (string) $body['idempotencyKey'];
        }
        if ($resolved['target'] !== null) {
            $data['targetInstanceId'] = $resolved['target'];
        }

        try {
            $result = $this->commands->enqueue((string) $userId, (string) $userId, null, $data);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        }
        $command = $result['command'];
        $out = ['commandId' => $command['commandId'], 'status' => $command['status']];
        if (($command['targetInstanceId'] ?? null) !== null) {
            $out['targetInstanceId'] = $command['targetInstanceId'];
        }
        if ($result['created']) {
            return $this->jsonResponse($response, ['data' => $out], 201);
        }
        return $this->jsonResponse($response, ['data' => $out + ['idempotent' => true]], 200);
    }

    /**
     * GET /api/desktop/ops/{id} — status + result of one op command. Truthful about the
     * claimed-but-unreported case (plan §5.8 'uncertain'): a command the desktop claimed
     * but never completed (crashed/disconnected mid-op) is NOT a clean 'expired' — the
     * response marks it {uncertain: true} next to the raw status word.
     */
    public function getOp(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $command = $this->commands->get((string) ($args['id'] ?? ''), (string) $userId);
        if (!$command || ($command['connectorId'] ?? null) !== self::OPS_CONNECTOR_ID) {
            return $this->jsonError($response, 'Command not found', 404);
        }
        // Name the machine(s) involved so the UI can show "handled by <device>".
        $devices = $this->commands->describeInstances((string) $userId, array_filter([
            $command['targetInstanceId'] ?? null,
            $command['claimedBy'] ?? null,
        ]));
        $data = [
            'commandId' => $command['commandId'],
            'op' => $command['command'],
            'status' => $command['status'],
            'result' => $command['result'],
            'error' => $command['error'],
            'createdAt' => $command['createdAt'],
            'expiresAt' => $command['expiresAt'],
        ];
        if ($this->isUncertain($command)) {
            $data['uncertain'] = true;
        }
        if (($command['targetInstanceId'] ?? null) !== null) {
            $data['targetInstanceId'] = $command['targetInstanceId'];
            if (isset($devices[$command['targetInstanceId']])) {
                $data['targetDeviceName'] = $devices[$command['targetInstanceId']];
            }
        }
        if (($command['claimedBy'] ?? null) !== null) {
            $data['claimedBy'] = $command['claimedBy'];
            if (isset($devices[$command['claimedBy']])) {
                $data['claimedByDeviceName'] = $devices[$command['claimedBy']];
            }
        }
        return $this->jsonResponse($response, ['data' => $data]);
    }

    /**
     * Lifecycle permission = the same gate the connector-assignment routes apply: those are
     * session routes where the session user IS the account owner (owner-scoped by
     * construction — see FlowController::putConnectorAssignment). The ops account resolves
     * the same way (Wave-1 relay convention), so owning the linked desktop account is the
     * permission; the check exists separately so future member→owner resolution has exactly
     * one place to change.
     */
    private function lifecyclePermission(string $userId): bool
    {
        return $this->commands->hasLinkedDesktop($userId);
    }

    /**
     * Claimed-but-unreported detection: a row still 'claimed' past its expiry, or 'expired'
     * after having been claimed, means the desktop took the op and never reported back — the
     * op may or may not have run. That's 'uncertain' (plan §5.8), never a clean outcome.
     */
    private function isUncertain(array $command): bool
    {
        $status = (string) ($command['status'] ?? '');
        if (($command['claimedAt'] ?? null) === null) {
            return false;
        }
        if ($status === 'expired') {
            return true;
        }
        if ($status === 'claimed') {
            $expiresAt = strtotime((string) ($command['expiresAt'] ?? ''));
            return $expiresAt !== false && $expiresAt <= time();
        }
        return false;
    }
}
