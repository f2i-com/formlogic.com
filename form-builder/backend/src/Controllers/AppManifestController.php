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

        // Bind the manifest to the platform origin that serves it (the frontend-base host) so the native
        // runtime can enforce signed-domain == serving-origin. Without this, a validly-signed but
        // domain-less slug manifest could be replayed onto an attacker origin to grant native caps there.
        return $this->jsonResponse(
            $response,
            $this->signing->sign($this->buildManifest($app, $request, null, $this->platformHost($request)))
        );
    }

    /**
     * Same signed client manifest, discovered at a custom domain's root: GET /.well-known/formlogic-app.json.
     * The request Host (or ?host=) is resolved to a connected+active domain of a PUBLISHED app; the app row
     * is then re-fetched by slug. 404 when the host isn't a connected custom domain.
     *
     * Unlike the slug route, this manifest is emitted SAME-ORIGIN: source.url / install.pwa.manifestUrl /
     * install.android.assetLinks / install.android.openUrl point at the CUSTOM domain (request scheme +
     * this pre-verified active Host) and a top-level `domain` field names it. The Host is trusted to form
     * the base ONLY because it is gated to an active app_domains row above — it is NEVER fed into
     * AppUrl::frontendBase (that must stay platform-controlled to avoid Host-header link spoofing).
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

        // The matched normalized domain is the trusted, canonical custom-domain host.
        $domain = $this->domains->normalizeDomain($host);
        $base = $this->customDomainBase($request, $domain);
        // White-label native install identity (hardening #7): the matched domain's native_config flows
        // into the SIGNED manifest. Re-sanitized here (defense in depth) so a legacy/unsanitized row
        // can't smuggle an invalid package name or a non-http install URL into a signed payload.
        $nativeConfig = $this->domains->sanitizeNativeConfig(
            is_array($resolved['nativeConfig'] ?? null) ? $resolved['nativeConfig'] : []
        );
        return $this->jsonResponse(
            $response,
            $this->signing->sign($this->buildManifest($app, $request, $base, $domain, $nativeConfig))
        );
    }

    /**
     * Same-origin base URL (scheme://host) for a VERIFIED custom domain. The scheme is resolved via
     * requestScheme() (X-Forwarded-Proto first, so a TLS-terminating proxy that forwards http still
     * yields https links; default https, since a live custom domain is served over TLS). The host is the
     * already-normalized, pre-verified active domain — safe to trust here because the caller gated it
     * through resolveAppSlugByHost. Never derives a platform origin, so it can't leak into emailed links.
     */
    private function customDomainBase(Request $request, string $normalizedDomain): string
    {
        return $this->requestScheme($request) . '://' . $normalizedDomain;
    }

    /**
     * Resolve the effective request scheme, UPGRADE-ONLY. X-Forwarded-Proto is honored only to CONFIRM
     * https (a TLS-terminating proxy that forwards http on the wire); a spoofed "X-Forwarded-Proto: http"
     * can NOT downgrade a signed custom-domain manifest's links to cleartext. In PRODUCTION the answer
     * is ALWAYS https — a live custom domain is served over TLS, and a TLS-terminating proxy that does
     * not set X-Forwarded-Proto would otherwise make the backend see plain http and emit cleartext links
     * in a SIGNED manifest (hardening #4). Only in development does the real connection scheme flow
     * through (so http://formlogic.local keeps working). Only ever returns 'http' or 'https'.
     */
    private function requestScheme(Request $request): string
    {
        $proto = strtolower(trim(explode(',', $request->getHeaderLine('X-Forwarded-Proto'))[0]));
        if ($proto === 'https') {
            return 'https';
        }
        if ($this->isProduction()) {
            return 'https';
        }
        return strtolower($request->getUri()->getScheme()) === 'http' ? 'http' : 'https';
    }

    /**
     * Mirrors config/settings.php (and AppDomainController's env read): safe-by-default — anything
     * other than an explicit APP_ENV=development is treated as production, so a missing/typo'd
     * APP_ENV never emits cleartext manifest links.
     */
    private function isProduction(): bool
    {
        return ($_ENV['APP_ENV'] ?? (getenv('APP_ENV') ?: 'production')) !== 'development';
    }

    /**
     * The normalized host of the platform frontend base — binds the slug manifest's `domain` to the
     * platform origin that serves it, so the native runtime can reject a replay onto another origin.
     * Empty string on failure (the runtime then refuses the domain-less manifest — fail-closed).
     */
    private function platformHost(Request $request): string
    {
        try {
            $host = (string) parse_url(AppUrl::frontendBase($request), PHP_URL_HOST);
            return $host !== '' ? $this->domains->normalizeDomain($host) : '';
        } catch (\Throwable $e) {
            return '';
        }
    }

    /**
     * Build the (unsigned) client-app manifest for $app. Public metadata only — display / install /
     * offline / native / sdk / logic — NEVER form schemas or field names. Native capabilities are
     * derived from the app's + its forms' customLogic connector permissions.
     *
     * Link base: by default the server-trusted frontend base (AppUrl::frontendBase, which deliberately
     * ignores the request Host). Pass $baseOverride to emit SAME-ORIGIN links for a pre-verified custom
     * domain — the caller MUST have already gated the host to an active app_domains row (see
     * clientManifestByHost); this method never validates the base itself. When $customDomain is set it is
     * echoed as a top-level `domain` field so the runtime knows which custom origin served the manifest.
     *
     * White-label (hardening #7): $nativeConfig — the custom domain's SANITIZED native_config — may
     * override the generic install.android identity (packageName / minVersion) and add an installUrl.
     * Only those three keys are ever read from it: sha256CertFingerprints (served via
     * /.well-known/assetlinks.json, never the manifest) and securityConfig are NEVER emitted here.
     * The platform slug route passes null and keeps the generic com.formlogic.runtime defaults.
     *
     * @param array<string,mixed>      $app          a getAppBySlug() row (decoded settings/theme/customLogic)
     * @param string|null              $baseOverride  same-origin base (scheme://host) for a verified custom domain
     * @param string|null              $customDomain  the custom domain to name in the payload
     * @param array<string,mixed>|null $nativeConfig  sanitized per-domain white-label native config
     * @return array<string,mixed>
     */
    private function buildManifest(array $app, Request $request, ?string $baseOverride = null, ?string $customDomain = null, ?array $nativeConfig = null): array
    {
        $slug = (string) ($app['slug'] ?? '');
        // A base override is only ever passed for a pre-verified custom domain (clientManifestByHost);
        // the platform slug route passes null. That presence is the signal for the same-origin forms.
        $isCustomDomain = $baseOverride !== null;
        if ($isCustomDomain) {
            $base = rtrim($baseOverride, '/');
        } else {
            $base = null;
            try {
                $base = rtrim(AppUrl::frontendBase($request), '/');
            } catch (\Throwable $e) {
                $base = '';
            }
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

        // White-label install identity: prefer the (sanitized) per-domain native_config when its values
        // are present and valid; otherwise the generic FormLogic Native Runtime identity. Validated
        // AGAIN here (belt and braces) so even a caller that skipped sanitizeNativeConfig cannot put a
        // malformed package name or a javascript:/market: install URL into a SIGNED manifest.
        $androidPackage = 'com.formlogic.runtime';
        $androidMinVersion = '0.1.0';
        $androidInstallUrl = null;
        if (is_array($nativeConfig)) {
            $pkg = $nativeConfig['packageName'] ?? null;
            if (is_string($pkg) && preg_match('/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/', $pkg)) {
                $androidPackage = $pkg;
            }
            $ver = $nativeConfig['minRuntimeVersion'] ?? null;
            if (is_string($ver) && trim($ver) !== '' && strlen($ver) <= 32) {
                $androidMinVersion = trim($ver);
            }
            $url = $nativeConfig['installUrl'] ?? null;
            // HTTPS ONLY: this link downloads an installable binary and ships inside an Ed25519-SIGNED
            // manifest — a cleartext http URL would let an on-path attacker swap the APK while the
            // signature lends the install block unearned trust. No dev carve-out for executable downloads.
            if (is_string($url) && strtolower((string) parse_url($url, PHP_URL_SCHEME)) === 'https'
                && filter_var($url, FILTER_VALIDATE_URL) !== false) {
                $androidInstallUrl = $url;
            }
        }

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
                    // Custom-domain manifests point at the dedicated same-origin root PWA manifest
                    // ({customBase}/manifest.json, served by AppPublicController::manifestByHost), so the
                    // installing document stays in scope. The platform slug route keeps the API-origin
                    // per-slug manifest, which AppUrl::frontendBase already resolves to the app origin.
                    'manifestUrl' => $isCustomDomain
                        ? ($base . '/manifest.json')
                        : ($base . '/api/app/' . $slug . '/manifest.json'),
                ],
                'android' => array_merge(
                    [
                        // The generic FormLogic Native Runtime opens any app (a custom domain's sanitized
                        // native_config may white-label this identity — see above); App Links verification
                        // uses /.well-known/assetlinks.json served at the domain root.
                        'enabled' => true,
                        'packageName' => $androidPackage,
                        'minVersion' => $androidMinVersion,
                        'assetLinks' => $base . '/.well-known/assetlinks.json',
                        'openUrl' => $base . '/app/' . $slug,
                    ],
                    $androidInstallUrl !== null ? ['installUrl' => $androidInstallUrl] : []
                ),
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

        // Custom-domain manifests name the origin that served them so the native runtime can pin it.
        if ($customDomain !== null && $customDomain !== '') {
            $manifest['domain'] = $customDomain;
        }

        return $manifest;
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
