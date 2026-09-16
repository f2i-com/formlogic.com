<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Admin-panel queries: platform-wide counts, the user directory with per-user
 * resource counts, structure views (never response DATA — only counts, so an
 * admin can gauge usage/quotas without reading anyone's records), the
 * admin-flag grant/revoke, and broadcast notices.
 */
class AdminService
{
    /** How recently a user must have been seen to count as "online". */
    public const ONLINE_WINDOW_SECONDS = 300;

    private const NOTICE_LEVELS = ['info', 'success', 'warning'];
    private const NOTICE_AUDIENCES = ['online', 'all'];
    private const NOTICE_MAX_LENGTH = 500;

    private PDO $mysql;
    private MySQLConnection $connection;
    private ?RuntimeEngineService $engineService = null;

    /**
     * $hosting and $native are optional and default to the production stores, so every existing
     * `new AdminService($mysql)` keeps its one-argument shape; tests point them at their own roots.
     * They exist only to answer what an app's client logic is written in, which the per-app engine
     * below cannot be truthful without.
     */
    public function __construct(MySQLConnection $mysql, private ?HostedAppService $hosting = null, private ?NativeAppService $native = null)
    {
        $this->connection = $mysql;
        $this->mysql = $mysql->getConnection();
    }

    /** Lazy so every existing `new AdminService($mysql)` keeps its one-argument shape. */
    private function engines(): RuntimeEngineService
    {
        return $this->engineService ??= new RuntimeEngineService($this->connection);
    }

    /**
     * What one app's client logic is written in, across both bundles the engine choice governs.
     * One derivation (RuntimeEngineService::languagesOf), one reader per store, the same as every
     * runtime GET uses. Each store answers null cheaply for an app it holds nothing for, so an app
     * with no deployment costs two stat calls.
     *
     * @return list<string>
     */
    private function appLanguages(string $appId): array
    {
        $this->hosting ??= new HostedAppService(new SandboxRunner());
        $this->native ??= new NativeAppService();
        return RuntimeEngineService::mergeLanguages(
            $this->hosting->clientLanguages($appId),
            $this->native->clientLanguages($appId),
        );
    }

    // ── Overview ─────────────────────────────────────────────────────────────

    public function overview(): array
    {
        $one = fn (string $sql): int => (int) $this->mysql->query($sql)->fetchColumn();
        return [
            'users' => $one('SELECT COUNT(*) FROM users'),
            'admins' => $one('SELECT COUNT(*) FROM users WHERE is_admin = 1'),
            'onlineUsers' => $this->onlineUserCount(),
            'apps' => $one('SELECT COUNT(*) FROM apps'),
            'forms' => $one('SELECT COUNT(*) FROM forms'),
            'flows' => $one('SELECT COUNT(*) FROM flow_definitions'),
            // Denormalized counter (synced on every write path) — no SQLite scan.
            'responses' => $one('SELECT COALESCE(SUM(response_count), 0) FROM forms'),
            'signups7d' => $one('SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'),
        ];
    }

    public function onlineUserCount(): int
    {
        $stmt = $this->mysql->prepare(
            'SELECT COUNT(*) FROM users WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL :w SECOND)'
        );
        $stmt->bindValue('w', self::ONLINE_WINDOW_SECONDS, PDO::PARAM_INT);
        $stmt->execute();
        return (int) $stmt->fetchColumn();
    }

    // ── User directory ───────────────────────────────────────────────────────

    /** @return array{users: array[], total: int, page: int, pages: int} */
    public function listUsers(string $search = '', int $page = 1, int $limit = 25): array
    {
        $limit = max(1, min(100, $limit));
        $page = max(1, $page);
        $where = '';
        $params = [];
        if ($search !== '') {
            $where = 'WHERE u.email LIKE :q OR u.name LIKE :q2';
            $like = '%' . addcslashes($search, '%_\\') . '%';
            $params['q'] = $like;
            $params['q2'] = $like;
        }

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM users u {$where}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $this->mysql->prepare("
            SELECT u.id, u.email, u.name, u.plan, u.cloud_until, u.is_admin, u.created_at, u.last_seen_at,
                   u.code_trust_verified_at,
                   (SELECT COUNT(*) FROM apps a WHERE a.owner_id = u.id) AS apps_count,
                   (SELECT COUNT(*) FROM forms f WHERE f.user_id = u.id) AS forms_count,
                   (SELECT COUNT(*) FROM flow_definitions fd WHERE fd.owner_user_id = u.id) AS flows_count,
                   (SELECT COALESCE(SUM(f2.response_count), 0) FROM forms f2 WHERE f2.user_id = u.id) AS responses_count
            FROM users u {$where}
            ORDER BY u.created_at DESC, u.id DESC
            LIMIT " . (int) $limit . ' OFFSET ' . (int) (($page - 1) * $limit)
        );
        $stmt->execute($params);

        $users = array_map(fn (array $r) => $this->formatUserRow($r), $stmt->fetchAll(PDO::FETCH_ASSOC));
        return ['users' => $users, 'total' => $total, 'page' => $page, 'pages' => max(1, (int) ceil($total / $limit))];
    }

    public function getUserOverview(string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT u.id, u.email, u.name, u.plan, u.cloud_until, u.is_admin, u.created_at, u.last_seen_at, u.mfa_enabled,
                   u.code_trust_verified_at, u.code_trust_verified_by
            FROM users u WHERE u.id = :id
        ");
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $user = $this->formatUserRow($row);

        // One owner row and one policy read for the whole list; the per-app resolver is pure, and
        // the only per-app input left is what that app's client logic is written in (below). With
        // all four the admin sees exactly what each app's runtime GET would answer.
        $owner = RuntimeEngineService::ownerOf($row);
        $policy = $this->engines()->readPolicy();
        $installed = $this->engines()->installedEngines();

        // Apps the user OWNS, with structure counts (no record data).
        $apps = $this->mysql->prepare("
            SELECT a.id, a.name, a.slug, a.status, a.created_at, a.client_engine,
                   (SELECT COUNT(*) FROM app_forms af WHERE af.app_id = a.id) AS form_count,
                   (SELECT COUNT(*) FROM flow_definitions fd WHERE fd.app_id = a.id) AS flow_count,
                   (SELECT COUNT(*) FROM app_flow_bindings b WHERE b.app_id = a.id) AS binding_count,
                   (SELECT COUNT(*) FROM app_users au WHERE au.app_id = a.id) AS member_count
            FROM apps a WHERE a.owner_id = :id ORDER BY a.created_at DESC
        ");
        $apps->execute(['id' => $userId]);
        $user['apps'] = array_map(fn (array $a) => [
            'id' => $a['id'], 'name' => $a['name'], 'slug' => $a['slug'], 'status' => $a['status'],
            'createdAt' => $a['created_at'],
            'formCount' => (int) $a['form_count'], 'flowCount' => (int) $a['flow_count'],
            'bindingCount' => (int) $a['binding_count'], 'memberCount' => (int) $a['member_count'],
            // The languages too: an admin reads this column to decide whether an account still
            // needs its code-trust verification, and an app whose logic is Python can never run on
            // host JavaScript however that account is set.
            'engine' => RuntimeEngineService::resolve(
                is_string($a['client_engine'] ?? null) ? $a['client_engine'] : null,
                $policy,
                $installed,
                $owner,
                $this->appLanguages((string) $a['id'])
            ),
        ], $apps->fetchAll(PDO::FETCH_ASSOC));

        // Every form the user owns (record COUNTS only — never the records).
        $forms = $this->mysql->prepare("
            SELECT f.id, f.title, f.status, f.created_at, f.updated_at, f.response_count,
                   (SELECT GROUP_CONCAT(a.name SEPARATOR ', ')
                      FROM app_forms af JOIN apps a ON a.id = af.app_id
                     WHERE af.form_id = f.id) AS app_names
            FROM forms f WHERE f.user_id = :id ORDER BY f.updated_at DESC
        ");
        $forms->execute(['id' => $userId]);
        $user['forms'] = array_map(static fn (array $f) => [
            'id' => $f['id'], 'title' => $f['title'], 'status' => $f['status'],
            'createdAt' => $f['created_at'], 'updatedAt' => $f['updated_at'],
            'responseCount' => $f['response_count'] !== null ? (int) $f['response_count'] : null,
            'apps' => $f['app_names'],
        ], $forms->fetchAll(PDO::FETCH_ASSOC));

        // Flows (app-scoped and workspace).
        $flows = $this->mysql->prepare("
            SELECT fd.id, fd.app_id, fd.name, fd.slug, fd.enabled, fd.version, fd.updated_at,
                   a.name AS app_name
            FROM flow_definitions fd LEFT JOIN apps a ON a.id = fd.app_id
            WHERE fd.owner_user_id = :id ORDER BY fd.updated_at DESC
        ");
        $flows->execute(['id' => $userId]);
        $user['flows'] = array_map(static fn (array $f) => [
            'id' => $f['id'], 'appId' => $f['app_id'], 'appName' => $f['app_name'],
            'name' => $f['name'], 'slug' => $f['slug'],
            'enabled' => (bool) $f['enabled'], 'version' => (int) $f['version'], 'updatedAt' => $f['updated_at'],
        ], $flows->fetchAll(PDO::FETCH_ASSOC));

        return $user;
    }

    /** Owner user id of a form/app/flow (admin edits act "on behalf of" the owner). */
    public function resourceOwner(string $table, string $id): ?string
    {
        $col = match ($table) {
            'forms' => 'user_id',
            'apps' => 'owner_id',
            'flow_definitions' => 'owner_user_id',
            default => throw new \InvalidArgumentException('unknown table'),
        };
        $stmt = $this->mysql->prepare("SELECT {$col} FROM {$table} WHERE id = :id");
        $stmt->execute(['id' => $id]);
        $owner = $stmt->fetchColumn();
        return $owner === false ? null : (string) $owner;
    }

    /** The app a flow belongs to (null = workspace flow). */
    public function flowAppId(string $flowId): ?string
    {
        $stmt = $this->mysql->prepare('SELECT app_id FROM flow_definitions WHERE id = :id');
        $stmt->execute(['id' => $flowId]);
        $appId = $stmt->fetchColumn();
        return ($appId === false || $appId === null) ? null : (string) $appId;
    }

    // ── Admin flag ───────────────────────────────────────────────────────────

    /** @throws \InvalidArgumentException on guard violations */
    public function setAdminFlag(string $targetUserId, bool $isAdmin, string $actingUserId): void
    {
        $stmt = $this->mysql->prepare('SELECT email FROM users WHERE id = :id');
        $stmt->execute(['id' => $targetUserId]);
        $email = $stmt->fetchColumn();
        if ($email === false) {
            throw new \InvalidArgumentException('User not found');
        }
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        if ($isAdmin && strtolower((string) $email) === $demoEmail) {
            throw new \InvalidArgumentException('The shared demo account cannot be an administrator');
        }
        if (!$isAdmin && $targetUserId === $actingUserId) {
            throw new \InvalidArgumentException('You cannot remove your own administrator access');
        }
        $upd = $this->mysql->prepare('UPDATE users SET is_admin = :a WHERE id = :id');
        $upd->execute(['a' => $isAdmin ? 1 : 0, 'id' => $targetUserId]);
    }

    // ── Code trust (the host-JavaScript engine) ──────────────────────────────

    /**
     * Mark an account verified (or revoke it) for the host-JavaScript client engine — the one
     * engine that runs the owner's code without the ZIPP VM around it, so this is an explicit
     * transfer of trust to that account, not a convenience flag.
     *
     * Guards, mirroring setAdminFlag: the shared demo account can never be verified. Verifying
     * also REQUIRES the account's own two-factor auth to be on, so the trusted account cannot be
     * taken over with a password alone; MfaService::disable revokes verification again the moment
     * that stops being true. An admin may verify their own account (a single-admin install has no
     * second admin to ask) — the audit row says so.
     *
     * ONE transaction, and the audit row is inside it — the caller supplies the AuditService as an
     * argument, not a constructor dependency, so every existing `new AdminService($mysql)` keeps
     * its shape, and required, so the row can never be skipped. Revoking clears every stored
     * host-js choice on the account's apps, so a later re-verification cannot silently switch host
     * JavaScript back on without the owner choosing it again. If the row cannot be written, the
     * trust change does not commit.
     *
     * @return array{verified: bool, verifiedAt: string|null, verifiedBy: string|null, affectedApps: list<string>, self: bool}
     * @throws \InvalidArgumentException on guard violations
     */
    public function setCodeTrust(
        string $targetUserId,
        bool $verified,
        string $actingUserId,
        AuditService $audit,
        ?string $ipAddress = null
    ): array {
        $stmt = $this->mysql->prepare('SELECT id, email, mfa_enabled, code_trust_verified_at FROM users WHERE id = :id');
        $stmt->execute(['id' => $targetUserId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new \InvalidArgumentException('User not found');
        }
        if ($verified && $this->isDemoRow($row)) {
            throw new \InvalidArgumentException('The shared demo account cannot be verified for code trust');
        }
        if ($verified && !(bool) ($row['mfa_enabled'] ?? false)) {
            throw new \InvalidArgumentException('This account must have two-factor authentication enabled before it can be verified for code trust');
        }

        $ownsTx = !$this->mysql->inTransaction();
        if ($ownsTx) {
            $this->mysql->beginTransaction();
        }
        try {
            $affected = $verified ? [] : $this->clearHostJsApps($targetUserId);
            $upd = $this->mysql->prepare(
                'UPDATE users SET code_trust_verified_at = :at, code_trust_verified_by = :by WHERE id = :id'
            );
            $upd->execute([
                'at' => $verified ? date('Y-m-d H:i:s') : null,
                'by' => $verified ? $actingUserId : null,
                'id' => $targetUserId,
            ]);
            $result = $this->codeTrustRow($targetUserId) + [
                'affectedApps' => $affected,
                'self' => $targetUserId === $actingUserId,
            ];
            $audit->logStrict(
                $verified ? 'admin.verify_code_trust' : 'admin.revoke_code_trust',
                'user',
                $targetUserId,
                $actingUserId,
                $ipAddress,
                ['affectedApps' => $affected, 'self' => $result['self']]
            );
            if ($ownsTx) {
                $this->mysql->commit();
            }
            return $result;
        } catch (\Throwable $e) {
            if ($ownsTx && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Drop every stored host-js choice on one account's apps, naming the apps that changed.
     * Shared with MfaService, which revokes code trust when two-factor auth is switched off.
     *
     * @return list<string>
     */
    public function clearHostJsApps(string $userId): array
    {
        $ids = $this->mysql->prepare('SELECT id FROM apps WHERE owner_id = :id AND client_engine = :e');
        $ids->execute(['id' => $userId, 'e' => RuntimeEngineService::HOST_JS]);
        $affected = array_map('strval', $ids->fetchAll(PDO::FETCH_COLUMN));
        if ($affected !== []) {
            $this->mysql->prepare('UPDATE apps SET client_engine = NULL WHERE owner_id = :id AND client_engine = :e')
                ->execute(['id' => $userId, 'e' => RuntimeEngineService::HOST_JS]);
        }
        return $affected;
    }

    /** @return array{verified: bool, verifiedAt: string|null, verifiedBy: string|null} */
    public function codeTrustRow(string $userId): array
    {
        $stmt = $this->mysql->prepare('SELECT code_trust_verified_at, code_trust_verified_by FROM users WHERE id = :id');
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        $at = $row['code_trust_verified_at'] ?? null;
        return [
            'verified' => is_string($at) && $at !== '',
            'verifiedAt' => is_string($at) && $at !== '' ? $at : null,
            'verifiedBy' => $row['code_trust_verified_by'] ?? null,
        ];
    }

    // ── Account tools (support operations, all audited by the controller) ────

    /** The target row (id/email/is_admin/plan/cloud_until) or null — shared guard base for the tools below. */
    public function accountRow(string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT id, email, is_admin, plan, cloud_until FROM users WHERE id = :id');
        $stmt->execute(['id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    /** True when the row is the shared public demo account. */
    public function isDemoRow(array $row): bool
    {
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        return strtolower((string) ($row['email'] ?? '')) === $demoEmail;
    }

    /** Set a user's password hash (lockout recovery). Caller revokes sessions + audits. */
    public function setUserPassword(string $userId, string $password): void
    {
        $upd = $this->mysql->prepare('UPDATE users SET password_hash = :h WHERE id = :id');
        $upd->execute(['h' => password_hash($password, PASSWORD_DEFAULT), 'id' => $userId]);
    }

    /**
     * Change a user's email address. Validates format + uniqueness.
     * @throws \InvalidArgumentException
     */
    public function setUserEmail(string $userId, string $email): void
    {
        $email = trim($email);
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new \InvalidArgumentException('Invalid email format');
        }
        $dupe = $this->mysql->prepare('SELECT id FROM users WHERE email = :e AND id != :id');
        $dupe->execute(['e' => $email, 'id' => $userId]);
        if ($dupe->fetchColumn() !== false) {
            throw new \InvalidArgumentException('Another account already uses that email address');
        }
        $upd = $this->mysql->prepare('UPDATE users SET email = :e WHERE id = :id');
        $upd->execute(['e' => $email, 'id' => $userId]);
    }

    /** The user's payment ledger (metadata only — amounts, months, status; never card/PayPal detail). */
    public function listPayments(string $userId): array
    {
        $stmt = $this->mysql->prepare(
            'SELECT id, provider, order_id, capture_id, amount_cents, currency, months, status, created_at
             FROM payments WHERE user_id = :id ORDER BY created_at DESC LIMIT 200'
        );
        $stmt->execute(['id' => $userId]);
        return array_map(static fn (array $p) => [
            'id' => $p['id'],
            'provider' => $p['provider'],
            'orderId' => $p['order_id'],
            'captureId' => $p['capture_id'],
            'amountCents' => (int) $p['amount_cents'],
            'currency' => $p['currency'],
            'months' => (int) $p['months'],
            'status' => $p['status'],
            'createdAt' => $p['created_at'],
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** Far enough out to read as "never expires", near enough to distinguish from real top-ups. */
    private const COMPLIMENTARY_YEARS = 100;

    /**
     * Complimentary access: ON pushes cloud_until ~100 years out so the account
     * never needs a payment; OFF sets it to NOW (any enforcement then applies
     * normally — on self-hosted installs enforcement is off anyway).
     */
    public function setComplimentary(string $userId, bool $on): void
    {
        $sql = $on
            ? 'UPDATE users SET cloud_until = DATE_ADD(NOW(), INTERVAL ' . self::COMPLIMENTARY_YEARS . ' YEAR) WHERE id = :id'
            : 'UPDATE users SET cloud_until = NOW() WHERE id = :id';
        $this->mysql->prepare($sql)->execute(['id' => $userId]);
    }

    /** Whether the account's access reads as complimentary (cloud_until decades out). */
    public function isComplimentary(?string $cloudUntil): bool
    {
        return !empty($cloudUntil) && strtotime((string) $cloudUntil) > time() + 50 * 365 * 86400;
    }

    // ── Broadcast notices ────────────────────────────────────────────────────

    /** @throws \InvalidArgumentException on validation failure */
    public function createNotice(string $message, string $level, string $audience, string $createdBy, ?int $expiresMinutes = null): array
    {
        $message = trim($message);
        if ($message === '' || mb_strlen($message) > self::NOTICE_MAX_LENGTH) {
            throw new \InvalidArgumentException('Notice message is required (max ' . self::NOTICE_MAX_LENGTH . ' characters)');
        }
        if (!in_array($level, self::NOTICE_LEVELS, true)) {
            throw new \InvalidArgumentException('level must be one of: ' . implode(', ', self::NOTICE_LEVELS));
        }
        if (!in_array($audience, self::NOTICE_AUDIENCES, true)) {
            throw new \InvalidArgumentException('audience must be one of: ' . implode(', ', self::NOTICE_AUDIENCES));
        }
        // 'online' targets people signed in right now → short default window;
        // 'all' persists so later logins see it too.
        $minutes = $expiresMinutes !== null ? max(1, min(60 * 24 * 30, $expiresMinutes)) : ($audience === 'online' ? 60 : 60 * 24 * 7);

        $id = $this->uuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO admin_notices (id, message, level, audience, created_by, expires_at)
            VALUES (:id, :m, :l, :a, :by, DATE_ADD(NOW(), INTERVAL :mins MINUTE))
        ");
        $stmt->execute(['id' => $id, 'm' => $message, 'l' => $level, 'a' => $audience, 'by' => $createdBy, 'mins' => $minutes]);
        return $this->getNotice($id);
    }

    public function getNotice(string $id): ?array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM admin_notices WHERE id = :id');
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ? $this->formatNotice($row) : null;
    }

    /** Admin view: recent notices incl. expired/revoked (for the panel's history). */
    public function listNotices(int $limit = 50): array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM admin_notices ORDER BY created_at DESC LIMIT ' . max(1, min(200, $limit)));
        $stmt->execute();
        return array_map(fn (array $r) => $this->formatNotice($r), $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    public function revokeNotice(string $id): bool
    {
        $stmt = $this->mysql->prepare('UPDATE admin_notices SET revoked_at = NOW() WHERE id = :id AND revoked_at IS NULL');
        $stmt->execute(['id' => $id]);
        return $stmt->rowCount() > 0;
    }

    /** Live notices for a signed-in user's dashboard poll (client dedupes by id). */
    public function activeNotices(): array
    {
        try {
            $stmt = $this->mysql->query("
                SELECT * FROM admin_notices
                WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
                ORDER BY created_at DESC LIMIT 10
            ");
            return array_map(fn (array $r) => $this->formatNotice($r), $stmt->fetchAll(PDO::FETCH_ASSOC));
        } catch (\Throwable) {
            return []; // table may not exist yet (pre-migration)
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private function formatUserRow(array $r): array
    {
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        $online = false;
        if (!empty($r['last_seen_at'])) {
            $online = (time() - strtotime((string) $r['last_seen_at'])) <= self::ONLINE_WINDOW_SECONDS;
        }
        $out = [
            'id' => $r['id'],
            'email' => $r['email'],
            'name' => $r['name'],
            'plan' => $r['plan'] ?? 'personal',
            'cloudUntil' => $r['cloud_until'] ?? null,
            'isAdmin' => (bool) ($r['is_admin'] ?? false),
            'isDemo' => strtolower((string) $r['email']) === $demoEmail,
            'createdAt' => $r['created_at'] ?? null,
            'lastSeenAt' => $r['last_seen_at'] ?? null,
            'online' => $online,
        ];
        // Present only on queries that select it (the user-detail overview).
        if (array_key_exists('mfa_enabled', $r)) {
            $out['mfaEnabled'] = (bool) $r['mfa_enabled'];
        }
        // Advisory for the admin UI; enforcement always re-reads the column (RuntimeEngineService).
        if (array_key_exists('code_trust_verified_at', $r)) {
            $out['codeTrustVerified'] = !empty($r['code_trust_verified_at']);
            $out['codeTrustVerifiedAt'] = $r['code_trust_verified_at'] ?: null;
        }
        if (array_key_exists('code_trust_verified_by', $r)) {
            $out['codeTrustVerifiedBy'] = $r['code_trust_verified_by'] ?: null;
        }
        foreach (['apps_count' => 'appsCount', 'forms_count' => 'formsCount', 'flows_count' => 'flowsCount', 'responses_count' => 'responsesCount'] as $src => $dst) {
            if (array_key_exists($src, $r)) {
                $out[$dst] = (int) $r[$src];
            }
        }
        return $out;
    }

    private function formatNotice(array $r): array
    {
        return [
            'id' => $r['id'],
            'message' => $r['message'],
            'level' => $r['level'],
            'audience' => $r['audience'],
            'createdBy' => $r['created_by'],
            'createdAt' => $r['created_at'],
            'expiresAt' => $r['expires_at'],
            'revokedAt' => $r['revoked_at'],
            'active' => $r['revoked_at'] === null && ($r['expires_at'] === null || strtotime((string) $r['expires_at']) > time()),
        ];
    }

    private function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
