<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Custom-domain management (owner-gated admin CRUD) + the public host→launch resolver.
 *
 * Admin routes live under /api/apps/{id}/domains and require the app owner. The public
 * GET /api/public/launch/by-host returns display/install metadata only.
 */
class AppDomainController
{
    use JsonResponseTrait;

    private AppDomainService $domains;
    private AppService $appService;
    private LoggerInterface $logger;

    public function __construct(AppDomainService $domains, AppService $appService, ?LoggerInterface $logger = null)
    {
        $this->domains = $domains;
        $this->appService = $appService;
        $this->logger = $logger ?? new NullLogger();
    }

    /** @return array{0:?string,1:?array} [userId, app] when the caller owns the app; else nulls. */
    private function requireOwner(Request $request, string $appId): array
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return [null, null];
        }
        $app = $this->appService->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $userId) {
            return [null, null];
        }
        return [$userId, $app];
    }

    private function devOverrideAllowed(): bool
    {
        return (($_ENV['APP_ENV'] ?? getenv('APP_ENV') ?: 'production')) !== 'production';
    }

    public function index(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        return $this->jsonResponse($response, ['domains' => $this->domains->getDomainsForApp($args['id'], $userId)]);
    }

    public function create(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $data = $request->getParsedBody() ?? [];
        $domain = trim((string) ($data['domain'] ?? ''));
        $mode = (string) ($data['mode'] ?? 'launch_page');
        if ($domain === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Enter a domain'], 400);
        }
        try {
            $created = $this->domains->createDomain($args['id'], $userId, $domain, $mode);
            return $this->jsonResponse($response, ['domain' => $created], 201);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Throwable $e) {
            $this->logger->error('domain create failed', ['e' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Could not connect this domain'], 500);
        }
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $data = $request->getParsedBody() ?? [];
        try {
            $updated = $this->domains->updateDomain($args['domainId'], $userId, $data);
            if (!$updated) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Domain not found'], 404);
            }
            return $this->jsonResponse($response, ['domain' => $updated]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function verify(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $result = $this->domains->verifyDomain($args['domainId'], $userId, $this->devOverrideAllowed());
        $status = $result['ok'] ? 200 : ($result['status'] === 'not_found' ? 404 : 200);
        return $this->jsonResponse($response, $result, $status);
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        [$userId] = $this->requireOwner($request, $args['id']);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }
        $ok = $this->domains->deleteDomain($args['domainId'], $userId);
        return $this->jsonResponse($response, ['success' => $ok]);
    }

    /**
     * Public: resolve an incoming host to a launch config. No auth. Returns safe metadata only,
     * or 404 when the host isn't a connected+active domain of a published app.
     */
    public function resolveByHost(Request $request, Response $response): Response
    {
        $host = trim((string) ($request->getQueryParams()['host'] ?? ''));
        if ($host === '') {
            $host = $request->getHeaderLine('Host');
        }
        if ($host === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'No host provided'], 400);
        }
        $config = $this->domains->resolveLaunchConfig($host);
        if (!$config) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Domain not connected'], 404);
        }
        return $this->jsonResponse($response, $config);
    }
}
