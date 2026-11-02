<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Support\Environment;
use PDO;

/**
 * An app's age gate, and the receipts that open it (docs/AGE_GATE_AND_SITE_AI.md).
 *
 * An app opts in with settings.ageGate = {minimumAge, assurance}. Its members then need a receipt
 * for at least that age, made by a method at least that strong, before any of the app's data or
 * code reaches them; the app's owner never does. A receipt is the member's, on this site: who,
 * which age, how it was checked, when, until when. Never a date of birth, a picture or an
 * estimate. Apps learn that a member passed, and nothing else.
 */
final class AccessGateService
{
    /** How strongly a method establishes an age, weakest first. An app asks for one of these. */
    public const ASSURANCE = ['declared' => 1, 'estimated' => 2, 'verified' => 3];

    /** The method each assurance level is reached by in this release. */
    public const METHODS = ['self_declaration' => 'declared'];

    public const MIN_AGE = 13;
    public const MAX_AGE = 120;
    public const REFUSED = 'age_verification_required';
    public const SIGN_IN = 'sign_in_required';

    private PDO $pdo;

    public function __construct(MySQLConnection $mysql)
    {
        $this->pdo = $mysql->getConnection();
    }

    /**
     * settings.ageGate as stored: {minimumAge: 13..120, assurance: one of ASSURANCE}, or null to
     * turn the gate off. Anything else is null too, as the other enumerated settings are dropped.
     */
    public static function normalizeSetting(mixed $value): ?array
    {
        if (!is_array($value)) {
            return null;
        }
        $age = $value['minimumAge'] ?? null;
        if (!is_int($age) || $age < self::MIN_AGE || $age > self::MAX_AGE) {
            return null;
        }
        $assurance = $value['assurance'] ?? 'declared';
        if (!is_string($assurance) || !isset(self::ASSURANCE[$assurance])) {
            return null;
        }
        return ['minimumAge' => $age, 'assurance' => $assurance];
    }

    /** The app's requirement, or null when it has none. */
    public function requirementOf(array $app): ?array
    {
        $settings = $app['settings'] ?? null;
        return is_array($settings) ? self::normalizeSetting($settings['ageGate'] ?? null) : null;
    }

    /**
     * Null when $userId may use $app; otherwise the refusal to send, as [status, body].
     * $verifyPath is where on the main site the member confirms their age.
     */
    public function decide(array $app, ?string $userId): ?array
    {
        $requirement = $this->requirementOf($app);
        if ($requirement === null) {
            return null;
        }
        // A gated app is for signed-in members: there is nobody to attach a check to otherwise.
        if ($userId === null || $userId === '') {
            return [401, [
                'error' => true,
                'code' => self::SIGN_IN,
                'message' => 'Sign in to use this app.',
                'ageGate' => $this->describe($app, $requirement, false),
            ]];
        }
        if (($app['ownerId'] ?? null) === $userId || $this->satisfies($userId, $requirement)) {
            return null;
        }
        return [403, [
            'error' => true,
            'code' => self::REFUSED,
            'message' => sprintf('This app is for people aged %d and over. Confirm your age to open it.', $requirement['minimumAge']),
            'ageGate' => $this->describe($app, $requirement, false),
        ]];
    }

    /** What a page needs to say about the gate: the requirement, whether it is met, and where to meet it. */
    public function describe(array $app, array $requirement, bool $satisfied): array
    {
        return [
            'minimumAge' => $requirement['minimumAge'],
            'assurance' => $requirement['assurance'],
            'satisfied' => $satisfied,
            'verifyPath' => '/verify/age?app=' . rawurlencode((string) ($app['slug'] ?? '')),
        ];
    }

    /** @var array<string, array{owner: string, requirement: ?array}> the apps looked up in this request */
    private array $apps = [];
    /** @var array<string, bool> receipts looked up in this request, by user and requirement */
    private array $met = [];

    /**
     * Whether $userId may act as a member of the app $appId: true unless the app has a gate this
     * member, not its owner, has not met. AppUserService asks this before every permission, so a
     * path that reaches an app by id rather than by slug (the member's app list and detail, Aokie
     * Companion, the MCP grants) gives an unverified member nothing as well.
     */
    public function admitsMember(string $appId, string $userId): bool
    {
        if (!isset($this->apps[$appId])) {
            $stmt = $this->pdo->prepare('SELECT owner_id, settings FROM apps WHERE id = ?');
            $stmt->execute([$appId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            $settings = is_array($row) ? json_decode((string) ($row['settings'] ?? ''), true) : null;
            $this->apps[$appId] = [
                'owner' => is_array($row) ? (string) $row['owner_id'] : '',
                'requirement' => is_array($settings) ? self::normalizeSetting($settings['ageGate'] ?? null) : null,
            ];
        }
        ['owner' => $owner, 'requirement' => $requirement] = $this->apps[$appId];
        if ($requirement === null || $owner === $userId) {
            return true;
        }
        $key = $userId . '|' . $requirement['minimumAge'] . '|' . $requirement['assurance'];
        return $this->met[$key] ??= $this->satisfies($userId, $requirement);
    }

    /** The gate as $userId sees it on $app, or null when the app has none. */
    public function statusFor(array $app, ?string $userId): ?array
    {
        $requirement = $this->requirementOf($app);
        if ($requirement === null) {
            return null;
        }
        $satisfied = $userId !== null && $userId !== ''
            && (($app['ownerId'] ?? null) === $userId || $this->satisfies($userId, $requirement));
        return $this->describe($app, $requirement, $satisfied);
    }

    /** A live receipt for at least this age, by a method at least this strong. */
    public function satisfies(string $userId, array $requirement): bool
    {
        $strong = array_keys(array_filter(self::ASSURANCE, fn(int $rank) => $rank >= self::ASSURANCE[$requirement['assurance']]));
        $marks = implode(',', array_fill(0, count($strong), '?'));
        $stmt = $this->pdo->prepare(
            "SELECT 1 FROM access_receipts
             WHERE user_id = ? AND kind = 'age' AND minimum_age >= ? AND assurance IN ({$marks})
               AND revoked_at IS NULL AND expires_at > ?
             LIMIT 1"
        );
        $stmt->execute([$userId, $requirement['minimumAge'], ...$strong, gmdate('Y-m-d H:i:s')]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * The methods this site offers that meet $requirement, strongest needed first. Self-declaration
     * is on unless AGE_GATE_SELF_DECLARATION=false, and meets only an app that asks for 'declared'.
     */
    public function methodsFor(array $requirement): array
    {
        $methods = [];
        foreach (self::METHODS as $method => $assurance) {
            if (self::ASSURANCE[$assurance] < self::ASSURANCE[$requirement['assurance']]) {
                continue;
            }
            if ($method === 'self_declaration' && strtolower((string) Environment::nonEmpty('AGE_GATE_SELF_DECLARATION', 'true')) === 'false') {
                continue;
            }
            $methods[] = $method;
        }
        return $methods;
    }

    /** How long a receipt lasts: AGE_GATE_RECEIPT_DAYS, 1 to 3650, a year by default. */
    public static function receiptDays(): int
    {
        $days = filter_var(Environment::nonEmpty('AGE_GATE_RECEIPT_DAYS'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 3650]]);
        return $days === false ? 365 : $days;
    }

    /** Record a pass. The caller has checked the method; this records what it established. */
    public function issue(string $userId, int $minimumAge, string $method, ?string $verifier = null): array
    {
        $assurance = self::METHODS[$method] ?? null;
        if ($assurance === null || $minimumAge < self::MIN_AGE || $minimumAge > self::MAX_AGE) {
            throw new \InvalidArgumentException('Unknown method or age');
        }
        $id = bin2hex(random_bytes(16));
        $now = time();
        $receipt = [
            'id' => $id,
            'kind' => 'age',
            'minimumAge' => $minimumAge,
            'assurance' => $assurance,
            'method' => $method,
            'verifier' => $verifier,
            'issuedAt' => gmdate('Y-m-d H:i:s', $now),
            'expiresAt' => gmdate('Y-m-d H:i:s', $now + self::receiptDays() * 86400),
        ];
        $this->pdo->prepare(
            'INSERT INTO access_receipts (id, user_id, kind, minimum_age, assurance, method, verifier, issued_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$id, $userId, 'age', $minimumAge, $assurance, $method, $verifier, $receipt['issuedAt'], $receipt['expiresAt']]);
        $this->met = [];
        return $receipt;
    }

    /** The member's receipts, newest first, revoked and expired ones included so they can see them. */
    public function receiptsFor(string $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, kind, minimum_age, assurance, method, issued_at, expires_at, revoked_at
             FROM access_receipts WHERE user_id = ? ORDER BY issued_at DESC LIMIT 100'
        );
        $stmt->execute([$userId]);
        $now = gmdate('Y-m-d H:i:s');
        return array_map(fn(array $row) => [
            'id' => $row['id'],
            'kind' => $row['kind'],
            'minimumAge' => (int) $row['minimum_age'],
            'assurance' => $row['assurance'],
            'method' => $row['method'],
            'issuedAt' => $row['issued_at'],
            'expiresAt' => $row['expires_at'],
            'revokedAt' => $row['revoked_at'],
            'live' => $row['revoked_at'] === null && $row['expires_at'] > $now,
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** Withdraw one of the member's own receipts. False when there is no such live receipt of theirs. */
    public function revoke(string $userId, string $receiptId): bool
    {
        $stmt = $this->pdo->prepare('UPDATE access_receipts SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL');
        $stmt->execute([gmdate('Y-m-d H:i:s'), $receiptId, $userId]);
        $this->met = [];
        return $stmt->rowCount() === 1;
    }
}
