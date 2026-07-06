<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\IpSafety;
use PDO;

/**
 * Custom domains — bind an app to the owner's own domain (e.g. mine.management) and
 * resolve an incoming host to a branded, public-safe launch config.
 *
 * Security posture (spec §15/§59):
 *  - normalize + validate every domain; reject localhost / private / internal / raw IPs.
 *  - one domain → one app (normalized_domain is UNIQUE) so a domain can't be double-claimed.
 *  - ownership is enforced on every admin call (owner_id scoping).
 *  - the public launch config returns DISPLAY/INSTALL metadata only — never form schemas,
 *    field names, report specs, scripts, or hidden data.
 */
class AppDomainService
{
    private PDO $mysql;

    /** Domain launch modes. MVP renders launch_page / runtime_direct; the rest are accepted for later. */
    public const MODES = ['launch_page', 'runtime_direct', 'website_plus_app', 'native_required', 'redirect'];

    // Reserved / non-public suffixes that must never be claimable as a public launch domain.
    private const RESERVED_SUFFIXES = ['.local', '.localhost', '.internal', '.test', '.example', '.invalid', '.localdomain'];
    private const RESERVED_HOSTS = ['localhost', '0.0.0.0', 'broadcasthost'];

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    // ---- normalization / validation -------------------------------------------------

    /** Lowercase, strip scheme/port/path/trailing dot; punycode via intl when available. */
    public function normalizeDomain(string $host): string
    {
        $host = trim($host);
        // Strip a scheme and any path/query if a full URL slipped in.
        if (preg_match('#^[a-z][a-z0-9+.-]*://#i', $host)) {
            $host = (string) parse_url($host, PHP_URL_HOST);
        } else {
            $host = explode('/', $host)[0];
        }
        $host = strtolower(trim($host));
        $host = explode(':', $host)[0];        // drop :port
        $host = rtrim($host, '.');             // drop trailing dot
        if ($host !== '' && function_exists('idn_to_ascii')) {
            $ascii = idn_to_ascii($host, IDNA_DEFAULT, INTL_IDNA_VARIANT_UTS46);
            if (is_string($ascii) && $ascii !== '') {
                $host = $ascii;
            }
        }
        return $host;
    }

    /** Syntactic validity: a real multi-label hostname, each label 1–63 chars, total ≤ 253. */
    public function isValidDomain(string $domain): bool
    {
        if ($domain === '' || strlen($domain) > 253) {
            return false;
        }
        if (strpos($domain, '.') === false) {
            return false; // must be a FQDN (at least one dot)
        }
        return (bool) preg_match(
            '/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/',
            $domain
        );
    }

    /** Reject localhost / private / internal / reserved-suffix / raw-IP domains (spec §15). */
    public function isPublicDomain(string $domain): bool
    {
        if (in_array($domain, self::RESERVED_HOSTS, true)) {
            return false;
        }
        foreach (self::RESERVED_SUFFIXES as $suffix) {
            if (str_ends_with($domain, $suffix)) {
                return false;
            }
        }
        // A raw IP is never a valid launch domain.
        if (filter_var($domain, FILTER_VALIDATE_IP) !== false) {
            return false;
        }
        return true;
    }

    /**
     * Full validation gate; throws \InvalidArgumentException with a user-facing message.
     * Returns the normalized domain.
     */
    public function assertValidPublicDomain(string $host): string
    {
        $domain = $this->normalizeDomain($host);
        if (!$this->isValidDomain($domain)) {
            throw new \InvalidArgumentException('Enter a valid domain, e.g. app.yourcompany.com');
        }
        if (!$this->isPublicDomain($domain)) {
            throw new \InvalidArgumentException('That domain is not allowed (localhost, private, or reserved).');
        }
        return $domain;
    }

    public function generateVerificationToken(): string
    {
        return 'fl-domain-verification=' . bin2hex(random_bytes(16));
    }

    // ---- CRUD (owner-scoped) --------------------------------------------------------

    /** @return array<int,array<string,mixed>> */
    public function getDomainsForApp(string $appId, string $ownerId): array
    {
        $stmt = $this->mysql->prepare(
            "SELECT * FROM app_domains WHERE app_id = :app AND owner_id = :owner ORDER BY created_at ASC"
        );
        $stmt->execute(['app' => $appId, 'owner' => $ownerId]);
        return array_map([$this, 'toAdminArray'], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** @return array<string,mixed>|null */
    public function getDomain(string $domainId, string $ownerId): ?array
    {
        $row = $this->fetchOwned($domainId, $ownerId);
        return $row ? $this->toAdminArray($row) : null;
    }

    /** @return array<string,mixed> the created domain (admin shape). */
    public function createDomain(string $appId, string $ownerId, string $host, string $mode = 'launch_page'): array
    {
        $domain = $this->assertValidPublicDomain($host);
        if (!in_array($mode, self::MODES, true)) {
            $mode = 'launch_page';
        }

        $exists = $this->mysql->prepare("SELECT owner_id FROM app_domains WHERE normalized_domain = :d LIMIT 1");
        $exists->execute(['d' => $domain]);
        if ($exists->fetchColumn() !== false) {
            throw new \InvalidArgumentException('That domain is already connected to an app.');
        }

        $id = $this->uuid();
        $token = $this->generateVerificationToken();
        $stmt = $this->mysql->prepare(
            "INSERT INTO app_domains (id, app_id, owner_id, domain, normalized_domain, mode, status, verification_method, verification_token)
             VALUES (:id, :app, :owner, :domain, :norm, :mode, 'pending', 'dns_txt', :token)"
        );
        $stmt->execute([
            'id' => $id, 'app' => $appId, 'owner' => $ownerId,
            'domain' => $domain, 'norm' => $domain, 'mode' => $mode, 'token' => $token,
        ]);

        return $this->getDomain($id, $ownerId);
    }

    /** @param array<string,mixed> $data */
    public function updateDomain(string $domainId, string $ownerId, array $data): ?array
    {
        $row = $this->fetchOwned($domainId, $ownerId);
        if (!$row) {
            return null;
        }
        $updates = [];
        $params = ['id' => $domainId];
        if (isset($data['mode'])) {
            if (!in_array($data['mode'], self::MODES, true)) {
                throw new \InvalidArgumentException('Invalid launch mode.');
            }
            $updates[] = 'mode = :mode';
            $params['mode'] = $data['mode'];
        }
        if (array_key_exists('landingConfig', $data)) {
            // Sanitize on write: cap text lengths, require http(s)/data:image logos + http(s)/email-ish
            // links (rejecting javascript: & other schemes), normalize booleans. Invalid values are dropped.
            $clean = is_array($data['landingConfig'] ?? null) ? $this->sanitizeLandingConfig($data['landingConfig']) : [];
            $updates[] = 'landing_config = :landing';
            $params['landing'] = !empty($clean) ? json_encode($clean) : null;
        }
        // Additional per-domain config (native app / PWA / security). security_config is stored + returned
        // ONLY through this owner-scoped admin path — resolveLaunchConfig (public) never surfaces it.
        foreach (['nativeConfig' => 'native_config', 'pwaConfig' => 'pwa_config', 'securityConfig' => 'security_config'] as $key => $col) {
            if (array_key_exists($key, $data)) {
                // Native config is validated field-by-field (package pattern / hex fingerprints / http(s)
                // install URL / capped version). pwa/security are opaque admin blobs — stored as-is.
                if ($key === 'nativeConfig') {
                    $clean = is_array($data[$key] ?? null) ? $this->sanitizeNativeConfig($data[$key]) : [];
                    $value = !empty($clean) ? json_encode($clean) : null;
                } else {
                    $value = !empty($data[$key]) ? json_encode($data[$key]) : null;
                }
                $updates[] = "$col = :$col";
                $params[$col] = $value;
            }
        }
        if (!empty($updates)) {
            $sql = 'UPDATE app_domains SET ' . implode(', ', $updates) . ' WHERE id = :id';
            $this->mysql->prepare($sql)->execute($params);
        }
        return $this->getDomain($domainId, $ownerId);
    }

    public function deleteDomain(string $domainId, string $ownerId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM app_domains WHERE id = :id AND owner_id = :owner");
        $stmt->execute(['id' => $domainId, 'owner' => $ownerId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Whether the STRICT activation policy is in force (env APP_DOMAIN_REQUIRE_TLS_ACTIVE=1). When strict,
     * a domain only reaches status='active' once a live HTTPS handshake succeeds; ownership-verified-but-
     * TLS-pending domains sit at status='verified' (and stay unreachable). Default (0/unset) = flexible:
     * ownership alone activates and tls_status is surfaced separately. VARCHAR status column, so 'verified'
     * needs no schema change.
     */
    public function requireTlsActive(): bool
    {
        // Normalize the env string (mirrors AIService's env-bool convention) so common truthy spellings
        // enable the gate — a strict in_array against int/bool entries would silently fail-open on TRUE/yes/on.
        $v = strtolower(trim((string) ($_ENV['APP_DOMAIN_REQUIRE_TLS_ACTIVE'] ?? getenv('APP_DOMAIN_REQUIRE_TLS_ACTIVE') ?: '')));
        return in_array($v, ['1', 'true', 'yes', 'on'], true);
    }

    /**
     * Verify domain ownership. In production this does a real DNS TXT lookup for the
     * per-domain token at _formlogic.<domain>. When $allowDevOverride is true (non-prod),
     * it treats ownership as proven without DNS so the flow is testable locally.
     *
     * Activation policy (see requireTlsActive):
     *  - flexible (default): ownership proven → status='active' immediately; tls_status is measured and
     *    surfaced but does not block activation.
     *  - strict (APP_DOMAIN_REQUIRE_TLS_ACTIVE=1): ownership proven → status='active' ONLY when probeTls
     *    returns 'active'; otherwise status='verified' (ownership proven, awaiting live HTTPS). The public
     *    resolvers require status='active', so a strict domain stays private until TLS is genuinely up.
     *
     * @return array{ok:bool,status:string,message:string,domain:array<string,mixed>|null}
     */
    public function verifyDomain(string $domainId, string $ownerId, bool $allowDevOverride = false): array
    {
        $row = $this->fetchOwned($domainId, $ownerId);
        if (!$row) {
            return ['ok' => false, 'status' => 'not_found', 'message' => 'Domain not found.', 'domain' => null];
        }

        $domain = $row['normalized_domain'];
        $token = $row['verification_token'];
        $verified = false;
        $error = null;

        if ($allowDevOverride) {
            $verified = true;
        } elseif (($row['status'] ?? '') === 'verified' && !empty($row['verified_at'])) {
            // Ownership was already proven (a strict 'verified' hold). A re-check only needs to re-probe
            // TLS to promote to 'active' — do NOT re-run the DNS TXT lookup, or a transient/removed record
            // would demote an already-owned domain back to 'failed' and knock the live HTTPS domain offline.
            $verified = true;
        } else {
            $verified = $this->dnsTxtContains('_formlogic.' . $domain, $token, $error);
        }

        if ($verified) {
            // Ownership is proven (DNS TXT). Separately MEASURE TLS instead of assuming it — the old
            // code hard-coded tls_status='active'. Dev-override (local, no real DNS/routing) is marked
            // 'external' since there is nothing real to probe. The probe is SSRF-guarded: it will not
            // connect to a host that resolves to a private/reserved IP.
            $tls = $allowDevOverride ? 'external' : $this->probeTls($domain);
            $strict = $this->requireTlsActive();
            // Strict gate: hold at 'verified' until HTTPS is genuinely live. Flexible: activate on ownership.
            // Dev-override also satisfies the gate (tls stays 'external' — truthful) so the strict activation
            // path is testable locally; in production strict still requires a real 'active' TLS probe.
            $status = ($allowDevOverride || !$strict || $tls === 'active') ? 'active' : 'verified';

            $this->mysql->prepare(
                "UPDATE app_domains SET status = :status, verified_at = NOW(), tls_status = :tls, last_checked_at = NOW(), last_error = NULL WHERE id = :id"
            )->execute(['id' => $domainId, 'status' => $status, 'tls' => $tls]);

            if ($status === 'active') {
                $message = $tls === 'active'
                    ? 'Domain verified — HTTPS is live.'
                    : 'Ownership verified. HTTPS not confirmed yet (DNS routing / certificate may still be provisioning).';
            } else {
                $message = 'Ownership verified. This domain activates once HTTPS is live — DNS routing or the '
                    . 'TLS certificate may still be provisioning. Re-check shortly.';
            }
            // ok reflects reachability: true only when the domain is now live (status='active').
            return ['ok' => $status === 'active', 'status' => $status, 'message' => $message, 'domain' => $this->getDomain($domainId, $ownerId)];
        }

        $this->mysql->prepare(
            "UPDATE app_domains SET status = 'failed', last_checked_at = NOW(), last_error = :err WHERE id = :id"
        )->execute(['id' => $domainId, 'err' => $error ?? 'TXT record not found']);
        return [
            'ok' => false,
            'status' => 'failed',
            'message' => 'We could not find the verification TXT record yet. DNS can take a while to propagate.',
            'domain' => $this->getDomain($domainId, $ownerId),
        ];
    }

    // ---- public launch resolution ---------------------------------------------------

    /**
     * Resolve an incoming host to a PUBLIC-SAFE launch config, or null if the host isn't a
     * connected+active domain of a PUBLISHED app. Never leaks private app structure.
     *
     * @return array<string,mixed>|null
     */
    public function resolveLaunchConfig(string $host): ?array
    {
        $domain = $this->normalizeDomain($host);
        if ($domain === '') {
            return null;
        }
        $stmt = $this->mysql->prepare(
            "SELECT d.*, a.slug AS app_slug, a.name AS app_name, a.description AS app_description,
                    a.logo_url AS app_logo, a.theme AS app_theme, a.status AS app_status, a.settings AS app_settings
             FROM app_domains d JOIN apps a ON a.id = d.app_id
             WHERE d.normalized_domain = :d AND d.status = 'active' LIMIT 1"
        );
        $stmt->execute(['d' => $domain]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || ($row['app_status'] ?? '') !== 'published') {
            return null;
        }

        $theme = $this->decodeJson($row['app_theme']);
        $settings = $this->decodeJson($row['app_settings']);
        // Re-sanitize on READ (defense in depth): a legacy row written before updateDomain's sanitizer (or
        // by any other writer) must not leak a javascript:/non-http(s) privacyUrl/termsUrl/logoUrl to the
        // public launch page — AppLaunchPage renders these straight into href/src. Mirrors publicNativeSection.
        $landing = $this->sanitizeLandingConfig($this->decodeJson($row['landing_config']));

        // Defaults + owner-authored landing overrides (display metadata only).
        $config = [
            'headline' => $landing['headline'] ?? $row['app_name'],
            'subheadline' => $landing['subheadline'] ?? ($row['app_description'] ?: null),
            'description' => $landing['description'] ?? ($row['app_description'] ?: null),
            'logoUrl' => $landing['logoUrl'] ?? ($row['app_logo'] ?: null),
            'showOpenWebApp' => $landing['showOpenWebApp'] ?? true,
            'showInstallPwa' => $landing['showInstallPwa'] ?? (bool) ($settings['enablePwa'] ?? true),
            'showInstallNative' => $landing['showInstallNative'] ?? false,
            'showPoweredBy' => $landing['showPoweredBy'] ?? true,
            'supportEmail' => $landing['supportEmail'] ?? null,
            'privacyUrl' => $landing['privacyUrl'] ?? null,
            'termsUrl' => $landing['termsUrl'] ?? null,
        ];

        // Public-safe native section derived from the domain's native_config. This surfaces ONLY the
        // install/handoff metadata the launch page needs (packageName / install URL / CTA flags) — never
        // sha256CertFingerprints and NEVER security_config (which stays on the owner-scoped admin path).
        $native = $this->publicNativeSection($this->decodeJson($row['native_config'] ?? null));

        return [
            'app' => [
                'slug' => $row['app_slug'],
                'name' => $row['app_name'],
                'description' => $row['app_description'] ?: null,
                'logoUrl' => $row['app_logo'] ?: null,
                'theme' => ['primaryColor' => $theme['primaryColor'] ?? '#6366f1'],
            ],
            'domain' => [
                'domain' => $row['domain'],
                'mode' => $row['mode'],
            ],
            'landing' => $config,
            'native' => $native,
        ];
    }

    /**
     * Lean host→app gate for the domain-root manifest / asset-link routes. Applies the SAME gate as
     * resolveLaunchConfig (domain status='active' AND app status='published') but returns only the
     * app's identity plus the MATCHED domain's decoded native_config (a white-label Android build's
     * packageName + fingerprints). Public-safe — never form schemas, fields, reports, or scripts.
     * Returns null when the host isn't a connected+active domain of a published app.
     *
     * @return array{id:string, slug:string, name:string, status:string, nativeConfig:array<string,mixed>}|null
     */
    public function resolveAppSlugByHost(string $host): ?array
    {
        $domain = $this->normalizeDomain($host);
        if ($domain === '') {
            return null;
        }
        $stmt = $this->mysql->prepare(
            "SELECT a.id AS app_id, a.slug AS app_slug, a.name AS app_name, a.status AS app_status,
                    d.native_config AS native_config
             FROM app_domains d JOIN apps a ON a.id = d.app_id
             WHERE d.normalized_domain = :d AND d.status = 'active' LIMIT 1"
        );
        $stmt->execute(['d' => $domain]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || ($row['app_status'] ?? '') !== 'published') {
            return null;
        }
        return [
            'id' => (string) $row['app_id'],
            'slug' => (string) $row['app_slug'],
            'name' => (string) $row['app_name'],
            'status' => (string) $row['app_status'],
            'nativeConfig' => $this->decodeJson($row['native_config'] ?? null),
        ];
    }

    // ---- helpers --------------------------------------------------------------------

    /** @return array<string,mixed>|false */
    private function fetchOwned(string $domainId, string $ownerId)
    {
        $stmt = $this->mysql->prepare("SELECT * FROM app_domains WHERE id = :id AND owner_id = :owner LIMIT 1");
        $stmt->execute(['id' => $domainId, 'owner' => $ownerId]);
        return $stmt->fetch(PDO::FETCH_ASSOC);
    }

    private function dnsTxtContains(string $name, string $needle, ?string &$error): bool
    {
        $error = null;
        if (!function_exists('dns_get_record')) {
            $error = 'DNS lookups are unavailable on this server.';
            return false;
        }
        $records = @dns_get_record($name, DNS_TXT);
        if (!is_array($records)) {
            $error = 'No TXT records found.';
            return false;
        }
        foreach ($records as $rec) {
            $txt = $rec['txt'] ?? (isset($rec['entries']) && is_array($rec['entries']) ? implode('', $rec['entries']) : '');
            if (is_string($txt) && str_contains($txt, $needle)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Measure the domain's live TLS status: 'active' when a valid HTTPS handshake succeeds for this
     * host, 'pending' when :443 isn't reachable / the certificate isn't valid yet, 'external' when the
     * host can't be safely probed. SSRF-guarded — never connects to a host resolving to a private IP.
     */
    private function probeTls(string $domain): string
    {
        $err = null;
        if (!IpSafety::resolvesToPublicHost($domain, $err)) {
            return 'external';
        }
        $ctx = stream_context_create(['ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'SNI_enabled' => true,
            'peer_name' => $domain,
        ]]);
        $errno = 0;
        $errstr = '';
        $client = @stream_socket_client(
            'ssl://' . $domain . ':443',
            $errno,
            $errstr,
            5,
            STREAM_CLIENT_CONNECT,
            $ctx
        );
        if ($client === false) {
            return 'pending';
        }
        fclose($client);
        return 'active';
    }

    /** Admin-facing shape (includes the verification token + DNS instructions). */
    private function toAdminArray(array $row): array
    {
        return [
            'id' => $row['id'],
            'appId' => $row['app_id'],
            'domain' => $row['domain'],
            'normalizedDomain' => $row['normalized_domain'],
            'mode' => $row['mode'],
            'status' => $row['status'],
            'verificationMethod' => $row['verification_method'],
            'verificationToken' => $row['verification_token'],
            'dns' => [
                'type' => 'TXT',
                'name' => '_formlogic.' . $row['normalized_domain'],
                'value' => $row['verification_token'],
            ],
            'verifiedAt' => $row['verified_at'],
            'tlsStatus' => $row['tls_status'],
            'landingConfig' => $this->decodeJson($row['landing_config']),
            'nativeConfig' => $this->decodeJson($row['native_config'] ?? null),
            'pwaConfig' => $this->decodeJson($row['pwa_config'] ?? null),
            'securityConfig' => $this->decodeJson($row['security_config'] ?? null),
            'lastError' => $row['last_error'],
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
        ];
    }

    // ---- config sanitization / public projection ------------------------------------

    /**
     * Sanitize owner-authored launch-page config before it is persisted. Text is length-capped; the logo
     * must be an http(s) URL or a size-capped data:image; privacy/terms links must be http(s) and the
     * support address email-ish (javascript: and every other scheme is REJECTED); booleans are normalized.
     * Invalid values are DROPPED (omitted) rather than stored.
     *
     * @param array<string,mixed> $cfg
     * @return array<string,mixed>
     */
    public function sanitizeLandingConfig(array $cfg): array
    {
        $out = [];
        if (($v = $this->capString($cfg['headline'] ?? null, 120)) !== null) {
            $out['headline'] = $v;
        }
        if (($v = $this->capString($cfg['subheadline'] ?? null, 200)) !== null) {
            $out['subheadline'] = $v;
        }
        if (($v = $this->capString($cfg['description'] ?? null, 1000)) !== null) {
            $out['description'] = $v;
        }
        if (($v = $this->sanitizeLogoUrl($cfg['logoUrl'] ?? null)) !== null) {
            $out['logoUrl'] = $v;
        }
        if (($v = $this->sanitizeHttpUrl($cfg['privacyUrl'] ?? null)) !== null) {
            $out['privacyUrl'] = $v;
        }
        if (($v = $this->sanitizeHttpUrl($cfg['termsUrl'] ?? null)) !== null) {
            $out['termsUrl'] = $v;
        }
        if (($v = $this->sanitizeEmail($cfg['supportEmail'] ?? null)) !== null) {
            $out['supportEmail'] = $v;
        }
        foreach (['showOpenWebApp', 'showInstallPwa', 'showInstallNative', 'showPoweredBy'] as $b) {
            if (array_key_exists($b, $cfg)) {
                $out[$b] = $this->toBool($cfg[$b]);
            }
        }
        return $out;
    }

    /**
     * Sanitize native-runtime config before persistence: the package name must match an Android/Java
     * package pattern, each certificate fingerprint must be colon-separated SHA-256 hex, the install URL
     * must be http(s) (NEVER javascript:/market:/intent:), the version string is length-capped, and the
     * flags are normalized to booleans. Invalid values are dropped.
     *
     * @param array<string,mixed> $cfg
     * @return array<string,mixed>
     */
    public function sanitizeNativeConfig(array $cfg): array
    {
        $out = [];
        if (($v = $this->sanitizeAndroidPackage($cfg['packageName'] ?? null)) !== null) {
            $out['packageName'] = $v;
        }
        $fps = [];
        if (is_array($cfg['sha256CertFingerprints'] ?? null)) {
            foreach ($cfg['sha256CertFingerprints'] as $fp) {
                if (($clean = $this->sanitizeCertFingerprint($fp)) !== null) {
                    $fps[] = $clean;
                }
            }
        }
        if (!empty($fps)) {
            $out['sha256CertFingerprints'] = array_values(array_unique($fps));
        }
        if (($v = $this->capString($cfg['minRuntimeVersion'] ?? null, 32)) !== null) {
            $out['minRuntimeVersion'] = $v;
        }
        if (($v = $this->sanitizeHttpUrl($cfg['installUrl'] ?? null)) !== null) {
            $out['installUrl'] = $v;
        }
        foreach (['requireNativeRuntime', 'showNativeCta'] as $b) {
            if (array_key_exists($b, $cfg)) {
                $out[$b] = $this->toBool($cfg[$b]);
            }
        }
        return $out;
    }

    /**
     * Project a stored native_config blob to the PUBLIC-safe section returned by resolveLaunchConfig. Only
     * install/handoff metadata is exposed — packageName, minRuntimeVersion, installUrl, and the CTA flags.
     * sha256CertFingerprints are intentionally OMITTED here and security_config is never even read. Values
     * are re-validated (defense in depth) so a legacy/unsanitized row can't leak a bad install URL.
     *
     * @param array<string,mixed> $nc
     * @return array<string,mixed>
     */
    public function publicNativeSection(array $nc): array
    {
        $packageName = $this->sanitizeAndroidPackage($nc['packageName'] ?? null);
        $installUrl = $this->sanitizeHttpUrl($nc['installUrl'] ?? null);
        $minRuntimeVersion = $this->capString($nc['minRuntimeVersion'] ?? null, 32);
        $requireNativeRuntime = !empty($nc['requireNativeRuntime']);
        $showNativeCta = !empty($nc['showNativeCta']);
        return [
            'enabled' => $packageName !== null || $installUrl !== null || $requireNativeRuntime || $showNativeCta,
            'packageName' => $packageName,
            'minRuntimeVersion' => $minRuntimeVersion,
            'installUrl' => $installUrl,
            'requireNativeRuntime' => $requireNativeRuntime,
            'showNativeCta' => $showNativeCta,
        ];
    }

    /** Trim + length-cap a string field; null when not a usable string. */
    private function capString($value, int $max): ?string
    {
        if (!is_string($value) && !is_numeric($value)) {
            return null;
        }
        $s = trim((string) $value);
        if ($s === '') {
            return null;
        }
        return mb_substr($s, 0, $max);
    }

    /** An http(s) URL only (rejects javascript:/data:/etc.), length-capped; null when invalid. */
    private function sanitizeHttpUrl($value, int $maxLen = 2048): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $s = trim($value);
        if ($s === '' || strlen($s) > $maxLen) {
            return null;
        }
        $scheme = strtolower((string) parse_url($s, PHP_URL_SCHEME));
        if ($scheme !== 'http' && $scheme !== 'https') {
            return null;
        }
        return filter_var($s, FILTER_VALIDATE_URL) !== false ? $s : null;
    }

    /** An http(s) URL or a size-capped data:image; null when invalid. */
    private function sanitizeLogoUrl($value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $s = trim($value);
        if ($s === '') {
            return null;
        }
        if (stripos($s, 'data:image/') === 0) {
            // Cap so we don't persist a huge base64 blob in the JSON column.
            return strlen($s) <= 200000 ? $s : null;
        }
        return $this->sanitizeHttpUrl($s);
    }

    /** An email-ish address (rejects javascript: and other non-email input); null when invalid. */
    private function sanitizeEmail($value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $s = trim($value);
        if ($s === '' || strlen($s) > 254) {
            return null;
        }
        return filter_var($s, FILTER_VALIDATE_EMAIL) !== false ? $s : null;
    }

    /** An Android/Java package name: dot-separated segments, each starting with a letter, ≥2 segments. */
    private function sanitizeAndroidPackage($value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $s = trim($value);
        if ($s === '' || strlen($s) > 255) {
            return null;
        }
        return preg_match('/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/', $s) ? $s : null;
    }

    /** A colon-separated SHA-256 certificate fingerprint (32 hex byte-pairs), upper-cased; null when invalid. */
    private function sanitizeCertFingerprint($value): ?string
    {
        if (!is_string($value)) {
            return null;
        }
        $s = strtoupper(trim($value));
        return preg_match('/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/', $s) ? $s : null;
    }

    /** Normalize a config flag to a real boolean (accepts JSON bools + common truthy strings). */
    private function toBool($value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_string($value)) {
            return in_array(strtolower(trim($value)), ['1', 'true', 'yes', 'on'], true);
        }
        return (bool) $value;
    }

    private function decodeJson($value): array
    {
        if (is_string($value) && $value !== '') {
            $decoded = json_decode($value, true);
            return is_array($decoded) ? $decoded : [];
        }
        return is_array($value) ? $value : [];
    }

    private function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
