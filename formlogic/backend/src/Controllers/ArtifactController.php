<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\Flows\ArtifactService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * SRV-404 HTTP surface for flow artifacts.
 *
 * Every route is owner-scoped and every refusal is typed. Missing and foreign artifacts return
 * the SAME 404: an id that exists under another account must be indistinguishable from one that
 * does not exist at all, or the endpoint becomes an existence oracle.
 *
 * Content is served from {@see ArtifactService::read()}, which authorizes before touching a
 * byte, and always with `Content-Disposition: attachment` plus a nosniff header — an artifact is
 * arbitrary third-party output, so it must never render inline on our origin.
 */
class ArtifactController
{
    use JsonResponseTrait;

    public function __construct(
        private ArtifactService $artifacts,
        private ?\FormLogic\Database\MySQLConnection $db = null,
    ) {}

    /** GET /api/artifacts/{id} — the ref (metadata only; no bytes, no paths). */
    public function show(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $result = $this->artifacts->resolve($userId, (string) ($args['id'] ?? ''), $this->deviceId($request));
        if ($result['ok'] !== true) {
            return $this->jsonResponse(
                $response,
                ['error' => true, 'code' => $result['code'], 'message' => $result['message']],
                $result['code'] === 'artifact_not_found' ? 404 : 409
            );
        }
        return $this->jsonResponse($response, ['artifact' => $result['ref']]);
    }

    /** GET /api/artifacts/{id}/content — the bytes. */
    public function content(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $result = $this->artifacts->read($userId, (string) ($args['id'] ?? ''), $this->deviceId($request));
        if ($result['ok'] !== true) {
            return $this->jsonResponse(
                $response,
                ['error' => true, 'code' => $result['code'], 'message' => $result['message']],
                $result['code'] === 'artifact_not_found' ? 404 : 409
            );
        }
        $ref = $result['ref'];
        $filename = is_string($ref['filename'] ?? null) && $ref['filename'] !== '' ? $ref['filename'] : ($ref['$artifact'] . '.bin');
        $response->getBody()->write($result['bytes']);
        return $response
            ->withHeader('Content-Type', (string) $ref['mediaType'])
            ->withHeader('Content-Length', (string) strlen($result['bytes']))
            // Artifacts are third-party output. Never inline, never sniffed.
            ->withHeader('Content-Disposition', 'attachment; filename="' . addslashes($filename) . '"')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Cache-Control', 'private, no-store');
    }

    /** DELETE /api/artifacts/{id} */
    public function destroy(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if (!$this->artifacts->delete($userId, (string) ($args['id'] ?? ''))) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'artifact_not_found', 'message' => 'No such artifact'], 404);
        }
        return $this->jsonResponse($response, ['deleted' => true]);
    }

    /** GET /api/artifacts/usage — how much of the owner's artifact budget is live. */
    public function usage(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        return $this->jsonResponse($response, ['usage' => $this->artifacts->usage($userId)]);
    }

    /**
     * The device asking, when one is — resolved through the FL-01 identity contract rather than
     * believed from the request. A caller cannot assert a device id: it is derived from the API
     * key the request authenticated with, and a claimed id that contradicts that binding throws
     * `instance_mismatch`. A browser has no API key, so it resolves to null — which is exactly
     * why a device-local artifact refuses for it.
     */
    private function deviceId(Request $request): ?string
    {
        $apiKeyId = $request->getAttribute('apiKeyId');
        if (!is_string($apiKeyId) || $apiKeyId === '' || $this->db === null) {
            return null;
        }
        $userId = (string) $request->getAttribute('userId');
        $claimed = $request->getQueryParams()['deviceId'] ?? null;
        try {
            return \FormLogic\Services\DesktopCommandService::resolveDesktopIdentityWithPdo(
                $this->db->getConnection(),
                $userId,
                $apiKeyId,
                is_string($claimed) && $claimed !== '' ? substr($claimed, 0, 120) : null
            );
        } catch (\RuntimeException) {
            return null; // impersonation attempt — resolve as "no device", which fails closed
        }
    }
}
