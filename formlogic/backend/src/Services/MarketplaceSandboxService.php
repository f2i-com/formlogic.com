<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Middleware\SecurityHeadersMiddleware;
use InvalidArgumentException;
use RuntimeException;

/**
 * Private server-side hosting & source-hidden live sandbox demos for Marketplace SoftN apps
 * and SoftN plugins.
 *
 * Security & IP protection guarantees:
 *  - Private marketplace `.softn` bundles are installed internally under `mkt_<id>` outside any
 *    member's apps table and never exposed via `/api/packs/catalog/{slug}/download`.
 *  - Every visitor demo session gets an ephemeral, HMAC-signed sandbox with its own isolated
 *    SQLite database copy (`storage/marketplace-sandboxes/<sessionId>/private/data`), auto-pruned
 *    after 30 minutes and resettable in 1 click without touching any member auth session.
 *  - Classic `.ui` + `.logic` apps run in `dom_ssr` mode: `bin/marketplace-dom-render.mjs`
 *    evaluates markup, client logic, and backend API calls on the server and streams ONLY
 *    sanitized HTML DOM + CSS to the iframe — zero `.ui`, `.logic`, `server/*`, or `manifest.json`
 *    ever reaches the browser.
 *  - Web/Container apps (`site/` or `index.html` + JS/CSS + PHP/JS/TS/Rust/Python backend) run
 *    in an opaque-origin sandbox iframe (`sandbox="allow-scripts allow-forms"`, no
 *    `allow-same-origin`, no `allow-downloads`, `Sec-Fetch-Dest: document` -> 403) with backend
 *    files, source maps, and manifests strictly withheld and `/api/*` calls proxied to the
 *    visitor's isolated ephemeral SQLite backend.
 */
class MarketplaceSandboxService
{
    public const SESSION_TTL_SECONDS = 1800;
    private const MAX_SWEEP_PER_CALL = 25;
    /**
     * The account every demo is counted as for the workers one account's apps may hold at once
     * (NativeAppService::ownedBy), and the owner a demo's backend is told it is serving. All the
     * site's demos are this one account's apps, however many listings and visitors there are: no
     * real account's id (a UUID, or PluginService's system account), so no member's share is spent
     * on a demo and visitors trying demos always leave a worker for the members' apps.
     */
    public const DEMO_OWNER = 'marketplace-sandbox-owner';

    private const WEB_MIME = [
        'html' => 'text/html; charset=utf-8',
        'htm' => 'text/html; charset=utf-8',
        'js' => 'text/javascript; charset=utf-8',
        'mjs' => 'text/javascript; charset=utf-8',
        'cjs' => 'text/javascript; charset=utf-8',
        'css' => 'text/css; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'svg' => 'image/svg+xml',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        'avif' => 'image/avif',
        'ico' => 'image/x-icon',
        'bmp' => 'image/bmp',
        'woff' => 'font/woff',
        'woff2' => 'font/woff2',
        'ttf' => 'font/ttf',
        'otf' => 'font/otf',
        'mp3' => 'audio/mpeg',
        'wav' => 'audio/wav',
        'ogg' => 'audio/ogg',
        'mp4' => 'video/mp4',
        'webm' => 'video/webm',
        'wasm' => 'application/wasm',
        'glb' => 'model/gltf-binary',
        'gltf' => 'model/gltf+json',
        'bin' => 'application/octet-stream',
        'txt' => 'text/plain; charset=utf-8',
    ];

    private string $sandboxRoot;
    private string $signingSecret;

    public function __construct(
        private NativeAppService $native,
        ?string $sandboxRoot = null,
        ?string $signingSecret = null
    ) {
        $this->sandboxRoot = $sandboxRoot ?? (dirname(__DIR__, 2) . '/storage/marketplace-sandboxes');
        $secret = $signingSecret ?? (string) ($_ENV['JWT_SECRET'] ?? getenv('JWT_SECRET') ?: '');
        if ($secret === '') {
            throw new RuntimeException('JWT_SECRET must be configured before starting marketplace sandbox demos.');
        }
        $this->signingSecret = hash('sha256', 'formlogic-mkt-sandbox:' . $secret);
    }

    /** Internal NativeAppService app id for a marketplace catalog listing. */
    public static function demoAppIdFor(string $catalogId): string
    {
        $clean = preg_replace('/[^a-zA-Z0-9_-]/', '', $catalogId) ?? '';
        if ($clean === '') {
            throw new InvalidArgumentException('Invalid catalog identifier');
        }
        return 'mkt_' . substr($clean, 0, 56);
    }

    /**
     * Inspect a validated SoftN project and extract metadata useful for marketplace listings,
     * plugin discovery, and sandbox rendering.
     *
     * @param array<string, mixed> $project
     * @return array{
     *   name: string,
     *   description: string,
     *   version: string,
     *   renderMode: 'dom_ssr'|'sandbox_web',
     *   hasBackend: bool,
     *   backendRuntime: ?string,
     *   isPluginManifest: bool,
     *   pluginMeta: array<string, mixed>,
     *   routes: list<array{method: string, path: string}>
     * }
     */
    public static function inspectProject(array $project): array
    {
        $files = is_array($project['files'] ?? null) ? $project['files'] : [];
        $manifest = is_string($files['manifest.json'] ?? null) ? json_decode($files['manifest.json'], true) : null;
        if (!is_array($manifest)) {
            throw new InvalidArgumentException('manifest.json is invalid.');
        }

        $main = is_string($manifest['main'] ?? null) ? $manifest['main'] : '';
        $hasSite = NativeAppService::siteEntry($project) !== null;
        $renderMode = (!$hasSite && str_ends_with(strtolower($main), '.ui')) ? 'dom_ssr' : 'sandbox_web';

        $hasServer = is_array($manifest['server'] ?? null);
        $hasContainer = is_array($manifest['backend'] ?? null) && !array_is_list($manifest['backend']);
        $hasBackend = $hasServer || $hasContainer;
        $backendRuntime = null;
        $routes = [];

        if ($hasServer) {
            $backendRuntime = 'logic';
            foreach (is_array($manifest['server']['routes'] ?? null) ? $manifest['server']['routes'] : [] as $r) {
                if (is_array($r) && is_string($r['method'] ?? null) && is_string($r['path'] ?? null)) {
                    $routes[] = ['method' => strtoupper($r['method']), 'path' => $r['path']];
                }
            }
        } elseif ($hasContainer) {
            $backendRuntime = strtolower(trim((string) ($manifest['backend']['runtime'] ?? $manifest['backend']['engine'] ?? 'javascript')));
            foreach (is_array($manifest['backend']['routes'] ?? null) ? $manifest['backend']['routes'] : [] as $r) {
                if (is_string($r)) {
                    $routes[] = ['method' => 'ANY', 'path' => $r];
                }
            }
        }

        $rawPlugin = is_array($manifest['formlogicPlugin'] ?? null) ? $manifest['formlogicPlugin'] : null;
        $capabilities = [];
        if ($hasServer && is_array($manifest['server']['requires']['capabilities'] ?? null)) {
            $capabilities = array_values(array_map('strval', $manifest['server']['requires']['capabilities']));
        } elseif ($hasContainer) {
            $capabilities = ['sql', 'container:' . ($backendRuntime !== '' ? $backendRuntime : 'js')];
        }

        $pluginMeta = [
            'manifestId' => is_string($manifest['id'] ?? null) ? $manifest['id'] : null,
            'renderMode' => $renderMode,
            'hasBackend' => $hasBackend,
            'backendRuntime' => $backendRuntime,
            'capabilities' => $capabilities,
            'routes' => array_slice($routes, 0, 32),
            'supportsSharedDatabase' => $hasBackend,
            'formlogicPlugin' => $rawPlugin !== null ? [
                'id' => is_string($rawPlugin['id'] ?? null) ? $rawPlugin['id'] : null,
                'name' => is_string($rawPlugin['name'] ?? null) ? $rawPlugin['name'] : null,
                'description' => is_string($rawPlugin['description'] ?? null) ? $rawPlugin['description'] : null,
                'settings' => is_array($rawPlugin['settings'] ?? null) ? $rawPlugin['settings'] : [],
                'appSettings' => is_array($rawPlugin['appSettings'] ?? null) ? $rawPlugin['appSettings'] : [],
                'hooks' => is_array($rawPlugin['hooks'] ?? null) ? $rawPlugin['hooks'] : [],
            ] : null,
        ];

        return [
            'name' => is_string($manifest['name'] ?? null) && trim($manifest['name']) !== '' ? trim($manifest['name']) : 'SoftN App',
            'description' => is_string($manifest['description'] ?? null) ? trim($manifest['description']) : '',
            'version' => is_string($manifest['version'] ?? null) && trim($manifest['version']) !== '' ? trim($manifest['version']) : '1.0.0',
            'renderMode' => $renderMode,
            'hasBackend' => $hasBackend,
            'backendRuntime' => $backendRuntime,
            'isPluginManifest' => $rawPlugin !== null,
            'pluginMeta' => $pluginMeta,
            'routes' => $routes,
        ];
    }

    /**
     * Install or update the private server-hosted SoftN bundle for a marketplace listing.
     *
     * @param array<string, mixed> $project
     * @return array{demoAppId: string, version: int, meta: array<string, mixed>}
     */
    public function installPrivateBundle(string $catalogId, array $project): array
    {
        $demoAppId = self::demoAppIdFor($catalogId);
        $meta = self::inspectProject($project);
        $existing = $this->native->get($demoAppId);
        $expectedVersion = is_array($existing) ? (int) ($existing['version'] ?? 0) : 0;

        $normalized = [
            'home' => true,
            'version' => $expectedVersion,
            'access' => 'application',
            'files' => is_array($project['files'] ?? null) ? $project['files'] : [],
            'assets' => is_array($project['assets'] ?? null) ? $project['assets'] : [],
        ];

        // The install's own check runs the backend in one of the site's workers: the demos' account's.
        $this->native->ownedBy($demoAppId, self::DEMO_OWNER);
        $installed = $this->native->install($demoAppId, $normalized, $expectedVersion, null, [
            'by' => 'marketplace',
            'how' => 'upload',
            'summary' => 'Marketplace private sandbox bundle',
        ]);

        return [
            'demoAppId' => $demoAppId,
            'version' => (int) ($installed['version'] ?? 1),
            'meta' => $meta,
        ];
    }

    /**
     * Lazily install a bundled Free SoftN business pack's `.softn` archive under a deterministic
     * internal demo app ID and seed its turnkey demo workspace (`POST /api/setup` + `POST /api/sample/load`)
     * ONCE so every sandbox visitor immediately explores a rich populated app in an isolated SQLite copy.
     *
     * $publicOrigin is the address the visitor reached this site by (McpOAuthService::publicOrigin):
     * a container backend is told it as its host and scheme while it sets the workspace up, as every
     * later demo request tells it (handleBackendRequest). Empty: no address, and the runner says localhost.
     */
    public function ensureBundledDemoInstalled(string $slug, string $archivePath, string $businessName, string $publicOrigin = ''): string
    {
        $demoAppId = SoftnPackCatalog::demoAppIdFor($slug);
        if ($this->native->project($demoAppId) !== null) {
            return $demoAppId;
        }
        $project = NativeAppService::extractProjectFromArchive($archivePath);
        $project['home'] = true;
        $project['access'] = 'members';
        // The install's check and the setup below each run in one of the site's workers: the demos' account's.
        $this->native->ownedBy($demoAppId, self::DEMO_OWNER);
        $this->native->install($demoAppId, $project, 0, null, [
            'by' => 'marketplace-bundled',
            'how' => 'pack',
            'summary' => 'Bundled Free SoftN Marketplace demo bundle',
        ]);

        if (NativeAppService::hasContainerBackend($project)) {
            $ownerIdentity = [
                'demo' => true,
                'sandbox' => true,
                'authenticated' => true,
                'userId' => self::DEMO_OWNER,
                'roleId' => 'owner',
                'formlogic' => [
                    'appId' => $demoAppId,
                    'userId' => self::DEMO_OWNER,
                    'roleId' => 'owner',
                ],
            ];
            $address = NativeAppService::containerAddress($publicOrigin);
            try {
                $setupPayload = json_encode([
                    'business_name' => $businessName !== '' ? $businessName : 'Demo Workspace',
                    'owner_name' => 'Demo Owner',
                    'currency' => 'USD',
                    'timezone' => 'UTC',
                    'load_sample' => true,
                ], JSON_THROW_ON_ERROR);
                $this->native->containerRequest($demoAppId, [
                    'method' => 'POST',
                    'path' => '/api/setup',
                    'query' => '',
                    'headers' => [['content-type', 'application/json']],
                    'bodyBase64' => base64_encode($setupPayload),
                ] + $address, $ownerIdentity);
                $this->native->containerRequest($demoAppId, [
                    'method' => 'POST',
                    'path' => '/api/sample/load',
                    'query' => '',
                    'headers' => [['content-type', 'application/json']],
                    'bodyBase64' => base64_encode('{}'),
                ] + $address, $ownerIdentity);
            } catch (\Throwable) {
                // Non-turnkey or custom apps may not implement /api/setup or /api/sample/load; ignore cleanly.
            }
        }

        return $demoAppId;
    }

    /**
     * Read the full server-stored SoftN project for a marketplace listing (for server-side buyer
     * installation only — NEVER expose this payload to buyers when source_visibility = 'private').
     *
     * @return array<string, mixed>|null
     */
    public function getPrivateBundle(string $demoAppId): ?array
    {
        if ($demoAppId === '') {
            return null;
        }
        return $this->native->project($demoAppId);
    }

    /** Remove a listing's private server-hosted SoftN bundle on archive/delete. */
    public function removePrivateBundle(string $demoAppId): void
    {
        if ($demoAppId === '') {
            return;
        }
        try {
            $this->native->remove($demoAppId);
        } catch (\Throwable) {
            // Ignore cleanup error if already removed
        }
    }

    /**
     * Create a fresh isolated visitor sandbox session with its own ephemeral SQLite copy.
     *
     * @param array<string, mixed> $catalog
     * @return array{
     *   token: string,
     *   expiresAt: string,
     *   renderMode: 'dom_ssr'|'sandbox_web',
     *   hasBackend: bool,
     *   backendRuntime: ?string,
     *   sourceProtected: bool,
     *   framePath: string,
     *   slug: string
     * }
     */
    public function createSession(array $catalog): array
    {
        $this->sweepExpired();
        $activeDirs = is_dir($this->sandboxRoot) ? (glob($this->sandboxRoot . '/sbx*', GLOB_ONLYDIR) ?: []) : [];
        if (count($activeDirs) >= 200) {
            throw new RuntimeException('Live sandbox demos are currently at capacity. Try again shortly.', 429);
        }
        $demoAppId = (string) ($catalog['demo_app_id'] ?? '');
        $slug = (string) ($catalog['slug'] ?? '');
        if ($demoAppId === '' || empty($catalog['demo_enabled'])) {
            throw new RuntimeException('Live sandbox demo is not enabled for this listing.', 404);
        }
        $project = $this->native->project($demoAppId);
        if (!$project) {
            throw new RuntimeException('Demo bundle is unavailable.', 404);
        }
        $info = self::inspectProject($project);

        $sessionId = 'sbx' . bin2hex(random_bytes(12));
        $expiresAt = time() + self::SESSION_TTL_SECONDS;
        $token = $this->signToken($slug, $demoAppId, $sessionId, $expiresAt);

        $sessionDir = $this->sessionDir($sessionId);
        $this->ensureDir($sessionDir);
        $this->ensureDir($sessionDir . '/private');
        $this->ensureDir($sessionDir . '/private/data');

        $meta = [
            'sessionId' => $sessionId,
            'slug' => $slug,
            'demoAppId' => $demoAppId,
            'renderMode' => $info['renderMode'],
            'expiresAt' => $expiresAt,
            'createdAt' => time(),
        ];
        file_put_contents($sessionDir . '/meta.json', json_encode($meta, JSON_THROW_ON_ERROR));
        $this->seedSandboxDatabase($demoAppId, $sessionDir . '/private/data');

        return [
            'token' => $token,
            'expiresAt' => gmdate('c', $expiresAt),
            'renderMode' => $info['renderMode'],
            'hasBackend' => $info['hasBackend'],
            'backendRuntime' => $info['backendRuntime'],
            'sourceProtected' => ($catalog['source_visibility'] ?? 'open') === 'private',
            'framePath' => '/api/packs/catalog/' . rawurlencode($slug) . '/demo/frame/' . $token . '/',
            'slug' => $slug,
        ];
    }

    /**
     * Reset an existing visitor sandbox session's ephemeral SQLite database and server-side UI state.
     *
     * @param array<string, mixed> $catalog
     * @return array{reset: bool, expiresAt: string}
     */
    public function resetSession(array $catalog, string $token): array
    {
        $session = $this->verifySession($catalog, $token);
        $sessionDir = $session['dir'];
        $stateFile = $sessionDir . '/ui-state.json';
        if (is_file($stateFile)) {
            @unlink($stateFile);
        }
        $dataDir = $sessionDir . '/private/data';
        foreach (glob($dataDir . '/*') ?: [] as $f) {
            if (is_file($f) && !is_link($f)) {
                @unlink($f);
            }
        }
        $this->seedSandboxDatabase($session['demoAppId'], $dataDir);
        return [
            'reset' => true,
            'expiresAt' => gmdate('c', $session['expiresAt']),
        ];
    }

    /**
     * Render a page or safe public asset inside the opaque-origin marketplace sandbox iframe.
     *
     * @param array<string, mixed> $catalog
     * @return array{status: int, contentType: string, body: string, isHtml: bool}
     */
    public function renderFrame(array $catalog, string $token, string $subPath, string $publicOrigin): array
    {
        $session = $this->verifySession($catalog, $token);
        $demoAppId = $session['demoAppId'];
        $slug = (string) ($catalog['slug'] ?? '');
        $project = $this->native->project($demoAppId);
        if (!$project) {
            return ['status' => 404, 'contentType' => 'text/plain; charset=utf-8', 'body' => 'Demo unavailable.', 'isHtml' => false];
        }
        $info = self::inspectProject($project);
        $cleanPath = ltrim(str_replace('\\', '/', rawurldecode($subPath)), '/');
        if (str_contains($cleanPath, '..') || str_contains($cleanPath, "\0")) {
            return ['status' => 404, 'contentType' => 'text/plain; charset=utf-8', 'body' => 'Not found.', 'isHtml' => false];
        }

        // Virtual bridge module for SoftN v2 `import { api } from 'softn:api'`
        if ($cleanPath === '__fl_softn_api.mjs') {
            return [
                'status' => 200,
                'contentType' => 'text/javascript; charset=utf-8',
                'body' => $this->buildSoftnApiShimModule($publicOrigin, $slug, $token),
                'isHtml' => false,
            ];
        }

        // Mode A: Classic `.ui` + `.logic` — 100% server-side DOM rendering (zero source sent!)
        if ($info['renderMode'] === 'dom_ssr') {
            if ($cleanPath === '' || $cleanPath === 'index.html') {
                $rendered = $this->runServerDomRender($demoAppId, $session['dir'], ['type' => 'init']);
                $doc = $this->buildDomSsrDocument($rendered['title'], $rendered['html'], $rendered['css'], $publicOrigin, $slug, $token);
                return [
                    'status' => 200,
                    'contentType' => 'text/html; charset=utf-8',
                    'body' => $doc,
                    'isHtml' => true,
                ];
            }
            // Only safe media assets under assets/ are ever served in dom_ssr mode.
            if (preg_match(NativeAppService::MEDIA_PATH, $cleanPath) === 1 && isset($project['assets'][$cleanPath])) {
                $raw = base64_decode((string) $project['assets'][$cleanPath], true);
                if ($raw !== false) {
                    $ext = strtolower(pathinfo($cleanPath, PATHINFO_EXTENSION));
                    return [
                        'status' => 200,
                        'contentType' => self::WEB_MIME[$ext] ?? 'application/octet-stream',
                        'body' => $raw,
                        'isHtml' => false,
                    ];
                }
            }
            return ['status' => 404, 'contentType' => 'text/plain; charset=utf-8', 'body' => 'Not found.', 'isHtml' => false];
        }

        // Mode B: Web / Container SoftN app (`site/` or root `index.html`)
        // Strictly block private/backend/source/map/manifest files.
        if (self::isForbiddenWebPath($cleanPath)) {
            return ['status' => 404, 'contentType' => 'text/plain; charset=utf-8', 'body' => 'Not found.', 'isHtml' => false];
        }

        $siteEntry = NativeAppService::siteEntry($project);
        $frameBase = '/api/packs/catalog/' . rawurlencode($slug) . '/demo/frame/' . $token . '/';
        $files = is_array($project['files'] ?? null) ? $project['files'] : [];
        $assets = is_array($project['assets'] ?? null) ? $project['assets'] : [];

        if ($siteEntry !== null) {
            $rel = $cleanPath === '' ? $siteEntry : (str_ends_with($cleanPath, '/') ? $cleanPath . 'index.html' : $cleanPath);
            $assetKey = 'site/' . $rel;
            if (!isset($assets[$assetKey])) {
                // SPA screen fallback for extensionless routes
                $last = basename($rel);
                if (!str_contains($last, '.')) {
                    $rel = $siteEntry;
                    $assetKey = 'site/' . $siteEntry;
                }
            }
            if (!isset($assets[$assetKey]) || self::isForbiddenWebPath($rel)) {
                return ['status' => 404, 'contentType' => 'text/plain; charset=utf-8', 'body' => 'Not found.', 'isHtml' => false];
            }
            $bytes = base64_decode((string) $assets[$assetKey], true);
            if ($bytes === false) {
                return ['status' => 404, 'contentType' => 'text/plain; charset=utf-8', 'body' => 'Not found.', 'isHtml' => false];
            }
            return $this->formatWebResponse($rel, $bytes, $publicOrigin, $slug, $token, $frameBase);
        }

        // Root HTML SoftN web app (`index.html` + `app.js` + `styles.css` + `assets/*`)
        $manifest = json_decode((string) ($files['manifest.json'] ?? '{}'), true);
        $entryHtml = is_array($manifest) && is_string($manifest['main'] ?? null) ? $manifest['main'] : 'index.html';
        $rel = $cleanPath === '' ? $entryHtml : $cleanPath;

        if (isset($files[$rel]) && !self::isForbiddenWebPath($rel)) {
            return $this->formatWebResponse($rel, (string) $files[$rel], $publicOrigin, $slug, $token, $frameBase);
        }
        if (isset($assets[$rel]) && !self::isForbiddenWebPath($rel)) {
            $bytes = base64_decode((string) $assets[$rel], true);
            if ($bytes !== false) {
                return $this->formatWebResponse($rel, $bytes, $publicOrigin, $slug, $token, $frameBase);
            }
        }
        // Fallback to entry HTML for SPA paths without file extension
        if (!str_contains(basename($rel), '.') && isset($files[$entryHtml])) {
            return $this->formatWebResponse($entryHtml, (string) $files[$entryHtml], $publicOrigin, $slug, $token, $frameBase);
        }

        return ['status' => 404, 'contentType' => 'text/plain; charset=utf-8', 'body' => 'Not found.', 'isHtml' => false];
    }

    /**
     * Dispatch a server-side UI event (`click`, `submit`, `input`, `change`) for a `dom_ssr`
     * marketplace demo session and return ONLY the updated sanitized HTML DOM.
     *
     * @param array<string, mixed> $catalog
     * @param array<string, mixed> $event
     * @return array{html: string, title: string, backendCalls: int}
     */
    public function handleUiEvent(array $catalog, string $token, array $event): array
    {
        $session = $this->verifySession($catalog, $token);
        $rendered = $this->runServerDomRender($session['demoAppId'], $session['dir'], $event);
        return [
            'html' => $rendered['html'],
            'title' => $rendered['title'],
            'backendCalls' => $rendered['backendCalls'],
        ];
    }

    /**
     * Dispatch a live backend API request (`/api/...`) against the visitor's isolated ephemeral
     * SQLite database (supports both classic `.logic` backends and v2 PHP/JS/TS/Rust/Python
     * container backends).
     *
     * $publicOrigin is the address the visitor reached this site by (McpOAuthService::publicOrigin),
     * which a container backend is told as its host and scheme, as an app's own page tells it.
     *
     * @param array<string, mixed> $catalog
     * @param array<string, mixed> $payload
     * @return array{status: int, body: mixed, contentType: string, isRaw: bool}
     */
    public function handleBackendRequest(array $catalog, string $token, array $payload, string $publicOrigin = ''): array
    {
        $session = $this->verifySession($catalog, $token);
        $demoAppId = $session['demoAppId'];
        $project = $this->native->project($demoAppId);
        if (!$project) {
            throw new RuntimeException('Demo bundle is unavailable.', 404);
        }

        $method = strtoupper(trim((string) ($payload['method'] ?? 'GET')));
        if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            throw new InvalidArgumentException('Unsupported HTTP method.');
        }

        $path = trim((string) ($payload['path'] ?? ''));
        $decodedPath = rawurldecode($path);
        $lowerDecoded = strtolower($decodedPath);
        if (
            $path === ''
            || !str_starts_with($path, '/api/')
            || preg_match('/[\x00-\x1f\x7f\\\\?#;]/', $path) === 1
            || preg_match('/[\x00-\x1f\x7f\\\\?#;]/', $decodedPath) === 1
            || str_contains($path, '//')
            || str_contains($decodedPath, '//')
            || str_contains($path, '..')
            || str_contains($decodedPath, '..')
            || $lowerDecoded === '/api/site'
            || str_starts_with($lowerDecoded, '/api/site/')
        ) {
            throw new InvalidArgumentException('Sandbox backend path must start with /api/.');
        }

        $dataDir = $session['dir'] . '/private/data';
        $identity = [
            'demo' => true,
            'sandbox' => true,
            'authenticated' => true,
            'userId' => self::DEMO_OWNER,
            'roleId' => 'owner',
            'formlogic' => [
                'appId' => $demoAppId,
                'userId' => self::DEMO_OWNER,
                'roleId' => 'owner',
            ],
        ];
        // The request runs in one of the site's workers: counted in the demos' account's share.
        $this->native->ownedBy($demoAppId, self::DEMO_OWNER);

        $rawQuery = $payload['query'] ?? [];
        $queryMap = is_array($rawQuery) ? $rawQuery : [];
        $queryString = '';
        if (is_string($rawQuery) && $rawQuery !== '') {
            $queryString = str_starts_with($rawQuery, '?') ? $rawQuery : '?' . $rawQuery;
            parse_str(ltrim($rawQuery, '?'), $parsedQ);
            $queryMap = is_array($parsedQ) ? $parsedQ : [];
        } elseif (is_array($rawQuery) && $rawQuery !== []) {
            $queryString = '?' . http_build_query($rawQuery);
        }

        $body = $payload['body'] ?? null;

        if (NativeAppService::hasContainerBackend($project)) {
            $bodyRaw = is_string($body) ? $body : ($body !== null ? json_encode($body, JSON_THROW_ON_ERROR) : '');
            $reqHeaders = [['content-type', 'application/json']];
            if (is_array($payload['headers'] ?? null)) {
                foreach ($payload['headers'] as $k => $v) {
                    if (is_string($k) && is_scalar($v) && !in_array(strtolower($k), ['cookie', 'host', 'authorization'], true)) {
                        $reqHeaders[] = [strtolower($k), (string) $v];
                    }
                }
            }
            $res = $this->native->sandboxContainerRequest($demoAppId, $dataDir, [
                'method' => $method,
                'path' => $path,
                'query' => $queryString,
                'headers' => $reqHeaders,
                'bodyBase64' => base64_encode($bodyRaw),
            ] + NativeAppService::containerAddress($publicOrigin), $identity);
            $decodedBody = base64_decode($res['bodyBase64'], true);
            $decodedBody = $decodedBody === false ? '' : $decodedBody;
            $ct = 'application/json; charset=utf-8';
            foreach ($res['headers'] as $h) {
                if (is_array($h) && strtolower((string) ($h[0] ?? '')) === 'content-type') {
                    $ct = (string) ($h[1] ?? $ct);
                    break;
                }
            }
            if (str_contains(strtolower($ct), 'json')) {
                $jsonVal = json_decode($decodedBody, true);
                if (json_last_error() === JSON_ERROR_NONE) {
                    return ['status' => $res['status'], 'body' => $jsonVal, 'contentType' => $ct, 'isRaw' => false];
                }
            }
            return ['status' => $res['status'], 'body' => $decodedBody, 'contentType' => $ct, 'isRaw' => true];
        }

        if (!NativeAppService::hasBackend($project)) {
            throw new RuntimeException('This demo app does not declare a backend.', 404);
        }

        $bodyObj = is_array($body) ? $body : (is_string($body) && $body !== '' ? (json_decode($body, true) ?? ['raw' => $body]) : (object) []);
        $res = $this->native->sandboxRequest($demoAppId, $dataDir, [
            'method' => $method,
            'path' => $path,
            'query' => $queryMap === [] ? (object) [] : $queryMap,
            'body' => $bodyObj,
            'headers' => (object) [],
            'client_ip' => '127.0.0.1',
            'photos' => false,
        ], $identity, false);

        return [
            'status' => (int) ($res['status'] ?? 200),
            'body' => $res['body'] ?? null,
            'contentType' => 'application/json; charset=utf-8',
            'isRaw' => false,
        ];
    }

    /**
     * Build the strict Content-Security-Policy for a marketplace demo iframe response.
     */
    public static function demoFramePolicy(string $origin, string $framePrefix, string $demoApiPrefix): string
    {
        $host = (string) preg_replace('~^[a-z][a-z0-9+.-]*://~i', '', $origin);
        $ownFrame = "http://{$host}{$framePrefix} https://{$host}{$framePrefix}";
        $ownDemoApi = "http://{$host}{$demoApiPrefix} https://{$host}{$demoApiPrefix}";
        return implode('; ', [
            'sandbox allow-scripts allow-forms',
            "default-src 'none'",
            "script-src {$ownFrame} 'unsafe-inline' 'wasm-unsafe-eval' blob:",
            "style-src {$ownFrame} 'unsafe-inline'",
            "img-src {$ownFrame} data: blob:",
            "font-src {$ownFrame} data:",
            "media-src {$ownFrame} data: blob:",
            "connect-src {$ownDemoApi}",
            "worker-src {$ownFrame} blob:",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri {$ownFrame}",
            "form-action 'none'",
            "frame-ancestors 'self'" . SecurityHeadersMiddleware::siteFramersPublic(),
        ]);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /** @return array{sessionId: string, demoAppId: string, expiresAt: int, dir: string} */
    private function verifySession(array $catalog, string $token): array
    {
        $slug = (string) ($catalog['slug'] ?? '');
        $demoAppId = (string) ($catalog['demo_app_id'] ?? '');
        if ($demoAppId === '' || preg_match('/^(sbx[a-f0-9]{24})-(\d{10})-([a-f0-9]{32})$/D', $token, $m) !== 1) {
            throw new RuntimeException('Invalid or expired sandbox session. Start a new sandbox demo.', 410);
        }
        $sessionId = $m[1];
        $expiresAt = (int) $m[2];
        $sig = $m[3];
        if ($expiresAt < time()) {
            throw new RuntimeException('This sandbox demo session has expired. Click Reset Sandbox to start a fresh session.', 410);
        }
        $expected = $this->signToken($slug, $demoAppId, $sessionId, $expiresAt);
        if (!hash_equals($expected, $token)) {
            throw new RuntimeException('Invalid sandbox token.', 403);
        }
        $dir = $this->sessionDir($sessionId);
        if (!is_dir($dir) || !is_file($dir . '/meta.json')) {
            throw new RuntimeException('Sandbox session not found. Click Reset Sandbox to start a fresh session.', 410);
        }
        return [
            'sessionId' => $sessionId,
            'demoAppId' => $demoAppId,
            'expiresAt' => $expiresAt,
            'dir' => $dir,
        ];
    }

    private function signToken(string $slug, string $demoAppId, string $sessionId, int $expiresAt): string
    {
        $mac = substr(hash_hmac('sha256', "mktdemo|{$slug}|{$demoAppId}|{$sessionId}|{$expiresAt}", $this->signingSecret), 0, 32);
        return "{$sessionId}-{$expiresAt}-{$mac}";
    }

    private function sessionDir(string $sessionId): string
    {
        return $this->sandboxRoot . '/' . $sessionId;
    }

    private function seedSandboxDatabase(string $demoAppId, string $targetDataDir): void
    {
        $this->ensureDir($targetDataDir);
        $targetDb = $targetDataDir . '/application.sqlite';
        try {
            $this->native->snapshotDatabase($demoAppId, $targetDb);
        } catch (\Throwable) {
            // App may not have created a SQLite DB yet (lazy creation on first backend call)
        }
    }

    /**
     * Execute `bin/marketplace-dom-render.mjs` on the server to render `.ui` + `.logic` purely
     * into sanitized HTML DOM + CSS.
     *
     * The renderer runs the app's code and starts its backend's runner itself, never through this
     * site's host: it holds one of the site's workers while it runs (NativeAppService::withSlots),
     * counted in the demos' account's share as every other demo request is, or is answered busy
     * (429) as they are. Without one, a page of demos rendering at once took no worker at all.
     *
     * @param array<string, mixed> $event
     * @return array{title: string, html: string, css: string, backendCalls: int}
     */
    private function runServerDomRender(string $demoAppId, string $sessionDir, array $event): array
    {
        $this->native->ownedBy($demoAppId, self::DEMO_OWNER);
        return $this->native->withSlots($demoAppId, fn (): array => $this->renderDom($demoAppId, $sessionDir, $event));
    }

    /**
     * @param array<string, mixed> $event
     * @return array{title: string, html: string, css: string, backendCalls: int}
     */
    private function renderDom(string $demoAppId, string $sessionDir, array $event): array
    {
        $paths = $this->native->internalPaths($demoAppId);
        if ($paths === null) {
            throw new RuntimeException('Demo bundle files are missing.', 404);
        }
        $stateFile = $sessionDir . '/ui-state.json';
        $prevState = is_file($stateFile) ? json_decode((string) file_get_contents($stateFile), true) : [];
        if (!is_array($prevState)) {
            $prevState = [];
        }

        $script = dirname(__DIR__, 2) . '/bin/marketplace-dom-render.mjs';
        $payload = json_encode([
            'rootDir' => $paths['root'],
            'appDir' => $paths['app'],
            'dataDir' => $sessionDir . '/private/data',
            'runtimeDir' => $paths['runtime'],
            'state' => $prevState,
            'event' => $event,
        ], JSON_THROW_ON_ERROR);

        $env = NativeAppService::nodeEnvironment(getenv() ?: [], []);
        $cmd = [$paths['node'], '--max-old-space-size=128', '--disable-proto=throw', $script];

        $inFile = tempnam(sys_get_temp_dir(), 'fl-dom-in-');
        $outFile = tempnam(sys_get_temp_dir(), 'fl-dom-out-');
        $errFile = tempnam(sys_get_temp_dir(), 'fl-dom-err-');
        if ($inFile === false || $outFile === false || $errFile === false) {
            throw new RuntimeException('Could not allocate temporary render buffers.');
        }

        $process = null;
        try {
            file_put_contents($inFile, $payload);
            $process = proc_open(
                $cmd,
                [
                    0 => ['file', $inFile, 'r'],
                    1 => ['file', $outFile, 'w'],
                    2 => ['file', $errFile, 'w'],
                ],
                $pipes,
                $paths['root'],
                $env,
                ['bypass_shell' => true]
            );
            if (!is_resource($process)) {
                throw new RuntimeException('Sandbox renderer could not start.');
            }
            $deadline = microtime(true) + 15.0;
            do {
                $status = proc_get_status($process);
                if (!$status['running']) {
                    break;
                }
                if (microtime(true) >= $deadline) {
                    proc_terminate($process);
                    throw new RuntimeException('Sandbox render timed out.');
                }
                usleep(15000);
            } while (true);

            $raw = (string) file_get_contents($outFile, false, null, 0, 4 * 1024 * 1024);
            $decoded = json_decode($raw, true);
            if (!is_array($decoded) || !is_string($decoded['html'] ?? null)) {
                $err = trim((string) file_get_contents($errFile, false, null, 0, 1024));
                throw new RuntimeException('Sandbox render failed' . ($err !== '' ? ': ' . $err : '.'));
            }

            $nextState = is_array($decoded['state'] ?? null) ? $decoded['state'] : [];
            file_put_contents($stateFile, json_encode($nextState, JSON_THROW_ON_ERROR));

            return [
                'title' => is_string($decoded['title'] ?? null) ? $decoded['title'] : 'Marketplace Sandbox',
                'html' => $decoded['html'],
                'css' => is_string($decoded['css'] ?? null) ? $decoded['css'] : '',
                'backendCalls' => (int) ($decoded['backendCalls'] ?? 0),
            ];
        } finally {
            if (is_resource($process)) {
                proc_close($process);
            }
            foreach ([$inFile, $outFile, $errFile] as $tmp) {
                if (is_file($tmp)) {
                    @unlink($tmp);
                }
            }
        }
    }

    /**
     * Build the minimal standalone HTML document for `dom_ssr` mode.
     * Contains ZERO `.ui` or `.logic` source — only rendered HTML DOM + tiny event forwarding bridge.
     */
    private function buildDomSsrDocument(string $title, string $html, string $css, string $publicOrigin, string $slug, string $token): string
    {
        $safeTitle = htmlspecialchars($title, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $eventUrl = rtrim($publicOrigin, '/') . '/api/packs/catalog/' . rawurlencode($slug) . '/demo/ui-event';
        $eventUrlJson = json_encode($eventUrl, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP);
        $tokenJson = json_encode($token, JSON_THROW_ON_ERROR | JSON_HEX_TAG | JSON_HEX_AMP);
        // Escape `<` inside <style> so nested `</st</styleyle>` cannot break out into HTML/script.
        $safeCss = str_replace('<', '\\3c ', $css);

        return <<<HTML
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{$safeTitle}</title>
  <style>{$safeCss}
  .fl-demo-busy { opacity: 0.72; pointer-events: none; transition: opacity 0.12s ease; }
  </style>
</head>
<body>
  <div id="fl-dom-root">{$html}</div>
  <script>
  (function(){
    var URL_EVENT = {$eventUrlJson};
    var TOKEN = {$tokenJson};
    var root = document.getElementById('fl-dom-root');
    var pending = false;

    function collectInputs() {
      var map = {};
      var els = root.querySelectorAll('[data-fl-bind]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var key = el.getAttribute('data-fl-bind');
        if (!key) continue;
        map[key] = el.type === 'checkbox' ? Boolean(el.checked) : el.value;
      }
      return map;
    }

    function sendEvent(actionId, value) {
      if (pending || !actionId) return;
      pending = true;
      root.classList.add('fl-demo-busy');
      fetch(URL_EVENT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ token: TOKEN, actionId: actionId, value: value, inputs: collectInputs() })
      })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data && typeof data.html === 'string') {
          root.innerHTML = data.html;
        }
      })
      .catch(function(){})
      .finally(function(){
        pending = false;
        root.classList.remove('fl-demo-busy');
      });
    }

    root.addEventListener('click', function(ev) {
      var target = ev.target && ev.target.closest ? ev.target.closest('[data-fl-click]') : null;
      if (!target) return;
      ev.preventDefault();
      sendEvent(target.getAttribute('data-fl-click'), '');
    });

    root.addEventListener('submit', function(ev) {
      var form = ev.target && ev.target.closest ? ev.target.closest('[data-fl-submit]') : null;
      if (!form) return;
      ev.preventDefault();
      sendEvent(form.getAttribute('data-fl-submit'), '');
    });

    root.addEventListener('change', function(ev) {
      var target = ev.target && ev.target.closest ? ev.target.closest('[data-fl-change]') : null;
      if (!target) return;
      var val = target.type === 'checkbox' ? Boolean(target.checked) : target.value;
      sendEvent(target.getAttribute('data-fl-change'), val);
    });
  })();
  </script>
</body>
</html>
HTML;
    }

    /** Virtual `softn:api` module for SoftN v2 web apps inside the marketplace sandbox iframe. */
    private function buildSoftnApiShimModule(string $publicOrigin, string $slug, string $token): string
    {
        $reqUrl = rtrim($publicOrigin, '/') . '/api/packs/catalog/' . rawurlencode($slug) . '/demo/request';
        $reqUrlJson = json_encode($reqUrl, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $tokenJson = json_encode($token, JSON_THROW_ON_ERROR);

        return <<<JS
const REQ_URL = {$reqUrlJson};
const TOKEN = {$tokenJson};

async function sandboxFetch(path, options = {}) {
  const raw = String(path || '');
  let apiPath = raw;
  let query = '';
  try {
    const u = new URL(raw, 'https://sandbox.local');
    apiPath = u.pathname;
    query = u.search || '';
  } catch {}
  const method = String(options.method || 'GET').toUpperCase();
  const res = await fetch(REQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({
      token: TOKEN,
      method,
      path: apiPath,
      query,
      headers: options.headers || {},
      body: options.body !== undefined ? options.body : null
    })
  });
  return res;
}

export const api = { fetch: sandboxFetch };
export default api;
JS;
    }

    /** Format a sanitized web asset or HTML page for `sandbox_web` mode. */
    private function formatWebResponse(string $relPath, string $bytes, string $publicOrigin, string $slug, string $token, string $frameBase): array
    {
        $ext = strtolower(pathinfo($relPath, PATHINFO_EXTENSION));
        $mime = self::WEB_MIME[$ext] ?? 'application/octet-stream';

        // Strip sourceMappingURL from JS/CSS so source maps never leak
        if (in_array($ext, ['js', 'mjs', 'cjs', 'css'], true)) {
            $bytes = (string) preg_replace('~//[#@]\s*sourceMappingURL=.*$~m', '', $bytes);
            $bytes = (string) preg_replace('~/\*[#@]\s*sourceMappingURL=.*?\*/~s', '', $bytes);
        }

        if ($ext === 'css') {
            $bytes = (string) preg_replace(['~(url\(\s*["\']?)/(?!/)~i', '~(@import\s+["\'])/(?!/)~i'], '${1}' . $frameBase, $bytes);
            return ['status' => 200, 'contentType' => $mime, 'body' => $bytes, 'isHtml' => false];
        }

        if ($ext === 'html' || $ext === 'htm') {
            $reqUrl = rtrim($publicOrigin, '/') . '/api/packs/catalog/' . rawurlencode($slug) . '/demo/request';
            $reqUrlJson = json_encode($reqUrl, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP);
            $tokenJson = json_encode($token, JSON_THROW_ON_ERROR | JSON_HEX_TAG | JSON_HEX_AMP);
            $baseHref = htmlspecialchars($frameBase, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
            $inject = '<base href="' . $baseHref . '">'
                . '<script type="importmap">{"imports":{"softn:api":"' . $baseHref . '__fl_softn_api.mjs"}}</script>'
                . '<script>(function(){'
                . 'var REQ=' . $reqUrlJson . ';var TOK=' . $tokenJson . ';var origFetch=window.fetch.bind(window);'
                . 'function extractApi(u){try{var p=new URL(String(u),location.href);if(p.pathname.indexOf("/api/")===0&&p.pathname.indexOf("/api/packs/catalog/")!==0)return {path:p.pathname,query:p.search||""};}catch(e){}return null;}'
                . 'window.fetch=function(input,init){'
                . 'var url=typeof input==="string"?input:(input&&input.url?input.url:"");'
                . 'var api=extractApi(url);'
                . 'if(!api)return origFetch(input,init);'
                . 'var opts=init||{};var method=String(opts.method||(input&&input.method)||"GET").toUpperCase();'
                . 'var body=opts.body!==undefined?opts.body:null;'
                . 'return origFetch(REQ,{method:"POST",headers:{"Content-Type":"text/plain;charset=UTF-8"},body:JSON.stringify({token:TOK,method:method,path:api.path,query:api.query,body:body})});'
                . '};'
                . '})();</script>';

            if (preg_match('/<head\b[^>]*>/i', $bytes, $m, PREG_OFFSET_CAPTURE) === 1) {
                $pos = $m[0][1] + strlen($m[0][0]);
                $bytes = substr($bytes, 0, $pos) . $inject . substr($bytes, $pos);
            } else {
                $bytes = $inject . $bytes;
            }
            return ['status' => 200, 'contentType' => $mime, 'body' => $bytes, 'isHtml' => true];
        }

        return ['status' => 200, 'contentType' => $mime, 'body' => $bytes, 'isHtml' => false];
    }

    /** Strictly withhold backend/source/manifest/sourcemap files from sandbox web serving. */
    private static function isForbiddenWebPath(string $path): bool
    {
        $norm = ltrim(strtolower($path), '/');
        if ($norm === 'manifest.json' || str_ends_with($norm, '/manifest.json')) {
            return true;
        }
        if (preg_match('~^(?:server|backend|private|logic)/~', $norm) === 1) {
            return true;
        }
        if (preg_match('~\.(?:sql|php\d?|phtml|rs|py|logic|ui|map|xdb|toml|env|sqlite|db)$~', $norm) === 1) {
            return true;
        }
        return false;
    }

    /**
     * Verify a visitor sandbox token against `$catalog` and return the ephemeral sandbox root
     * directory (`storage/marketplace-sandboxes/sbx...`) when valid and its SQLite DB exists.
     *
     * @param array<string, mixed> $catalog
     */
    public function resolveVerifiedSandboxDir(array $catalog, string $token): ?string
    {
        if ($token === '') {
            return null;
        }
        try {
            $session = $this->verifySession($catalog, $token);
        } catch (\Throwable) {
            return null;
        }
        $dir = $session['dir'];
        $dbPath = $dir . '/private/data/application.sqlite';
        if (!is_dir($dir) || is_link($dir) || !is_file($dbPath) || is_link($dbPath)) {
            return null;
        }
        return $dir;
    }

    /**
     * List all user SQLite tables, rows, column definitions, and schema-matched FormLogic form
     * definitions for the visitor's live ephemeral sandbox database.
     *
     * @param array<string, mixed> $catalog
     * @return array<string, mixed>
     */
    public function listSandboxTables(array $catalog, string $token): array
    {
        $session = $this->verifySession($catalog, $token);
        $pdo = $this->openSandboxSqlite($session['dir']);
        $slug = (string) ($catalog['slug'] ?? '');
        $formMetaByTable = $this->loadBundledFormSchemasByTable($slug);

        $tableNames = $this->listSandboxTableNames($pdo);
        $tables = [];
        // Prefer bundled form order first so domain tables appear before internal settings/users tables.
        $ordered = array_values(array_unique(array_merge(
            array_values(array_intersect(array_keys($formMetaByTable), $tableNames)),
            $tableNames
        )));

        foreach ($ordered as $tableName) {
            $cols = $this->sandboxTableColumns($pdo, $tableName);
            $pk = $this->primaryKeyColumn($cols);
            $quoted = '"' . str_replace('"', '""', $tableName) . '"';
            $count = (int) $pdo->query("SELECT COUNT(*) FROM {$quoted}")->fetchColumn();
            $rawRows = $pdo->query("SELECT * FROM {$quoted} ORDER BY rowid DESC LIMIT 200")->fetchAll(\PDO::FETCH_ASSOC);
            $rows = [];
            foreach ($rawRows as $r) {
                if (!is_array($r)) continue;
                foreach (array_keys($r) as $rk) {
                    if (preg_match('/(password|secret|token_hash|salt)/i', (string) $rk) === 1) {
                        unset($r[$rk]);
                    }
                }
                $rows[] = $r;
            }
            $visibleCols = array_values(array_filter(
                $cols,
                static fn(array $c): bool => preg_match('/(password|secret|token_hash|salt)/i', $c['name']) !== 1
            ));

            $formMeta = $formMetaByTable[$tableName] ?? null;
            $statusCol = is_string($formMeta['statusColumn'] ?? null)
                ? (string) $formMeta['statusColumn']
                : $this->detectStatusColumn($visibleCols);
            $fields = is_array($formMeta['fields'] ?? null) && $formMeta['fields'] !== []
                ? $formMeta['fields']
                : $this->deriveFormFieldsFromColumns($visibleCols, $pk);
            $fields = $this->enrichFieldsWithForeignKeys($pdo, $tableName, $fields);

            $tables[] = [
                'name' => $tableName,
                'title' => is_string($formMeta['title'] ?? null) && $formMeta['title'] !== ''
                    ? (string) $formMeta['title']
                    : ucwords(str_replace('_', ' ', (string) preg_replace('/^(?:ak|au|us|ohs)_/', '', $tableName))),
                'icon' => is_string($formMeta['icon'] ?? null) ? (string) $formMeta['icon'] : 'Table2',
                'description' => is_string($formMeta['description'] ?? null) ? (string) $formMeta['description'] : '',
                'primaryKey' => $pk,
                'statusColumn' => $statusCol,
                'columns' => $visibleCols,
                'fields' => $fields,
                'rowCount' => $count,
                'rows' => $rows,
                'isFormTable' => $formMeta !== null,
            ];
        }

        return [
            'slug' => $slug,
            'tables' => $tables,
        ];
    }

    /**
     * Insert a row directly into the visitor's live ephemeral sandbox SQLite database.
     *
     * @param array<string, mixed> $catalog
     * @param array<string, mixed> $values
     * @return array<string, mixed>
     */
    public function createSandboxRecord(array $catalog, string $token, string $table, array $values): array
    {
        $session = $this->verifySession($catalog, $token);
        $pdo = $this->openSandboxSqlite($session['dir']);
        $this->assertValidSandboxTable($pdo, $table);

        $cols = $this->sandboxTableColumns($pdo, $table);
        $colByName = [];
        foreach ($cols as $c) {
            $colByName[$c['name']] = $c;
        }
        $pk = $this->primaryKeyColumn($cols);
        $nowIso = gmdate('Y-m-d\TH:i:s\Z');

        $insertData = [];
        foreach ($values as $k => $v) {
            if (!is_string($k) || !isset($colByName[$k])) {
                continue;
            }
            if ($v === '' && !$colByName[$k]['notnull']) {
                $insertData[$k] = null;
                continue;
            }
            $insertData[$k] = is_bool($v) ? ($v ? 1 : 0) : (is_array($v) ? json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : $v);
        }

        // Auto-assign TEXT primary key when omitted; INTEGER PRIMARY KEY is auto-assigned by SQLite.
        if ($pk !== null && !array_key_exists($pk, $insertData) && isset($colByName[$pk])) {
            $pkType = strtoupper($colByName[$pk]['type']);
            if (!str_contains($pkType, 'INT')) {
                $insertData[$pk] = 'rec_' . bin2hex(random_bytes(6));
            }
        }
        // Populate standard timestamps & satisfy any remaining NOT NULL columns without defaults.
        foreach ($cols as $c) {
            $cn = $c['name'];
            if (array_key_exists($cn, $insertData)) {
                continue;
            }
            if ($c['pk'] && str_contains(strtoupper($c['type']), 'INT')) {
                continue;
            }
            if (in_array(strtolower($cn), ['created_at', 'updated_at'], true)) {
                $insertData[$cn] = $nowIso;
                continue;
            }
            if ($c['notnull'] && $c['dflt_value'] === null) {
                $upperType = strtoupper($c['type']);
                $insertData[$cn] = (str_contains($upperType, 'INT') || str_contains($upperType, 'REAL') || str_contains($upperType, 'NUM')) ? 0 : '';
            }
        }
        if ($insertData === []) {
            throw new InvalidArgumentException('Provide at least one field value.');
        }

        $quotedTable = '"' . str_replace('"', '""', $table) . '"';
        $colSql = [];
        $placeSql = [];
        $params = [];
        foreach ($insertData as $k => $v) {
            $colSql[] = '"' . str_replace('"', '""', $k) . '"';
            $placeSql[] = '?';
            $params[] = $v;
        }
        try {
            $stmt = $pdo->prepare("INSERT INTO {$quotedTable} (" . implode(', ', $colSql) . ') VALUES (' . implode(', ', $placeSql) . ')');
            $stmt->execute($params);
        } catch (\PDOException $e) {
            throw new RuntimeException('Could not save record: ' . $e->getMessage(), 422, $e);
        }

        $rowId = $pdo->lastInsertId();
        $rowStmt = $pdo->prepare("SELECT * FROM {$quotedTable} WHERE rowid = ?");
        $rowStmt->execute([$rowId]);
        $row = $rowStmt->fetch(\PDO::FETCH_ASSOC);
        return is_array($row) ? $row : $insertData;
    }

    /**
     * Update an existing row in the visitor's live ephemeral sandbox SQLite database.
     *
     * @param array<string, mixed> $catalog
     * @param array<string, mixed> $values
     * @return array<string, mixed>
     */
    public function updateSandboxRecord(array $catalog, string $token, string $table, mixed $id, array $values): array
    {
        $session = $this->verifySession($catalog, $token);
        $pdo = $this->openSandboxSqlite($session['dir']);
        $this->assertValidSandboxTable($pdo, $table);

        $cols = $this->sandboxTableColumns($pdo, $table);
        $colByName = [];
        foreach ($cols as $c) {
            $colByName[$c['name']] = $c;
        }
        $pk = $this->primaryKeyColumn($cols) ?? 'rowid';

        $sets = [];
        $params = [];
        foreach ($values as $k => $v) {
            if (!is_string($k) || !isset($colByName[$k]) || $k === $pk) {
                continue;
            }
            $sets[] = '"' . str_replace('"', '""', $k) . '" = ?';
            if ($v === '' && !$colByName[$k]['notnull']) {
                $params[] = null;
            } else {
                $params[] = is_bool($v) ? ($v ? 1 : 0) : (is_array($v) ? json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : $v);
            }
        }
        if (isset($colByName['updated_at']) && !array_key_exists('updated_at', $values)) {
            $sets[] = '"updated_at" = ?';
            $params[] = gmdate('Y-m-d\TH:i:s\Z');
        }
        if ($sets === []) {
            throw new InvalidArgumentException('No editable fields provided.');
        }

        $quotedTable = '"' . str_replace('"', '""', $table) . '"';
        $quotedPk = '"' . str_replace('"', '""', $pk) . '"';
        $params[] = $id;
        try {
            $stmt = $pdo->prepare("UPDATE {$quotedTable} SET " . implode(', ', $sets) . " WHERE {$quotedPk} = ?");
            $stmt->execute($params);
        } catch (\PDOException $e) {
            throw new RuntimeException('Could not update record: ' . $e->getMessage(), 422, $e);
        }

        $rowStmt = $pdo->prepare("SELECT * FROM {$quotedTable} WHERE {$quotedPk} = ?");
        $rowStmt->execute([$id]);
        $row = $rowStmt->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            throw new RuntimeException('Record not found.', 404);
        }
        return $row;
    }

    /**
     * Delete a row from the visitor's live ephemeral sandbox SQLite database.
     *
     * @param array<string, mixed> $catalog
     * @return array{deleted: bool}
     */
    public function deleteSandboxRecord(array $catalog, string $token, string $table, mixed $id): array
    {
        $session = $this->verifySession($catalog, $token);
        $pdo = $this->openSandboxSqlite($session['dir']);
        $this->assertValidSandboxTable($pdo, $table);

        $cols = $this->sandboxTableColumns($pdo, $table);
        $pk = $this->primaryKeyColumn($cols) ?? 'rowid';
        $quotedTable = '"' . str_replace('"', '""', $table) . '"';
        $quotedPk = '"' . str_replace('"', '""', $pk) . '"';
        try {
            $stmt = $pdo->prepare("DELETE FROM {$quotedTable} WHERE {$quotedPk} = ?");
            $stmt->execute([$id]);
        } catch (\PDOException $e) {
            throw new RuntimeException('Could not delete record (it may be referenced by related rows): ' . $e->getMessage(), 422, $e);
        }
        return ['deleted' => $stmt->rowCount() > 0];
    }

    private function openSandboxSqlite(string $sessionDir): \PDO
    {
        $dbPath = $sessionDir . '/private/data/application.sqlite';
        if (!is_file($dbPath) || is_link($dbPath)) {
            throw new RuntimeException('Sandbox database is not initialized yet. Wait for the app to load and try again.', 404);
        }
        $pdo = new \PDO('sqlite:' . $dbPath, null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;');
        return $pdo;
    }

    /** @return list<string> */
    private function listSandboxTableNames(\PDO $pdo): array
    {
        $rows = $pdo->query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name ASC"
        )->fetchAll(\PDO::FETCH_COLUMN);
        return array_values(array_filter(array_map('strval', $rows)));
    }

    private function assertValidSandboxTable(\PDO $pdo, string $table): void
    {
        if (!in_array($table, $this->listSandboxTableNames($pdo), true)) {
            throw new InvalidArgumentException("Table '{$table}' does not exist in this sandbox database.");
        }
    }

    /** @return list<array{name: string, type: string, notnull: bool, dflt_value: mixed, pk: bool}> */
    private function sandboxTableColumns(\PDO $pdo, string $table): array
    {
        $quoted = '"' . str_replace('"', '""', $table) . '"';
        $raw = $pdo->query("PRAGMA table_info({$quoted})")->fetchAll(\PDO::FETCH_ASSOC);
        $cols = [];
        foreach ($raw as $c) {
            $cols[] = [
                'name' => (string) ($c['name'] ?? ''),
                'type' => (string) ($c['type'] ?? 'TEXT'),
                'notnull' => (int) ($c['notnull'] ?? 0) === 1,
                'dflt_value' => $c['dflt_value'] ?? null,
                'pk' => (int) ($c['pk'] ?? 0) > 0,
            ];
        }
        return $cols;
    }

    /** @param list<array{name: string, type: string, notnull: bool, dflt_value: mixed, pk: bool}> $cols */
    private function primaryKeyColumn(array $cols): ?string
    {
        foreach ($cols as $c) {
            if ($c['pk']) {
                return $c['name'];
            }
        }
        foreach ($cols as $c) {
            if ($c['name'] === 'id') {
                return 'id';
            }
        }
        return null;
    }

    /** @param list<array{name: string, type: string, notnull: bool, dflt_value: mixed, pk: bool}> $cols */
    private function detectStatusColumn(array $cols): ?string
    {
        foreach (['status', 'stage', 'state', 'priority', 'category', 'type'] as $candidate) {
            foreach ($cols as $c) {
                if (strtolower($c['name']) === $candidate) {
                    return $c['name'];
                }
            }
        }
        return null;
    }

    /**
     * Load bundled FormLogic form schemas keyed by bound SQLite table name from `resources/softn-packs/<slug>/install.json`.
     *
     * @return array<string, array<string, mixed>>
     */
    private function loadBundledFormSchemasByTable(string $slug): array
    {
        $catalog = new SoftnPackCatalog();
        $meta = $catalog->getMeta($slug);
        if ($meta === null || !is_string($meta['_installPath'] ?? null) || !is_file((string) $meta['_installPath'])) {
            return [];
        }
        $install = json_decode((string) @file_get_contents((string) $meta['_installPath']), true);
        if (!is_array($install) || !is_array($install['forms'] ?? null)) {
            return [];
        }
        $out = [];
        foreach ($install['forms'] as $form) {
            if (!is_array($form)) continue;
            $ntb = is_array($form['settings']['nativeTableBinding'] ?? null) ? $form['settings']['nativeTableBinding'] : null;
            $tableName = is_string($ntb['table'] ?? null) ? (string) $ntb['table'] : '';
            if ($tableName === '') continue;
            $colMap = is_array($ntb['columns'] ?? null) ? $ntb['columns'] : [];
            $fields = [];
            foreach (is_array($form['fields'] ?? null) ? $form['fields'] : [] as $f) {
                if (!is_array($f)) continue;
                $type = (string) ($f['type'] ?? 'short_text');
                if (in_array($type, ['welcome_screen', 'thank_you', 'statement', 'section', 'section_break'], true)) continue;
                $fid = (string) ($f['id'] ?? '');
                $colName = is_string($colMap[$fid] ?? null) ? (string) $colMap[$fid] : $fid;
                if ($colName === '') continue;
                $opts = [];
                if (is_array($f['properties']['options'] ?? null)) {
                    foreach ($f['properties']['options'] as $opt) {
                        if (is_array($opt) && isset($opt['value'])) {
                            $opts[] = [
                                'label' => (string) ($opt['label'] ?? $opt['value']),
                                'value' => (string) $opt['value'],
                            ];
                        }
                    }
                }
                $fields[] = [
                    'column' => $colName,
                    'label' => (string) ($f['label'] ?? ucwords(str_replace('_', ' ', $colName))),
                    'type' => $type,
                    'required' => (bool) ($f['required'] ?? false),
                    'options' => $opts,
                ];
            }
            $out[$tableName] = [
                'title' => (string) ($form['title'] ?? ''),
                'icon' => is_string($form['icon'] ?? null) ? (string) $form['icon'] : 'Table2',
                'description' => (string) ($form['description'] ?? ''),
                'statusColumn' => is_string($ntb['statusColumn'] ?? null) ? (string) $ntb['statusColumn'] : null,
                'fields' => $fields,
            ];
        }
        return $out;
    }

    /**
     * @param list<array{name: string, type: string, notnull: bool, dflt_value: mixed, pk: bool}> $cols
     * @return list<array<string, mixed>>
     */
    private function deriveFormFieldsFromColumns(array $cols, ?string $pk): array
    {
        $fields = [];
        foreach ($cols as $c) {
            $name = $c['name'];
            if ($name === $pk || in_array(strtolower($name), ['created_at', 'updated_at', 'is_sample'], true)) {
                continue;
            }
            $upper = strtoupper($c['type']);
            $type = 'short_text';
            if (str_contains($upper, 'INT') || str_contains($upper, 'REAL') || str_contains($upper, 'NUM')) {
                $type = 'number';
            } elseif (str_contains(strtolower($name), 'notes') || str_contains(strtolower($name), 'description')) {
                $type = 'long_text';
            } elseif (str_contains(strtolower($name), 'email')) {
                $type = 'email';
            } elseif (str_ends_with(strtolower($name), '_date') || strtolower($name) === 'date') {
                $type = 'date';
            }
            $fields[] = [
                'column' => $name,
                'label' => ucwords(str_replace('_', ' ', $name)),
                'type' => $type,
                'required' => $c['notnull'] && $c['dflt_value'] === null,
                'options' => [],
            ];
        }
        return $fields;
    }

    /**
     * Populate dropdown options from referenced parent tables for any SQLite foreign-key columns,
     * so visitors editing related tables in Management get human-readable pickers instead of raw IDs.
     *
     * @param list<array<string, mixed>> $fields
     * @return list<array<string, mixed>>
     */
    private function enrichFieldsWithForeignKeys(\PDO $pdo, string $tableName, array $fields): array
    {
        $quoted = '"' . str_replace('"', '""', $tableName) . '"';
        $fkRows = $pdo->query("PRAGMA foreign_key_list({$quoted})")->fetchAll(\PDO::FETCH_ASSOC);
        if (!is_array($fkRows) || $fkRows === []) {
            return $fields;
        }
        $fkByCol = [];
        foreach ($fkRows as $fk) {
            if (!is_array($fk)) continue;
            $from = (string) ($fk['from'] ?? '');
            $refTable = (string) ($fk['table'] ?? '');
            $refTo = (string) ($fk['to'] ?? 'id');
            if ($from !== '' && $refTable !== '') {
                $fkByCol[$from] = ['table' => $refTable, 'to' => $refTo !== '' ? $refTo : 'id'];
            }
        }
        if ($fkByCol === []) {
            return $fields;
        }

        foreach ($fields as $idx => $field) {
            $col = (string) ($field['column'] ?? '');
            if (!isset($fkByCol[$col])) {
                continue;
            }
            $refTable = $fkByCol[$col]['table'];
            $refTo = $fkByCol[$col]['to'];
            try {
                $refQuoted = '"' . str_replace('"', '""', $refTable) . '"';
                $refRows = $pdo->query("SELECT * FROM {$refQuoted} ORDER BY rowid ASC LIMIT 100")->fetchAll(\PDO::FETCH_ASSOC);
                if (!is_array($refRows) || $refRows === []) {
                    continue;
                }
                $opts = [];
                foreach ($refRows as $r) {
                    if (!is_array($r) || !array_key_exists($refTo, $r)) continue;
                    $val = (string) $r[$refTo];
                    $label = '';
                    foreach (['name', 'title', 'full_name', 'customer_name', 'business_name', 'code', 'sku', 'label', 'email', 'subject'] as $lk) {
                        if (isset($r[$lk]) && is_scalar($r[$lk]) && trim((string) $r[$lk]) !== '') {
                            $label = trim((string) $r[$lk]);
                            break;
                        }
                    }
                    $opts[] = [
                        'value' => $val,
                        'label' => $label !== '' ? "{$label} (#{$val})" : "#{$val}",
                    ];
                }
                if ($opts !== []) {
                    $fields[$idx]['type'] = 'dropdown';
                    $fields[$idx]['options'] = $opts;
                }
            } catch (\Throwable) {
                // Keep original field type if referenced table cannot be queried
            }
        }
        return $fields;
    }

    private function ensureDir(string $path): void
    {
        if (is_dir($path)) {
            return;
        }
        if (!@mkdir($path, 0700, true) && !is_dir($path)) {
            throw new RuntimeException('Could not initialize sandbox storage.');
        }
    }

    /** Lazily remove expired visitor sandbox directories. */
    private function sweepExpired(): void
    {
        if (!is_dir($this->sandboxRoot)) {
            return;
        }
        $now = time();
        $removed = 0;
        foreach (glob($this->sandboxRoot . '/sbx*', GLOB_ONLYDIR) ?: [] as $dir) {
            if ($removed >= self::MAX_SWEEP_PER_CALL) {
                break;
            }
            $metaFile = $dir . '/meta.json';
            $expired = false;
            if (is_file($metaFile)) {
                $meta = json_decode((string) @file_get_contents($metaFile), true);
                $exp = is_array($meta) ? (int) ($meta['expiresAt'] ?? 0) : 0;
                $expired = $exp > 0 && $exp < $now - 60;
            } else {
                $expired = (int) @filemtime($dir) < $now - self::SESSION_TTL_SECONDS;
            }
            if ($expired) {
                $this->removeDirRecursive($dir);
                $removed++;
            }
        }
    }

    private function removeDirRecursive(string $dir): void
    {
        $resolved = realpath($dir);
        $base = realpath($this->sandboxRoot);
        if (!$resolved || !$base || dirname($resolved) !== $base || !str_starts_with(basename($resolved), 'sbx')) {
            return;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($resolved, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $entry) {
            if ($entry->isLink() || !$entry->isDir()) {
                @unlink($entry->getPathname());
            } else {
                @rmdir($entry->getPathname());
            }
        }
        @rmdir($resolved);
    }
}
