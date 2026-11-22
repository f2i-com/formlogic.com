<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * RFC 8628-aligned Device / Interactive Login flow for MCP clients.
 *
 * Lets any AI connected over MCP (including zero-account / non-OAuth clients starting on
 * `/api/mcp/public` or `/api/mcp/forms/{formId}`) sign in on behalf of a user cleanly:
 *  1. AI calls `start_mcp_login` (or `POST /api/oauth/device`) -> receives a short-lived
 *     `deviceCode`, human-friendly `userCode` (e.g. `ABCD-EFGH`), and `verificationUriComplete`.
 *  2. User opens the link in their browser, signs in (with full password/MFA support) or signs up,
 *     reviews & optionally narrows scopes/app access, and clicks Approve.
 *  3. AI calls `complete_mcp_login` (or `POST /api/oauth/device/token`) -> atomically redeems
 *     the approved challenge once and receives an audience-bound `flm_oauth_*` Bearer token.
 *
 * Security invariants:
 *  - `deviceCode` carries 256 bits of CSPRNG entropy and is stored strictly as a SHA-256 hash.
 *  - Challenges expire in 10 minutes and are atomically single-use (`UPDATE ... WHERE status = 'approved'`).
 *  - Scopes are restricted to standard MCP scopes (never Aokie Companion private scopes).
 */
class McpDeviceAuthService
{
    public const DEVICE_CODE_PREFIX = 'mcpdc_';
    public const TTL_SECONDS = 600;       // 10 minutes
    public const POLL_INTERVAL = 5;       // seconds
    /** Unambiguous Crockford-like alphabet (no 0/O, 1/I/L). */
    private const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

    public function __construct(
        private MySQLConnection $mysql,
        private McpTokenService $tokens,
    ) {}

    private function db(): PDO
    {
        return $this->mysql->getConnection();
    }

    /**
     * Start a new interactive MCP login challenge.
     *
     * @param list<string>|null $requestedScopes
     * @return array{
     *   deviceCode: string,
     *   userCode: string,
     *   verificationUri: string,
     *   verificationUriComplete: string,
     *   expiresIn: int,
     *   interval: int,
     *   scopes: list<string>,
     *   clientName: string
     * }
     */
    public function startLogin(
        string $clientName,
        ?array $requestedScopes,
        ?string $appId,
        string $origin,
    ): array {
        $this->purgeExpired();

        $allowedScopes = array_values(array_diff(McpTokenService::ALL_SCOPES, [
            'aokie:state', 'aokie:monitor', 'aokie:consult', 'aokie:takeover',
            'aokie:resume', 'aokie:assistance', 'aokie:end_caller',
        ]));
        $scopes = $requestedScopes !== null && $requestedScopes !== []
            ? array_values(array_unique(array_intersect($allowedScopes, $requestedScopes)))
            : McpTokenService::DEFAULT_SCOPES;
        if ($scopes === []) {
            $scopes = McpTokenService::DEFAULT_SCOPES;
        }

        $cleanClient = trim(preg_replace('/[\x00-\x1F\x7F]+/', ' ', $clientName) ?? '');
        if ($cleanClient === '') {
            $cleanClient = 'AI Assistant (MCP)';
        }
        $cleanClient = mb_substr($cleanClient, 0, 120);

        $cleanAppId = ($appId !== null && trim($appId) !== '') ? mb_substr(trim($appId), 0, 36) : null;
        $deviceCode = self::DEVICE_CODE_PREFIX . bin2hex(random_bytes(32));
        $userCode = $this->generateUniqueUserCode();
        $expiresAt = date('Y-m-d H:i:s', time() + self::TTL_SECONDS);

        $stmt = $this->db()->prepare("
            INSERT INTO mcp_device_codes
                (id, device_code_hash, user_code, client_name, requested_scopes, app_id, status, expires_at, created_at)
            VALUES (:id, :h, :uc, :cname, :scopes, :app, 'pending', :exp, NOW())
        ");
        $stmt->execute([
            'id' => $this->uuid(),
            'h' => hash('sha256', $deviceCode),
            'uc' => $userCode,
            'cname' => $cleanClient,
            'scopes' => json_encode($scopes),
            'app' => $cleanAppId,
            'exp' => $expiresAt,
        ]);

        $origin = rtrim($origin, '/');
        $verificationUri = $origin . '/oauth/device';
        return [
            'deviceCode' => $deviceCode,
            'userCode' => $userCode,
            'verificationUri' => $verificationUri,
            'verificationUriComplete' => $verificationUri . '?code=' . rawurlencode($userCode),
            'expiresIn' => self::TTL_SECONDS,
            'interval' => self::POLL_INTERVAL,
            'scopes' => $scopes,
            'clientName' => $cleanClient,
        ];
    }

    /**
     * Look up a pending device login by user code (for the browser approval page).
     *
     * @return ?array{
     *   userCode: string,
     *   clientName: string,
     *   scopes: list<string>,
     *   scopeLabels: array<string, string>,
     *   appId: ?string,
     *   expiresAt: string,
     *   status: string
     * }
     */
    public function lookupByUserCode(string $rawUserCode): ?array
    {
        $code = self::normalizeUserCode($rawUserCode);
        if ($code === null) {
            return null;
        }
        $stmt = $this->db()->prepare("
            SELECT user_code, client_name, requested_scopes, app_id, status, expires_at
            FROM mcp_device_codes
            WHERE user_code = :uc AND expires_at > NOW()
            LIMIT 1
        ");
        $stmt->execute(['uc' => $code]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        $scopes = json_decode((string) $row['requested_scopes'], true);
        $scopes = is_array($scopes) ? array_values(array_filter($scopes, 'is_string')) : McpTokenService::DEFAULT_SCOPES;
        return [
            'userCode' => (string) $row['user_code'],
            'clientName' => (string) $row['client_name'],
            'scopes' => $scopes,
            'scopeLabels' => McpOAuthService::scopeLabels($scopes),
            'appId' => is_string($row['app_id']) && $row['app_id'] !== '' ? $row['app_id'] : null,
            'expiresAt' => gmdate('c', strtotime((string) $row['expires_at']) ?: time()),
            'status' => (string) $row['status'],
        ];
    }

    /**
     * Approve or deny a pending device login from an authenticated browser session.
     *
     * @param list<string>|null $approvedScopes
     * @return array{ok: bool, status?: string, error?: string}
     */
    public function decide(
        string $rawUserCode,
        string $userId,
        ?array $approvedScopes = null,
        ?string $appId = null,
        bool $deny = false,
        bool $readOnly = false,
    ): array {
        $code = self::normalizeUserCode($rawUserCode);
        if ($code === null) {
            return ['ok' => false, 'error' => 'Invalid device code format.'];
        }
        $stmt = $this->db()->prepare("
            SELECT id, requested_scopes, status, expires_at
            FROM mcp_device_codes
            WHERE user_code = :uc
            LIMIT 1
        ");
        $stmt->execute(['uc' => $code]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return ['ok' => false, 'error' => 'Code not found. Check the code shown by your AI client and try again.'];
        }
        if (strtotime((string) $row['expires_at']) < time()) {
            return ['ok' => false, 'error' => 'This sign-in code has expired. Ask your AI client to generate a new code.'];
        }
        if ((string) $row['status'] !== 'pending') {
            return ['ok' => false, 'error' => 'This sign-in code has already been ' . $row['status'] . '.'];
        }

        if ($deny) {
            $upd = $this->db()->prepare("
                UPDATE mcp_device_codes
                SET status = 'denied', user_id = :uid
                WHERE id = :id AND status = 'pending'
            ");
            $upd->execute(['uid' => $userId, 'id' => $row['id']]);
            return $upd->rowCount() > 0
                ? ['ok' => true, 'status' => 'denied']
                : ['ok' => false, 'error' => 'This sign-in code was already decided.'];
        }

        $requested = json_decode((string) $row['requested_scopes'], true);
        $requested = is_array($requested) ? array_values(array_filter($requested, 'is_string')) : McpTokenService::DEFAULT_SCOPES;
        if ($readOnly) {
            $finalScopes = ['apps:read', 'forms:read', 'responses:read'];
        } elseif ($approvedScopes !== null && $approvedScopes !== []) {
            $finalScopes = array_values(array_intersect($requested, $approvedScopes));
            if ($finalScopes === []) {
                return ['ok' => false, 'error' => 'Select at least one permission to approve.'];
            }
        } else {
            $finalScopes = $requested;
        }

        $upd = $this->db()->prepare("
            UPDATE mcp_device_codes
            SET status = 'approved',
                user_id = :uid,
                approved_scopes = :scopes,
                app_id = :app
            WHERE id = :id AND status = 'pending' AND expires_at > NOW()
        ");
        $upd->execute([
            'uid' => $userId,
            'scopes' => json_encode($finalScopes),
            'app' => ($appId !== null && trim($appId) !== '') ? trim($appId) : null,
            'id' => $row['id'],
        ]);

        return $upd->rowCount() > 0
            ? ['ok' => true, 'status' => 'approved']
            : ['ok' => false, 'error' => 'This sign-in code is no longer pending.'];
    }

    /**
     * Poll or atomically redeem a device code for an audience-bound MCP Bearer token.
     *
     * @return array<string, mixed>
     */
    public function pollOrRedeem(string $deviceCode, string $mcpResourceUrl): array
    {
        if (preg_match('/^mcpdc_[a-f0-9]{64}$/', $deviceCode) !== 1) {
            return ['status' => 'expired_token', 'error' => 'Invalid device code.'];
        }
        $hash = hash('sha256', $deviceCode);
        $stmt = $this->db()->prepare("
            SELECT id, user_id, client_name, approved_scopes, requested_scopes, app_id, status, expires_at
            FROM mcp_device_codes
            WHERE device_code_hash = :h
            LIMIT 1
        ");
        $stmt->execute(['h' => $hash]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return ['status' => 'expired_token', 'error' => 'Unknown or expired sign-in challenge.'];
        }
        if (strtotime((string) $row['expires_at']) < time()) {
            return ['status' => 'expired_token', 'error' => 'The sign-in challenge expired. Call start_mcp_login again.'];
        }
        $status = (string) $row['status'];
        if ($status === 'pending') {
            $this->db()->prepare('UPDATE mcp_device_codes SET last_polled_at = NOW() WHERE id = :id')
                ->execute(['id' => $row['id']]);
            return [
                'status' => 'authorization_pending',
                'retryAfterSeconds' => self::POLL_INTERVAL,
                'message' => 'Waiting for the user to approve the sign-in link in their browser.',
            ];
        }
        if ($status === 'denied') {
            return ['status' => 'access_denied', 'error' => 'The user denied the sign-in request.'];
        }
        if ($status !== 'approved') {
            return ['status' => 'expired_token', 'error' => 'This sign-in code has already been redeemed.'];
        }

        // Atomic single-use claim: only ONE caller wins redemption.
        $claim = $this->db()->prepare("
            UPDATE mcp_device_codes
            SET status = 'consumed', last_polled_at = NOW()
            WHERE id = :id AND status = 'approved'
        ");
        $claim->execute(['id' => $row['id']]);
        if ($claim->rowCount() === 0) {
            return ['status' => 'expired_token', 'error' => 'This sign-in code has already been redeemed.'];
        }

        $userId = (string) ($row['user_id'] ?? '');
        if ($userId === '') {
            return ['status' => 'expired_token', 'error' => 'Sign-in approval is incomplete.'];
        }
        $scopes = json_decode((string) ($row['approved_scopes'] ?? $row['requested_scopes']), true);
        $scopes = is_array($scopes) ? array_values(array_filter($scopes, 'is_string')) : McpTokenService::DEFAULT_SCOPES;
        $appId = is_string($row['app_id']) && $row['app_id'] !== '' ? $row['app_id'] : null;

        $minted = $this->tokens->createOAuth(
            $userId,
            $appId,
            $scopes,
            $mcpResourceUrl,
            3600,
            'device:' . mb_substr((string) $row['client_name'], 0, 80),
        );

        return [
            'status' => 'approved',
            'accessToken' => $minted['token'],
            'tokenType' => 'Bearer',
            'expiresIn' => 3600,
            'expiresAt' => $minted['expiresAt'],
            'scopes' => $minted['scopes'],
            'appId' => $minted['appId'],
            'mcpUrl' => $mcpResourceUrl,
        ];
    }

    public static function normalizeUserCode(string $raw): ?string
    {
        $clean = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $raw) ?? '');
        if (strlen($clean) !== 8) {
            return null;
        }
        return substr($clean, 0, 4) . '-' . substr($clean, 4, 4);
    }

    private function generateUniqueUserCode(): string
    {
        $chars = self::CODE_ALPHABET;
        $max = strlen($chars) - 1;
        for ($attempt = 0; $attempt < 10; $attempt++) {
            $buf = '';
            for ($i = 0; $i < 8; $i++) {
                $buf .= $chars[random_int(0, $max)];
            }
            $code = substr($buf, 0, 4) . '-' . substr($buf, 4, 4);
            $check = $this->db()->prepare('SELECT 1 FROM mcp_device_codes WHERE user_code = :uc LIMIT 1');
            $check->execute(['uc' => $code]);
            if (!$check->fetchColumn()) {
                return $code;
            }
        }
        return strtoupper(bin2hex(random_bytes(2))) . '-' . strtoupper(bin2hex(random_bytes(2)));
    }

    private function purgeExpired(): void
    {
        try {
            $this->db()->exec('DELETE FROM mcp_device_codes WHERE expires_at < NOW() LIMIT 200');
        } catch (\Throwable) {
            // Opportunistic cleanup must not block login starts.
        }
    }

    private function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
