<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppService;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\SigningService;
use FormLogic\Helpers\AppUrl;
use FormLogic\Helpers\PackCapabilities;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Signed client app manifest (spec §24/§25) + the public verification key.
 *
 * The native runtime must not trust arbitrary remote JSON, so the client manifest is
 * SIGNED. It carries display/install/offline/native/sdk/logic metadata derived from the
 * app — but NEVER private form schemas or field names. Native capabilities are inferred
 * from the app's customLogic connector permissions.
 */
class AppManifestController
{
    use JsonResponseTrait;

    private AppService $appService;
    private SigningService $signing;
    private AppDomainService $domains;

    public function __construct(AppService $appService, SigningService $signing, AppDomainService $domains)
    {
        $this->appService = $appService;
        $this->signing = $signing;
        $this->domains = $domains;
    }

    private function validateSlug(string $slug): bool
    {
        return (bool) preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug);
    }

    /**
     * Native/package trust requires a publicly-verifiable signature. If Ed25519 (libsodium) is
     * unavailable, an HS256 manifest can't be verified by the native runtime or third parties, so —
     * unless the operator opts out — refuse rather than emit a manifest that looks signed but isn't.
     * Returns a 503 Response when signing can't be trusted, or null when it's OK to proceed.
     */
    private function signingUnavailable(Response $response): ?Response
    {
        if (!$this->signing->isEd25519() && ($_ENV['NATIVE_TRUST_REQUIRES_ED25519'] ?? '1') !== '0') {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'signing_unsupported',
                'message' => 'This server cannot produce publicly-verifiable manifests (libsodium/Ed25519 unavailable). Install ext-sodium, or set NATIVE_TRUST_REQUIRES_ED25519=0 for local-only use.',
            ], 503);
        }
        return null;
    }

    /** Slug-based signed client manifest (public metadata only). */
    public function clientManifest(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $app = $this->appService->getAppBySlug($slug);
        if (!$app || ($app['status'] ?? '') !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        if ($guard = $this->signingUnavailable($response)) {
            return $guard;
        }

        return $this->jsonResponse($response, $this->signing->sign($this->buildManifest($app, $request)));
    }

    /**
     * Same signed client manifest, discovered at a custom domain's root: GET /.well-known/formlogic-app.json.
     * The request Host (or ?host=) is resolved to a connected+active domain of a PUBLISHED app; the app row
     * is then re-fetched by slug so the emitted manifest is byte-identical to the slug route. 404 when the
     * host isn't a connected custom domain. The Host is trusted only because it's gated to an app_domains row.
     */
    public function clientManifestByHost(Request $request, Response $response): Response
    {
        $host = trim((string) ($request->getQueryParams()['host'] ?? ''));
        if ($host === '') {
            $host = $request->getHeaderLine('Host');
        }
        $resolved = $host !== '' ? $this->domains->resolveAppSlugByHost($host) : null;
        if (!$resolved) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not found'], 404);
        }
        $app = $this->appService->getAppBySlug($resolved['slug']);
        if (!$app || ($app['status'] ?? '') !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not found'], 404);
        }

        if ($guard = $this->signingUnavailable($response)) {
            return $guard;
        }

        return $this->jsonResponse($response, $this->signing->sign($this->buildManifest($app, $request)));
    }

    /**
     * Build the (unsigned) client-app manifest for $app. Public metadata only — display / install /
     * offline / native / sdk / logic — NEVER form schemas or field names. Native capabilities are
     * derived from the app's + its forms' customLogic connector permissions. Links resolve to the
     * server-trusted frontend base (AppUrl::frontendBase deliberately ignores the request Host).
     *
     * @param array<string,mixed> $app  a getAppBySlug() row (decoded settings/theme/customLogic)
     * @return array<string,mixed>
     */
    private function buildManifest(array $app, Request $request): array
    {
        $slug = (string) ($app['slug'] ?? '');
        $base = null;
        try {
            $base = rtrim(AppUrl::frontendBase($request), '/');
        } catch (\Throwable $e) {
            $base = '';
        }
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $theme = is_array($app['theme'] ?? null) ? $app['theme'] : [];
        $customLogic = is_array($app['customLogic'] ?? null) ? $app['customLogic'] : [];
        // Aggregate connector capabilities from BOTH the app-level bundle and every form's customLogic
        // (bundle-level AND per-script permissions). PackCapabilities already merges + dedupes exactly
        // this permission vocabulary, so the native manifest matches what the runtime enforces — an app
        // that scopes a connector grant to a single form no longer gets an empty native.capabilities.
        $formLogics = $this->appService->getAppFormsWithLogic($app['id']);
        $mergedPerms = PackCapabilities::describe([
            'apps' => [['customLogic' => $customLogic]],
            'forms' => array_map(static fn ($cl) => ['customLogic' => $cl], $formLogics),
        ])['permissions'];
        $native = $this->nativeSection($mergedPerms);

        return [
            'version' => 1,
            'kind' => 'formlogic.clientApp',
            'appSlug' => $slug,
            'display' => [
                'name' => $app['name'],
                'shortName' => $settings['pwaShortName'] ?? mb_substr((string) $app['name'], 0, 12),
                'description' => $app['description'] ?? '',
                'logoUrl' => $app['logoUrl'] ?? null,
                'themeColor' => $settings['pwaThemeColor'] ?? $theme['primaryColor'] ?? '#6366f1',
            ],
            'source' => [
                'kind' => 'formlogic-runtime',
                'url' => $base . '/app/' . $slug,
            ],
            'install' => [
                'pwa' => [
                    'enabled' => (bool) ($settings['enablePwa'] ?? true),
                    'manifestUrl' => $base . '/api/app/' . $slug . '/manifest.json',
                ],
                'android' => [
                    // The generic FormLogic Native Runtime opens any app; App Links verification uses
                    // /.well-known/assetlinks.json served at the domain root.
                    'enabled' => true,
                    'packageName' => 'com.formlogic.runtime',
                    'minVersion' => '0.1.0',
                    'assetLinks' => $base . '/.well-known/assetlinks.json',
                    'openUrl' => $base . '/app/' . $slug,
                ],
            ],
            'offline' => [
                'enabled' => true,
                'queueSubmissions' => true,
                'syncOnReconnect' => true,
                'conflictStrategy' => 'server-wins',
            ],
            'native' => $native,
            'sdk' => ['enabled' => true, 'version' => 1],
            'logic' => [
                'runtime' => 'quickjs',
                'strictPermissions' => (bool) ($customLogic['strictPermissions'] ?? false),
                'permissions' => $mergedPerms,
            ],
        ];
    }

    /** Native capability section derived from a flat list of connector.* permission strings (spec §50). */
    private function nativeSection(array $perms): array
    {
        $perms = array_values(array_filter($perms, 'is_string'));
        $byConnector = [];
        foreach ($perms as $p) {
            // connector.<id>.<command...>
            if (strncmp($p, 'connector.', 10) === 0) {
                $rest = substr($p, 10);
                $dot = strpos($rest, '.');
                if ($dot !== false) {
                    $id = substr($rest, 0, $dot);
                    $command = substr($rest, $dot + 1);
                    $byConnector[$id][] = $command;
                }
            }
        }
        $capabilities = [];
        foreach ($byConnector as $id => $commands) {
            $capabilities[] = [
                'connector' => $id,
                'commands' => array_values(array_unique($commands)),
                'required' => false,
                'reason' => 'Used by this app\'s logic to read ' . $id . ' data.',
            ];
        }
        return [
            'enabled' => !empty($capabilities),
            'packageName' => 'com.formlogic.runtime',
            'minVersion' => '0.1.0',
            'capabilities' => $capabilities,
        ];
    }

    /** Public verification key so the native runtime / third parties can check signatures. */
    public function signingKey(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, $this->signing->publicKeyInfo());
    }
}
