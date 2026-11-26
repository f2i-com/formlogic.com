<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Services\MarketplaceCommerceService;
use FormLogic\Services\MarketplaceSandboxService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\MemberPluginService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackService;
use FormLogic\Services\SoftnPackCatalog;
use InvalidArgumentException;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Message\UploadedFileInterface;
use RuntimeException;

/**
 * Marketplace SoftN publishing, private source-hidden live sandbox demos, commerce/licensing,
 * and modular member/app plugins (including SoftN apps packaged as plugins).
 */
class MarketplaceController
{
    use JsonResponseTrait;

    private SoftnPackCatalog $softnCatalog;

    public function __construct(
        private PackCatalogService $catalog,
        private AppService $apps,
        private NativeAppService $native,
        private MarketplaceSandboxService $sandbox,
        private MarketplaceCommerceService $commerce,
        private MemberPluginService $memberPlugins,
        private ?AuditService $audit = null,
        private ?PackService $packs = null,
        ?SoftnPackCatalog $softnCatalog = null
    ) {
        $this->softnCatalog = $softnCatalog ?? new SoftnPackCatalog();
    }

    /**
     * Resolve a Marketplace listing by slug from either the database `pack_catalog` OR the
     * bundled Free SoftN Business Packs catalog (`resources/softn-packs/`).
     *
     * @return array<string, mixed>|null
     */
    private function resolveCatalogForDemo(string $slug, ?string $viewerId = null, bool $ensureInstalled = false, ?string $sandboxToken = null, string $publicOrigin = ''): ?array
    {
        if ($slug === 'landing-pottery-studio') {
            $archivePath = dirname(__DIR__, 2) . '/resources/landing-demos/pottery-studio.softn';
            if (!is_file($archivePath)) {
                return null;
            }
            $record = [
                'id' => 'landing-pottery-studio',
                'slug' => 'landing-pottery-studio',
                'name' => 'Kiln & Wheel Pottery Studio',
                'visibility' => 'public',
                'source_visibility' => 'private',
                'demo_enabled' => 1,
                'demo_app_id' => SoftnPackCatalog::demoAppIdFor('landing-pottery-studio'),
                '_archivePath' => $archivePath,
            ];
            if ($ensureInstalled) {
                $record['demo_app_id'] = $this->sandbox->ensureBundledDemoInstalled(
                    'landing-pottery-studio',
                    $archivePath,
                    'Kiln & Wheel Pottery Studio',
                    $publicOrigin
                );
            }
            return $record;
        }

        $catalog = $this->catalog->getCatalogBySlug($slug);
        if ($catalog !== null) {
            if (($catalog['visibility'] ?? 'public') === 'private') {
                $isPublisher = $viewerId !== null && $viewerId !== '' && (string) ($catalog['publisher_id'] ?? '') === $viewerId;
                $hasValidDemoToken = $sandboxToken !== null && $sandboxToken !== ''
                    && $this->sandbox->resolveVerifiedSandboxDir($catalog, $sandboxToken) !== null;
                if (!$isPublisher && !$hasValidDemoToken) {
                    return null;
                }
            }
            return $catalog;
        }
        $bundled = $this->softnCatalog->asDemoCatalogRecord($slug);
        if ($bundled === null) {
            return null;
        }
        if ($ensureInstalled) {
            $bundled['demo_app_id'] = $this->sandbox->ensureBundledDemoInstalled(
                $slug,
                (string) $bundled['_archivePath'],
                (string) ($bundled['name'] ?? $slug),
                $publicOrigin
            );
        }
        return $bundled;
    }

    /**
     * Read a JSON request body cleanly whether sent with `Content-Type: application/json` OR
     * `Content-Type: text/plain;charset=UTF-8` (CORS simple request from opaque sandbox iframes).
     *
     * @return array<string, mixed>
     */
    private function readJsonBody(Request $request): array
    {
        $parsed = $request->getParsedBody();
        if (is_array($parsed) && $parsed !== []) {
            return $parsed;
        }
        $stream = $request->getBody();
        if ($stream->isSeekable()) {
            $stream->rewind();
        }
        $raw = (string) $stream;
        if ($raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }
        return is_array($parsed) ? $parsed : [];
    }

    /**
     * POST /api/packs/catalog/publish-softn
     * Publish a SoftN app or modular SoftN plugin to the Marketplace from either an uploaded
     * `.softn`/`.zip` archive OR an existing hosted SoftN app owned by the member.
     */
    public function publishSoftn(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }

        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $body = [];
        }
        $uploads = $request->getUploadedFiles();
        $uploadedFile = $uploads['file'] ?? null;

        $tmpPath = null;
        try {
            $project = null;
            if ($uploadedFile instanceof UploadedFileInterface && $uploadedFile->getError() === UPLOAD_ERR_OK) {
                $tmpPath = tempnam(sys_get_temp_dir(), 'softn_mkt_');
                if ($tmpPath === false) {
                    throw new RuntimeException('Could not allocate upload staging file.');
                }
                $uploadedFile->moveTo($tmpPath);
                @chmod($tmpPath, 0600);
                $project = NativeAppService::extractProjectFromArchive($tmpPath);
            } elseif (is_string($body['sourceAppId'] ?? null) && trim($body['sourceAppId']) !== '') {
                $sourceAppId = trim($body['sourceAppId']);
                $sourceApp = $this->apps->getApp($sourceAppId);
                if (!$sourceApp || ($sourceApp['ownerId'] ?? null) !== $userId) {
                    return $this->jsonError($response, 'Source app not found or access denied', 404);
                }
                if (!empty($sourceApp['settings']['sourceProtected'])) {
                    return $this->jsonError($response, 'Source-protected Marketplace apps cannot be republished.', 403);
                }
                $loaded = $this->native->project($sourceAppId);
                if (!$loaded) {
                    return $this->jsonError($response, 'That app does not have a hosted SoftN installation yet.', 400);
                }
                $project = [
                    'home' => true,
                    'version' => 0,
                    'access' => 'members',
                    'files' => is_array($loaded['files'] ?? null) ? $loaded['files'] : [],
                    'assets' => is_array($loaded['assets'] ?? null) ? $loaded['assets'] : [],
                ];
                NativeAppService::validateProject($project);
            } elseif (is_array($body['project'] ?? null)) {
                $project = [
                    'home' => true,
                    'version' => 0,
                    'access' => 'members',
                    'files' => is_array($body['project']['files'] ?? null) ? $body['project']['files'] : [],
                    'assets' => is_array($body['project']['assets'] ?? null) ? $body['project']['assets'] : [],
                ];
                NativeAppService::validateProject($project);
            } else {
                return $this->jsonError($response, 'Upload a .softn/.zip file or choose one of your hosted SoftN apps.', 400);
            }

            $info = MarketplaceSandboxService::inspectProject($project);

            $rawItemType = is_string($body['itemType'] ?? null) ? trim($body['itemType']) : ($info['isPluginManifest'] ? 'plugin' : 'softn_app');
            $itemType = in_array($rawItemType, ['softn_app', 'plugin'], true) ? $rawItemType : 'softn_app';

            $name = is_string($body['name'] ?? null) && trim($body['name']) !== ''
                ? trim($body['name'])
                : $info['name'];
            if (mb_strlen($name) < 2 || mb_strlen($name) > 255) {
                return $this->jsonError($response, 'Name must be between 2 and 255 characters.', 400);
            }

            $description = is_string($body['description'] ?? null) && trim($body['description']) !== ''
                ? mb_substr(trim($body['description']), 0, 5000)
                : $info['description'];

            $sourceVisibility = ($body['sourceVisibility'] ?? 'private') === 'open' ? 'open' : 'private';
            $visibility = in_array($body['visibility'] ?? 'public', ['public', 'private', 'unlisted'], true)
                ? (string) $body['visibility']
                : 'public';
            $billingModel = in_array($body['billingModel'] ?? 'free', ['free', 'one_time', 'subscription'], true)
                ? (string) $body['billingModel']
                : 'free';
            $priceCents = max(0, min(10_000_000, (int) ($body['priceCents'] ?? 0)));
            if ($priceCents > 0 && $billingModel === 'free') {
                $billingModel = 'one_time';
            }
            if ($billingModel === 'free') {
                $priceCents = 0;
            }
            $currency = is_string($body['currency'] ?? null) ? strtoupper(trim($body['currency'])) : 'USD';
            $demoEnabled = !array_key_exists('demoEnabled', $body) || filter_var($body['demoEnabled'], FILTER_VALIDATE_BOOLEAN);
            $compatibleWith = is_string($body['compatibleWith'] ?? null) && trim($body['compatibleWith']) !== ''
                ? mb_substr(trim($body['compatibleWith']), 0, 100)
                : ($itemType === 'plugin' ? 'any' : null);

            $tags = [];
            if (is_array($body['tags'] ?? null)) {
                $tags = array_values(array_filter(array_map(static fn($t): string => is_string($t) ? trim($t) : '', $body['tags'])));
            } elseif (is_string($body['tags'] ?? null) && trim($body['tags']) !== '') {
                $decodedTags = json_decode($body['tags'], true);
                if (is_array($decodedTags)) {
                    $tags = array_values(array_filter(array_map(static fn($t): string => is_string($t) ? trim($t) : '', $decodedTags)));
                } else {
                    $tags = array_values(array_filter(array_map('trim', explode(',', $body['tags']))));
                }
            }
            $tags = array_slice(array_values(array_unique($tags)), 0, 20);

            $category = is_string($body['category'] ?? null) && trim($body['category']) !== ''
                ? mb_substr(trim($body['category']), 0, 100)
                : ($itemType === 'plugin' ? 'Plugins' : 'SoftN Apps');

            $version = is_string($body['version'] ?? null) && trim($body['version']) !== ''
                ? mb_substr(trim($body['version']), 0, 50)
                : $info['version'];

            // Store ONLY safe public summary metadata in pack_versions.pack_data so private source
            // never sits inside downloadable catalog JSON blobs.
            $publicStub = [
                'packMeta' => [
                    'name' => $name,
                    'version' => $version,
                    'itemType' => $itemType,
                    'sourceVisibility' => $sourceVisibility,
                    'renderMode' => $info['renderMode'],
                    'hasBackend' => $info['hasBackend'],
                    'backendRuntime' => $info['backendRuntime'],
                ],
                'forms' => [],
                'apps' => [['name' => $name]],
            ];
            if ($sourceVisibility === 'open') {
                $publicStub['softnManifest'] = json_decode((string) ($project['files']['manifest.json'] ?? '{}'), true);
            }

            $published = $this->catalog->publishPack($publicStub, $userId, [
                'name' => $name,
                'slug' => is_string($body['slug'] ?? null) && trim($body['slug']) !== '' ? trim($body['slug']) : null,
                'description' => $description,
                'icon' => is_string($body['icon'] ?? null) ? mb_substr(trim($body['icon']), 0, 50) : ($itemType === 'plugin' ? 'puzzle' : 'box'),
                'tags' => $tags,
                'category' => $category,
                'itemType' => $itemType,
                'visibility' => $visibility,
                'sourceVisibility' => $sourceVisibility,
                'priceCents' => $priceCents,
                'currency' => $currency,
                'billingModel' => $billingModel,
                'demoEnabled' => $demoEnabled,
                'compatibleWith' => $compatibleWith,
                'pluginMeta' => $info['pluginMeta'],
                'version' => $version,
                'changelog' => is_string($body['changelog'] ?? null) && trim($body['changelog']) !== ''
                    ? trim($body['changelog'])
                    : 'Initial release',
            ]);

            try {
                $installed = $this->sandbox->installPrivateBundle($published['catalogId'], $project);
                $this->catalog->attachDemoBundle(
                    $published['catalogId'],
                    $installed['demoAppId'],
                    $info['pluginMeta'],
                    $demoEnabled
                );
            } catch (\Throwable $e) {
                try {
                    $this->catalog->archivePack($published['catalogId'], $userId);
                } catch (\Throwable) {}
                throw $e;
            }

            if ($this->audit) {
                $this->audit->log('marketplace.publish_softn', 'pack_catalog', $published['catalogId'], $userId, null, [
                    'slug' => $published['slug'],
                    'itemType' => $itemType,
                    'sourceVisibility' => $sourceVisibility,
                    'priceCents' => $priceCents,
                    'demoEnabled' => $demoEnabled,
                ]);
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'catalogId' => $published['catalogId'],
                'versionId' => $published['versionId'],
                'slug' => $published['slug'],
                'itemType' => $itemType,
                'sourceVisibility' => $sourceVisibility,
                'renderMode' => $info['renderMode'],
                'hasBackend' => $info['hasBackend'],
                'backendRuntime' => $info['backendRuntime'],
                'demoEnabled' => $demoEnabled,
            ], 201);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            $code = $e->getCode();
            $status = in_array($code, [400, 401, 402, 403, 404, 409, 422], true) ? $code : 400;
            return $this->jsonError($response, $e->getMessage(), $status);
        } catch (\Throwable $e) {
            error_log('Marketplace publishSoftn error: ' . $e->getMessage());
            return $this->jsonError($response, 'Failed to publish SoftN package to the marketplace.', 500);
        } finally {
            if ($tmpPath !== null && is_file($tmpPath)) {
                @unlink($tmpPath);
            }
        }
    }

    /**
     * POST /api/packs/catalog/{slug}/demo/session
     * Create an isolated ephemeral sandbox demo session for any visitor (signed out OR signed in).
     */
    public function startDemo(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        try {
            $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, true, null, McpOAuthService::publicOrigin($request));
            if (!$catalog) {
                return $this->jsonError($response, 'Marketplace listing not found', 404);
            }
            $session = $this->sandbox->createSession($catalog);
            return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), $session, 201);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410, 422, 429], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /**
     * POST /api/packs/catalog/{slug}/demo/reset
     * Reset a visitor's isolated sandbox database & server-side DOM state.
     */
    public function resetDemo(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        $body = $this->readJsonBody($request);
        $token = is_string($body['token'] ?? null) ? trim($body['token']) : '';
        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            return $this->jsonError($response, 'Marketplace listing not found', 404);
        }
        if ($token === '') {
            return $this->jsonError($response, 'Sandbox token is required.', 400);
        }

        try {
            $result = $this->sandbox->resetSession($catalog, $token);
            return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), $result);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /**
     * GET /api/packs/catalog/{slug}/demo/frame/{token}[/{path:.*}]
     * Serve the sandboxed live demo page (server-rendered DOM for `.ui` apps, or sanitized web
     * assets for HTML/container apps) strictly inside an opaque-origin iframe.
     */
    public function serveDemoFrame(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $token = (string) ($args['token'] ?? '');
        $subPath = (string) ($args['path'] ?? '');
        $viewerId = $request->getAttribute('userId');

        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            $response->getBody()->write('Marketplace demo not found.');
            return $response->withStatus(404)->withHeader('Content-Type', 'text/plain; charset=utf-8');
        }

        // Prevent opening a sandbox demo page directly as a top-level browser tab.
        $secFetchDest = strtolower(trim($request->getHeaderLine('Sec-Fetch-Dest')));
        $ext = strtolower(pathinfo($subPath === '' ? 'index.html' : $subPath, PATHINFO_EXTENSION));
        if ($secFetchDest === 'document' && ($ext === '' || in_array($ext, ['html', 'htm', 'svg', 'xml'], true))) {
            $response->getBody()->write('Open this demo inside the FormLogic Marketplace page.');
            return $response->withStatus(403)->withHeader('Content-Type', 'text/plain; charset=utf-8')->withHeader('Cache-Control', 'no-store');
        }

        try {
            $publicOrigin = McpOAuthService::publicOrigin($request);
            $rendered = $this->sandbox->renderFrame($catalog, $token, $subPath, $publicOrigin);
            $demoApiPrefix = '/api/packs/catalog/' . rawurlencode($slug) . '/demo/';
            $framePrefix = $demoApiPrefix . 'frame/' . $token . '/';
            $policy = MarketplaceSandboxService::demoFramePolicy($publicOrigin, $framePrefix, $demoApiPrefix);

            $response->getBody()->write($rendered['body']);
            return $response
                ->withStatus($rendered['status'])
                ->withHeader('Content-Type', $rendered['contentType'])
                ->withHeader('Content-Security-Policy', $policy)
                ->withHeader('Cache-Control', 'no-store, no-transform')
                ->withHeader('Access-Control-Allow-Origin', '*')
                ->withHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        } catch (RuntimeException $e) {
            // 429: every worker the site's demos may hold is busy rendering one (MarketplaceSandboxService::DEMO_OWNER).
            $status = in_array($e->getCode(), [400, 403, 404, 410, 429], true) ? $e->getCode() : 500;
            $response->getBody()->write($e->getMessage());
            return $response->withStatus($status)->withHeader('Content-Type', 'text/plain; charset=utf-8')->withHeader('Cache-Control', 'no-store');
        }
    }

    /**
     * POST /api/packs/catalog/{slug}/demo/ui-event
     * Process a server-side DOM interaction for a `dom_ssr` `.ui` + `.logic` demo session.
     */
    public function demoUiEvent(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        $body = $this->readJsonBody($request);
        $token = is_string($body['token'] ?? null) ? trim($body['token']) : '';
        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            return $this->jsonError($response, 'Marketplace listing not found', 404);
        }
        if ($token === '') {
            return $this->jsonError($response, 'Sandbox token is required.', 400);
        }

        try {
            $rawInputs = is_array($body['inputs'] ?? null) ? $body['inputs'] : [];
            $safeInputs = [];
            $totalBytes = 0;
            foreach ($rawInputs as $k => $v) {
                if (count($safeInputs) >= 64) {
                    break;
                }
                if (!is_string($k) || $k === '' || strlen($k) > 128) {
                    continue;
                }
                if (in_array($k, ['__proto__', 'constructor', 'prototype'], true)) {
                    continue;
                }
                if (is_bool($v) || is_int($v) || is_float($v)) {
                    $safeInputs[$k] = $v;
                    $totalBytes += strlen($k) + 16;
                } elseif (is_string($v)) {
                    $val = substr($v, 0, 4096);
                    $totalBytes += strlen($k) + strlen($val);
                    if ($totalBytes > 16384) {
                        break;
                    }
                    $safeInputs[$k] = $val;
                }
            }
            $rawValue = $body['value'] ?? '';
            $safeValue = is_bool($rawValue) || is_int($rawValue) || is_float($rawValue)
                ? $rawValue
                : (is_string($rawValue) ? substr($rawValue, 0, 4096) : '');
            $result = $this->sandbox->handleUiEvent($catalog, $token, [
                'type' => is_string($body['type'] ?? null) ? substr($body['type'], 0, 64) : 'click',
                'actionId' => is_string($body['actionId'] ?? null) ? substr($body['actionId'], 0, 128) : '',
                'value' => $safeValue,
                'inputs' => $safeInputs,
            ]);
            return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), $result);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410, 429], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /**
     * POST /api/packs/catalog/{slug}/demo/request
     * Dispatch a live backend API call against the visitor's isolated ephemeral SQLite sandbox.
     */
    public function demoBackendRequest(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        $body = $this->readJsonBody($request);
        $token = is_string($body['token'] ?? null) ? trim($body['token']) : '';
        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            return $this->jsonError($response, 'Marketplace listing not found', 404);
        }
        if ($token === '') {
            return $this->jsonError($response, 'Sandbox token is required.', 400);
        }

        try {
            $result = $this->sandbox->handleBackendRequest($catalog, $token, $body, McpOAuthService::publicOrigin($request));
            if ($result['isRaw']) {
                $safeContentTypes = [
                    'application/json',
                    'application/problem+json',
                    'application/vnd.api+json',
                    'text/plain',
                    'text/csv',
                    'text/tab-separated-values',
                    'application/octet-stream',
                    'image/png',
                    'image/jpeg',
                    'image/gif',
                    'image/webp',
                ];
                $rawCt = preg_replace('/[\r\n\0]+/', '', (string) ($result['contentType'] ?? '')) ?? '';
                $baseMime = strtolower(trim(explode(';', $rawCt, 2)[0]));
                $forceAttachment = !in_array($baseMime, $safeContentTypes, true);
                $chosenContentType = $forceAttachment ? 'application/octet-stream' : $rawCt;

                $response->getBody()->write((string) $result['body']);
                $resp = $response
                    ->withStatus($result['status'])
                    ->withHeader('Content-Type', $chosenContentType)
                    ->withHeader('X-Content-Type-Options', 'nosniff')
                    ->withHeader('Cache-Control', 'no-store');
                if ($forceAttachment) {
                    $resp = $resp->withHeader('Content-Disposition', 'attachment; filename="response.bin"');
                }
                return $resp;
            }
            return $this->jsonResponse(
                $response->withHeader('Cache-Control', 'no-store'),
                is_array($result['body']) ? $result['body'] : ['data' => $result['body']],
                $result['status']
            );
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410, 422, 429], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /** GET /api/packs/catalog/{slug}/demo/tables?token=... — live SQLite tables + matched form schemas for the visitor's sandbox. */
    public function demoTables(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        $token = trim((string) ($request->getQueryParams()['token'] ?? ''));
        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            return $this->jsonError($response, 'Marketplace listing not found', 404);
        }
        if ($token === '') {
            return $this->jsonError($response, 'Sandbox token is required.', 400);
        }
        try {
            $data = $this->sandbox->listSandboxTables($catalog, $token);
            return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), $data);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410, 422], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /** POST /api/packs/catalog/{slug}/demo/records — create a row in the visitor's live sandbox SQLite DB. */
    public function demoCreateRecord(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        $body = $this->readJsonBody($request);
        $token = is_string($body['token'] ?? null) ? trim($body['token']) : '';
        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            return $this->jsonError($response, 'Marketplace listing not found', 404);
        }
        $table = is_string($body['table'] ?? null) ? trim($body['table']) : '';
        $values = is_array($body['values'] ?? null) ? $body['values'] : [];
        if ($token === '' || $table === '') {
            return $this->jsonError($response, 'token and table are required.', 400);
        }
        try {
            $record = $this->sandbox->createSandboxRecord($catalog, $token, $table, $values);
            return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['record' => $record], 201);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410, 422], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /** PUT /api/packs/catalog/{slug}/demo/records — update a row in the visitor's live sandbox SQLite DB. */
    public function demoUpdateRecord(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        $body = $this->readJsonBody($request);
        $token = is_string($body['token'] ?? null) ? trim($body['token']) : '';
        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            return $this->jsonError($response, 'Marketplace listing not found', 404);
        }
        $table = is_string($body['table'] ?? null) ? trim($body['table']) : '';
        $id = $body['id'] ?? null;
        $values = is_array($body['values'] ?? null) ? $body['values'] : [];
        if ($token === '' || $table === '' || $id === null || $id === '') {
            return $this->jsonError($response, 'token, table, and id are required.', 400);
        }
        try {
            $record = $this->sandbox->updateSandboxRecord($catalog, $token, $table, $id, $values);
            return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['record' => $record]);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410, 422], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /** DELETE /api/packs/catalog/{slug}/demo/records — delete a row in the visitor's live sandbox SQLite DB. */
    public function demoDeleteRecord(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $viewerId = $request->getAttribute('userId');
        $body = $this->readJsonBody($request);
        $qp = $request->getQueryParams();
        $token = is_string($body['token'] ?? null) ? trim($body['token']) : trim((string) ($qp['token'] ?? ''));
        $catalog = $this->resolveCatalogForDemo($slug, is_string($viewerId) ? $viewerId : null, false, $token);
        if (!$catalog) {
            return $this->jsonError($response, 'Marketplace listing not found', 404);
        }
        $table = is_string($body['table'] ?? null) ? trim($body['table']) : trim((string) ($qp['table'] ?? ''));
        $id = $body['id'] ?? ($qp['id'] ?? null);
        if ($token === '' || $table === '' || $id === null || $id === '') {
            return $this->jsonError($response, 'token, table, and id are required.', 400);
        }
        try {
            $result = $this->sandbox->deleteSandboxRecord($catalog, $token, $table, $id);
            return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), $result);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 403, 404, 410, 422], true) ? $e->getCode() : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /**
     * POST /api/packs/catalog/{slug}/purchase
     * Purchase or claim a license for a Marketplace SoftN app or plugin.
     */
    public function purchase(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Sign in to purchase or claim this listing.', 401);
        }
        $catalog = $this->catalog->getCatalogBySlug((string) ($args['slug'] ?? ''));
        if (!$catalog || (($catalog['visibility'] ?? 'public') === 'private' && (string) ($catalog['publisher_id'] ?? '') !== $userId)) {
            return $this->jsonError($response, 'Listing not found', 404);
        }
        $body = $request->getParsedBody();
        try {
            $license = $this->commerce->purchaseOrClaim($catalog, $userId, is_array($body) ? $body : []);
            return $this->jsonResponse($response, ['success' => true, 'license' => $license], 201);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 402, 403, 404], true) ? $e->getCode() : 400;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /**
     * POST /api/packs/catalog/{slug}/install
     * Server-side protected installation of a Marketplace SoftN app or modular plugin.
     */
    public function install(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Sign in to install this listing.', 401);
        }
        $slug = (string) ($args['slug'] ?? '');
        $body = $request->getParsedBody();
        $opts = is_array($body) ? $body : [];

        // Bundled Free SoftN + Linked Forms Business Packs (`resources/softn-packs/`)
        if ($this->softnCatalog->getMeta($slug) !== null) {
            if ($this->packs === null) {
                return $this->jsonError($response, 'Pack installer service is unavailable.', 503);
            }
            $mode = is_string($opts['mode'] ?? null) && in_array($opts['mode'], ['bundle', 'softn_only', 'link_forms'], true)
                ? $opts['mode']
                : 'bundle';
            $targetAppId = is_string($opts['targetAppId'] ?? null) ? trim($opts['targetAppId']) : null;
            if ($mode === 'link_forms') {
                if ($targetAppId === null || $targetAppId === '') {
                    return $this->jsonError($response, 'Choose one of your existing SoftN apps to link these forms to.', 400);
                }
                $targetApp = $this->apps->getApp($targetAppId);
                if (!$targetApp || ($targetApp['ownerId'] ?? null) !== $userId) {
                    return $this->jsonError($response, 'Target SoftN app not found or access denied.', 404);
                }
                if (!$this->native->hasManagedDatabase($targetAppId)) {
                    return $this->jsonError($response, 'Target app does not have a SQLite database yet.', 400);
                }
            }
            try {
                $packData = $this->softnCatalog->buildInstallablePack($slug, $mode, $targetAppId);
                if ($packData === null) {
                    return $this->jsonError($response, 'Bundled SoftN pack could not be loaded.', 404);
                }
                // Allow re-installing a copy under a distinct name if requested, or standard dedupe
                if (!empty($opts['name']) && is_string($opts['name'])) {
                    $customName = trim($opts['name']);
                    if ($customName !== '' && isset($packData['apps'][0])) {
                        $packData['apps'][0]['name'] = mb_substr($customName, 0, 120);
                    }
                }
                $imported = $this->packs->importPack($packData, $userId, null, null, null, []);
                $softnApp = null;
                $managementApp = null;
                foreach ($imported['apps'] as $a) {
                    $full = $this->apps->getApp((string) $a['id']);
                    if ($full && !empty($full['settings']['softnApp'])) {
                        $softnApp = $full;
                    } elseif ($full) {
                        $managementApp = $full;
                    }
                }
                return $this->jsonResponse($response, [
                    'success' => true,
                    'itemType' => 'softn_app',
                    'mode' => $mode,
                    'installationId' => $imported['installationId'],
                    'app' => $softnApp ?? $managementApp,
                    'softnApp' => $softnApp,
                    'managementApp' => $managementApp,
                    'apps' => $imported['apps'],
                    'forms' => $imported['forms'],
                    'sourceProtected' => false,
                ], 201);
            } catch (InvalidArgumentException $e) {
                return $this->jsonError($response, $e->getMessage(), 400);
            } catch (RuntimeException $e) {
                $status = str_contains(strtolower($e->getMessage()), 'already installed') ? 409 : 400;
                return $this->jsonError($response, $e->getMessage(), $status);
            }
        }

        $catalog = $this->catalog->getCatalogBySlug($slug);
        if (!$catalog || (($catalog['visibility'] ?? 'public') === 'private' && (string) ($catalog['publisher_id'] ?? '') !== $userId)) {
            return $this->jsonError($response, 'Listing not found', 404);
        }
        try {
            $result = $this->commerce->installListing($catalog, $userId, $opts);
            return $this->jsonResponse($response, ['success' => true] + $result, 201);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            $status = in_array($e->getCode(), [400, 402, 403, 404, 409, 422], true) ? $e->getCode() : 400;
            $code = $status === 402 ? 'license_required' : null;
            return $this->jsonError($response, $e->getMessage(), $status, $code);
        }
    }

    /** GET /api/marketplace/licenses */
    public function myLicenses(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        return $this->jsonResponse($response, ['licenses' => $this->commerce->listBuyerLicenses($userId)]);
    }

    /** GET /api/marketplace/sales */
    public function sellerSales(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        return $this->jsonResponse($response, $this->commerce->getSellerStats($userId));
    }

    // ── Modular Member Plugins & Per-App Plugins ─────────────────────────────

    /** GET /api/member-plugins */
    public function listMemberPlugins(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        return $this->jsonResponse($response, ['plugins' => $this->memberPlugins->listMemberPlugins($userId)]);
    }

    /** PUT /api/member-plugins/{id} */
    public function updateMemberPlugin(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $body = $request->getParsedBody();
        try {
            $plugin = $this->memberPlugins->updateMemberPlugin($userId, (string) ($args['id'] ?? ''), is_array($body) ? $body : []);
            return $this->jsonResponse($response, ['plugin' => $plugin]);
        } catch (RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), in_array($e->getCode(), [400, 403, 404], true) ? $e->getCode() : 400);
        }
    }

    /** DELETE /api/member-plugins/{id} */
    public function uninstallMemberPlugin(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        try {
            $this->memberPlugins->uninstallMemberPlugin($userId, (string) ($args['id'] ?? ''));
            return $this->jsonResponse($response, ['success' => true]);
        } catch (RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), in_array($e->getCode(), [400, 403, 404], true) ? $e->getCode() : 400);
        }
    }

    /** POST /api/member-plugins/{id}/request */
    public function invokeMemberPlugin(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $body = [];
        }
        $appId = is_string($body['appId'] ?? null) && trim($body['appId']) !== '' ? trim($body['appId']) : null;
        try {
            $res = $this->memberPlugins->invokePluginBackend($userId, (string) ($args['id'] ?? ''), $body, $appId, \FormLogic\Services\McpOAuthService::publicOrigin($request));
            return $this->jsonResponse($response, is_array($res['body']) ? $res['body'] : ['data' => $res['body']], $res['status']);
        } catch (InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), in_array($e->getCode(), [400, 403, 404, 422, 429], true) ? $e->getCode() : 500);
        }
    }

    /** GET /api/apps/{id}/plugins */
    public function listAppPlugins(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        try {
            $attached = $this->memberPlugins->listAppPlugins($userId, (string) ($args['id'] ?? ''));
            $available = $this->memberPlugins->listMemberPlugins($userId);
            return $this->jsonResponse($response, ['plugins' => $attached, 'installedPlugins' => $available]);
        } catch (RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), in_array($e->getCode(), [403, 404], true) ? $e->getCode() : 400);
        }
    }

    /** POST /api/apps/{id}/plugins */
    public function attachAppPlugin(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $body = $request->getParsedBody();
        if (!is_array($body) || !is_string($body['memberPluginId'] ?? null) || trim($body['memberPluginId']) === '') {
            return $this->jsonError($response, 'Provide memberPluginId to attach.', 400);
        }
        try {
            $attachment = $this->memberPlugins->attachPluginToApp($userId, (string) ($args['id'] ?? ''), trim($body['memberPluginId']), $body);
            return $this->jsonResponse($response, ['plugin' => $attachment], 201);
        } catch (RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), in_array($e->getCode(), [400, 403, 404], true) ? $e->getCode() : 400);
        }
    }

    /** PUT /api/apps/{id}/plugins/{pluginId} */
    public function updateAppPlugin(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $body = $request->getParsedBody();
        try {
            $attachment = $this->memberPlugins->updateAppPlugin(
                $userId,
                (string) ($args['id'] ?? ''),
                (string) ($args['pluginId'] ?? ''),
                is_array($body) ? $body : []
            );
            return $this->jsonResponse($response, ['plugin' => $attachment]);
        } catch (RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), in_array($e->getCode(), [400, 403, 404], true) ? $e->getCode() : 400);
        }
    }

    /** DELETE /api/apps/{id}/plugins/{pluginId} */
    public function detachAppPlugin(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        try {
            $this->memberPlugins->detachPluginFromApp($userId, (string) ($args['id'] ?? ''), (string) ($args['pluginId'] ?? ''));
            return $this->jsonResponse($response, ['success' => true]);
        } catch (RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), in_array($e->getCode(), [400, 403, 404], true) ? $e->getCode() : 400);
        }
    }
}
