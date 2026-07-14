<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AuditService;
use FormLogic\Services\TrashConflictException;
use FormLogic\Services\TrashService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * Recycle bin endpoints:
 *   GET    /api/trash               — list the caller's bin
 *   POST   /api/trash/{id}/restore  — restore an item (consumes it)
 *   DELETE /api/trash/{id}          — delete forever
 *
 * No download endpoint by design: the snapshots contain record data; owners
 * who want their data use the account backup export instead. The admin
 * acting-as mirror lists/restores a user's bin (names + counts only — the
 * structure-safe surface), never the snapshot contents.
 */
final class TrashController
{
    use JsonResponseTrait;

    public function __construct(
        private TrashService $trash,
        private ?AuditService $auditService = null,
        private ?LoggerInterface $logger = null,
    ) {
    }

    /** GET /api/trash */
    public function index(Request $request, Response $response): Response
    {
        $userId = (string) $request->getAttribute('userId');
        try {
            return $this->jsonResponse($response, ['items' => $this->trash->listTrash($userId)]);
        } catch (\Throwable $e) {
            $this->logger?->error('Trash list failed', ['error' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Could not load the recycle bin'], 500);
        }
    }

    /** POST /api/trash/{id}/restore */
    public function restore(Request $request, Response $response, array $args): Response
    {
        if (($refused = $this->refuseDemo($request, $response)) !== null) {
            return $refused;
        }
        $userId = (string) $request->getAttribute('userId');
        $trashId = (string) ($args['id'] ?? '');

        try {
            $result = $this->trash->restore($trashId, $userId);
            $this->audit($request, 'trash.restore', [
                'trashId' => $trashId,
                'kind' => $result['item']['kind'] ?? null,
                'originalId' => $result['item']['originalId'] ?? null,
                'warnings' => count($result['restored']['warnings'] ?? []),
            ]);
            return $this->jsonResponse($response, [
                'success' => true,
                'item' => $result['item'],
                'restored' => $result['restored'],
            ]);
        } catch (TrashConflictException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 409);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            $status = $e->getMessage() === 'Recycle bin item not found' ? 404 : 400;
            $this->audit($request, 'trash.restore_failed', ['trashId' => $trashId, 'error' => substr($e->getMessage(), 0, 300)]);
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], $status);
        } catch (\Throwable $e) {
            $this->logger?->error('Trash restore crashed', ['trashId' => $trashId, 'error' => $e->getMessage()]);
            $this->audit($request, 'trash.restore_failed', ['trashId' => $trashId, 'error' => substr($e->getMessage(), 0, 300)]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Restore failed unexpectedly — the item is still in the recycle bin'], 500);
        }
    }

    /** DELETE /api/trash/{id} — delete forever */
    public function purge(Request $request, Response $response, array $args): Response
    {
        if (($refused = $this->refuseDemo($request, $response)) !== null) {
            return $refused;
        }
        $userId = (string) $request->getAttribute('userId');
        $trashId = (string) ($args['id'] ?? '');

        try {
            if (!$this->trash->purgeItem($trashId, $userId)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Recycle bin item not found'], 404);
            }
            $this->audit($request, 'trash.purge', ['trashId' => $trashId]);
            return $this->jsonResponse($response, ['success' => true]);
        } catch (\Throwable $e) {
            $this->logger?->error('Trash purge crashed', ['trashId' => $trashId, 'error' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Could not delete the item'], 500);
        }
    }

    /** The shared demo account's bin is provisioning-managed — restores/purges are refused. */
    private function refuseDemo(Request $request, Response $response): ?Response
    {
        $user = $request->getAttribute('user');
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        if ($user !== null && strtolower((string) ($user->email ?? '')) === $demoEmail) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The recycle bin is read-only in the demo.'], 403);
        }
        return null;
    }

    private function audit(Request $request, string $action, array $details = []): void
    {
        try {
            $sp = $request->getServerParams();
            $this->auditService?->log($action, 'trash', $request->getAttribute('userId'), $request->getAttribute('userId'), $sp['REMOTE_ADDR'] ?? null, $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }
}
