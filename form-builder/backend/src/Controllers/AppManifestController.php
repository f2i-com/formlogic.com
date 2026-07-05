<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppService;
use FormLogic\Services\SigningService;
use FormLogic\Helpers\AppUrl;
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

    public function __construct(AppService $appService, SigningService $signing)
    {
        $this->appService = $appService;
        $this->signing = $signing;
    }

    private function validateSlug(string $slug): bool
    {
        return (bool) preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug);
    }

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

        $base = null;
        try {
            $base = rtrim(AppUrl::frontendBase($request), '/');
        } catch (\Throwable $e) {
            $base = '';
        }
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $theme = is_array($app['theme'] ?? null) ? $app['theme'] : [];
        $customLogic = is_array($app['customLogic'] ?? null) ? $app['customLogic'] : [];
        $native = $this->nativeSection($customLogic);

        $manifest = [
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
                'permissions' => array_values(array_filter(($customLogic['permissions'] ?? []), 'is_string')),
            ],
        ];

        return $this->jsonResponse($response, $this->signing->sign($manifest));
    }

    /** Native capability section derived from customLogic connector.* permissions (spec §50). */
    private function nativeSection(array $customLogic): array
    {
        $perms = array_filter(($customLogic['permissions'] ?? []), 'is_string');
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
