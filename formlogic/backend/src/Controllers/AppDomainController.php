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

    /**
     * Public: Android Digital Asset Links (App Links verification), served at the domain ROOT
     * (/.well-known/assetlinks.json) via an .htaccess rewrite. No auth.
     *
     * Default = the hosted FormLogic Native Runtime entry (`com.formlogic.runtime` + its signing-cert
     * fingerprint; the fingerprint is env-overridable via ANDROID_CERT_FINGERPRINT so ops can rotate
     * it without a redeploy, defaulting to the value shipped in the static assetlinks.json). When the
     * request Host resolves to a connected custom domain whose app_domains.native_config declares its
     * own white-label build (`packageName` + non-empty `sha256CertFingerprints`), that build's
     * statement is returned instead so a per-tenant runtime can App-Link-verify its own domain.
     */
    public function assetLinks(Request $request, Response $response): Response
    {
        $package = 'com.formlogic.runtime';
        $fingerprint = trim((string) ($_ENV['ANDROID_CERT_FINGERPRINT'] ?? getenv('ANDROID_CERT_FINGERPRINT') ?: ''));
        if ($fingerprint === '') {
            // Same fingerprint shipped in ui/public/.well-known/assetlinks.json (behaviour preserved).
            $fingerprint = 'BB:B4:82:AC:7A:E1:AF:A7:35:2F:B6:C8:83:36:41:58:09:21:19:42:E6:63:59:4E:D5:51:EB:0D:38:C3:48:08';
        }
        $fingerprints = [$fingerprint];

        // A resolved custom domain may carry its own white-label native build.
        $resolveHost = trim((string) ($request->getQueryParams()['host'] ?? ''));
        if ($resolveHost === '') {
            $resolveHost = $request->getHeaderLine('Host');
        }
        if ($resolveHost !== '') {
            $resolved = $this->domains->resolveAppSlugByHost($resolveHost);
            $nc = is_array($resolved['nativeConfig'] ?? null) ? $resolved['nativeConfig'] : [];
            $pkg = (isset($nc['packageName']) && is_string($nc['packageName'])) ? trim($nc['packageName']) : '';
            $fps = [];
            if (isset($nc['sha256CertFingerprints']) && is_array($nc['sha256CertFingerprints'])) {
                foreach ($nc['sha256CertFingerprints'] as $fp) {
                    if (is_string($fp) && trim($fp) !== '') {
                        $fps[] = trim($fp);
                    }
                }
            }
            if ($pkg !== '' && !empty($fps)) {
                $package = $pkg;
                $fingerprints = $fps;
            }
        }

        $payload = [[
            'relation' => ['delegate_permission/common.handle_all_urls'],
            'target' => [
                'namespace' => 'android_app',
                'package_name' => $package,
                'sha256_cert_fingerprints' => array_values($fingerprints),
            ],
        ]];

        $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        $response->getBody()->write($json === false ? '[]' : $json);
        return $response->withStatus(200)->withHeader('Content-Type', 'application/json');
    }
}
