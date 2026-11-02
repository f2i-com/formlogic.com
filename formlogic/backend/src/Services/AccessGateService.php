<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Passes, and the apps that require them (docs/AGE_GATE_AND_SITE_AI.md).
 *
 * An app opts in with settings.requires: a list of {plugin, kind, min, strength}, each naming the
 * plugin whose pass it accepts. Its members then need a live pass from that plugin, of that kind,
 * for at least that value, by a method at least that strong, before any of the app's data or code
 * reaches them; the owner never does. How a pass is earned is the plugin's (PluginService): this
 * only records what an enabled plugin issued within its grant, and checks it, a lookup cheap
 * enough for every request. A pass keeps who, which plugin, what for, the value, how strongly and
 * until when; never a date of birth, a picture or an estimate. Apps learn "passed" and nothing else.
 */
final class AccessGateService
{
    /** How strongly a method establishes a value, weakest first. A requirement asks for one of these. */
    public const ASSURANCE = ['declared' => 1, 'estimated' => 2, 'verified' => 3];
    public const MAX_REQUIREMENTS = 4;
    public const REFUSED = 'pass_required';
    public const UNAVAILABLE = 'plugin_unavailable';
    public const SIGN_IN = 'sign_in_required';

    private PDO $pdo;
    /** @var array<string, array{owner: string, requirements: array}> the apps looked up in this request */
    private array $apps = [];
    /** @var array<string, bool> passes looked up in this request */
    private array $met = [];

    public function __construct(MySQLConnection $mysql, private ?PluginService $plugins = null)
    {
        $this->pdo = $mysql->getConnection();
    }

    public function usePlugins(?PluginService $plugins): void
    {
        $this->plugins = $plugins;
    }

    /**
     * settings.requires as stored: at most four {plugin, kind, min, strength}, one a plugin and kind.
     * Anything malformed is dropped, as the other enumerated settings are. Whether the plugin is
     * installed is not checked here: an app keeps its requirement, and is closed while it is not.
     */
    public static function normalizeRequirements(mixed $value): array
    {
        if (!is_array($value) || !array_is_list($value)) {
            return [];
        }
        $out = [];
        foreach (array_slice($value, 0, self::MAX_REQUIREMENTS) as $requirement) {
            if (!is_array($requirement)) {
                continue;
            }
            $plugin = $requirement['plugin'] ?? null;
            $kind = $requirement['kind'] ?? null;
            $min = $requirement['min'] ?? null;
            $strength = $requirement['strength'] ?? 'declared';
            if (!is_string($plugin) || !preg_match(PluginService::ID_PATTERN, $plugin) || !is_string($kind) || !preg_match('/^[a-z][a-z0-9_-]{0,15}$/D', $kind)
                || !is_int($min) || $min < 0 || $min > 65535 || !is_string($strength) || !isset(self::ASSURANCE[$strength])) {
                continue;
            }
            $out[$plugin . '|' . $kind] = ['plugin' => $plugin, 'kind' => $kind, 'min' => $min, 'strength' => $strength];
        }
        return array_values($out);
    }

    /** The app's requirements, or [] when it has none. */
    public function requirementsOf(array $app): array
    {
        $settings = $app['settings'] ?? null;
        return is_array($settings) ? self::normalizeRequirements($settings['requires'] ?? null) : [];
    }

    /**
     * Null when $userId may use $app; otherwise the refusal to send, as [status, body]. A
     * requirement whose plugin is off or gone refuses too: the app asked for it.
     */
    public function decide(array $app, ?string $userId): ?array
    {
        $requirements = $this->requirementsOf($app);
        if ($requirements === []) {
            return null;
        }
        // A gated app is for signed-in members: there is nobody to attach a pass to otherwise.
        if ($userId === null || $userId === '') {
            return [401, [
                'error' => true,
                'code' => self::SIGN_IN,
                'message' => 'Sign in to use this app.',
                'requirement' => $this->describe($app, $requirements[0], false),
            ]];
        }
        if (($app['ownerId'] ?? null) === $userId) {
            return null;
        }
        foreach ($requirements as $requirement) {
            $described = $this->describe($app, $requirement, false);
            if ($this->plugins?->grant($requirement['plugin'], $requirement['kind']) === null) {
                return [403, [
                    'error' => true,
                    'code' => self::UNAVAILABLE,
                    'message' => 'This app needs a plugin that is not available on this site at the moment. Ask the app\'s owner.',
                    'requirement' => $described,
                ]];
            }
            if (!$this->satisfies($userId, $requirement)) {
                return [403, [
                    'error' => true,
                    'code' => self::REFUSED,
                    'message' => self::sentence($described),
                    'requirement' => $described,
                ]];
            }
        }
        return null;
    }

    /** One requirement as a page shows it: what it asks, whether it is met, and where to meet it. */
    public function describe(array $app, array $requirement, bool $satisfied): array
    {
        $grant = $this->plugins?->grant($requirement['plugin'], $requirement['kind']);
        $plugin = $this->plugins?->find($requirement['plugin']);
        return [
            'plugin' => $requirement['plugin'],
            'pluginName' => $plugin['name'] ?? $requirement['plugin'],
            'kind' => $requirement['kind'],
            'label' => $grant['label'] ?? $requirement['kind'],
            'unit' => $grant['unit'] ?? '',
            'min' => $requirement['min'],
            'strength' => $requirement['strength'],
            'available' => $grant !== null,
            'satisfied' => $satisfied,
            'verifyPath' => '/plugins/' . rawurlencode($requirement['plugin']) . '/verify?app=' . rawurlencode((string) ($app['slug'] ?? ''))
                . '&kind=' . rawurlencode($requirement['kind']),
        ];
    }

    /** The app's requirements as $userId stands with each, or null when it has none. */
    public function statusFor(array $app, ?string $userId): ?array
    {
        $requirements = $this->requirementsOf($app);
        if ($requirements === []) {
            return null;
        }
        $owner = $userId !== null && $userId !== '' && ($app['ownerId'] ?? null) === $userId;
        $each = [];
        foreach ($requirements as $requirement) {
            $met = $owner || ($userId !== null && $userId !== '' && $this->plugins?->grant($requirement['plugin'], $requirement['kind']) !== null
                && $this->satisfies($userId, $requirement));
            $each[] = $this->describe($app, $requirement, $met);
        }
        return ['satisfied' => !in_array(false, array_column($each, 'satisfied'), true), 'requirements' => $each];
    }

    /** How a page says an unmet requirement, in words. An age pass reads as an age. */
    public static function sentence(array $described): string
    {
        if ($described['kind'] === 'age') {
            return sprintf('This app is for people aged %d and over. Confirm your age to open it.', $described['min']);
        }
        return sprintf('This app needs %s %d%s from %s.', $described['label'], $described['min'], $described['unit'] !== '' ? ' ' . $described['unit'] : '', $described['pluginName']);
    }

    /**
     * Whether $userId may act as a member of the app $appId: true unless it requires a pass this
     * member, not its owner, does not hold. AppUserService asks this before every permission, so a
     * path that reaches an app by id rather than by slug gives an unverified member nothing either.
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
                'requirements' => is_array($settings) ? self::normalizeRequirements($settings['requires'] ?? null) : [],
            ];
        }
        ['owner' => $owner, 'requirements' => $requirements] = $this->apps[$appId];
        // A plugin's own app has no members: nobody holds a permission on it by any path, so its
        // project changes only by installing it (PluginService).
        if ($owner === PluginService::SYSTEM_USER_ID) {
            return false;
        }
        if ($requirements === [] || $owner === $userId) {
            return true;
        }
        foreach ($requirements as $requirement) {
            if ($this->plugins?->grant($requirement['plugin'], $requirement['kind']) === null) {
                return false;
            }
            $key = $userId . '|' . implode('|', $requirement);
            if (!($this->met[$key] ??= $this->satisfies($userId, $requirement))) {
                return false;
            }
        }
        return true;
    }

    /** A live pass from the requirement's plugin, of its kind, for at least its value, by a method at least as strong. */
    public function satisfies(string $userId, array $requirement): bool
    {
        $strong = array_keys(array_filter(self::ASSURANCE, fn(int $rank) => $rank >= self::ASSURANCE[$requirement['strength']]));
        $marks = implode(',', array_fill(0, count($strong), '?'));
        $stmt = $this->pdo->prepare(
            "SELECT 1 FROM access_receipts
             WHERE user_id = ? AND plugin_id = ? AND kind = ? AND minimum_age >= ? AND assurance IN ({$marks})
               AND revoked_at IS NULL AND expires_at > ?
             LIMIT 1"
        );
        $stmt->execute([$userId, $requirement['plugin'], $requirement['kind'], $requirement['min'], ...$strong, gmdate('Y-m-d H:i:s')]);
        return $stmt->fetchColumn() !== false;
    }

    /** How long a pass lasts: PLUGIN_PASS_DAYS, 1 to 3650, a year by default. */
    public static function receiptDays(): int
    {
        $days = filter_var(\FormLogic\Support\Environment::nonEmpty('PLUGIN_PASS_DAYS'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 3650]]);
        return $days === false ? 365 : $days;
    }

    /**
     * A plugin backend's answer, as it goes back to the plugin's page (NativeAppController). On the
     * POST route the plugin's manifest names for a kind of pass, a success whose body carries
     * `pass` records it for $userId, the signed-in person who asked, held to the grant
     * (issueFromPlugin). Nothing is recorded from any other route or method, from an answer that is
     * not a success, or for anyone the body names; a pass out of its grant is refused. The page gets
     * the answer without `pass`, and `recorded` when one was.
     */
    public function recordFromPluginAnswer(array $plugin, string $userId, string $method, string $path, array $result): array
    {
        $body = $result['body'] ?? null;
        $pass = is_object($body) && property_exists($body, 'pass') ? $body->pass : (is_array($body) ? ($body['pass'] ?? null) : null);
        if (is_object($body)) unset($body->pass);
        if (is_array($body)) unset($body['pass']);
        $result['body'] = $body;
        $grant = null;
        foreach ($method === 'POST' ? $plugin['grants'] : [] as $candidate) {
            if (($candidate['issueRoute'] ?? null) === $path) $grant = $candidate;
        }
        $status = (int) ($result['status'] ?? 0);
        if ($grant === null || $pass === null || $status < 200 || $status > 299 || $userId === '' || !$plugin['enabled']) {
            return $result;
        }
        // The grant as it stands now, not as the caller read it: turned off since is off.
        $live = $this->plugins?->grant($plugin['manifestId'], $grant['kind']);
        if ($live === null) {
            throw new \InvalidArgumentException('This plugin is turned off on this site.');
        }
        $receipt = $this->issueFromPlugin($live, $plugin['manifestId'], $userId, $pass);
        $recorded = ['kind' => $receipt['kind'], 'value' => $receipt['value'], 'strength' => $receipt['strength'], 'expiresAt' => $receipt['expiresAt']];
        if (is_object($body)) $body->recorded = $recorded; else $result['body'] = (array) $body + ['recorded' => $recorded];
        return $result;
    }

    /**
     * Record a pass a plugin's backend answered with, for the person who asked it, held to what the
     * plugin was granted: a kind it declared, a strength it was granted, a value in its range. The
     * caller (recordFromPluginAnswer) has checked the route is the one that kind is issued on.
     */
    public function issueFromPlugin(array $grant, string $pluginId, string $userId, mixed $pass): array
    {
        if (!is_object($pass) && !is_array($pass)) {
            throw new \InvalidArgumentException('The plugin answered with no pass.');
        }
        $pass = (array) $pass;
        $kind = $pass['kind'] ?? null;
        $value = $pass['value'] ?? null;
        $strength = $pass['strength'] ?? null;
        if ($kind !== $grant['kind'] || !is_int($value) || $value < $grant['min'] || $value > $grant['max']
            || !is_string($strength) || !in_array($strength, $grant['strengths'], true)) {
            throw new \InvalidArgumentException('The plugin answered with a pass it may not issue.');
        }
        $method = is_string($pass['method'] ?? null) && preg_match('/^[a-z][a-z0-9_]{0,31}$/D', $pass['method']) ? $pass['method'] : 'plugin';
        $id = bin2hex(random_bytes(16));
        $now = time();
        $receipt = [
            'id' => $id,
            'plugin' => $pluginId,
            'kind' => $kind,
            'value' => $value,
            'strength' => $strength,
            'method' => $method,
            'issuedAt' => gmdate('Y-m-d H:i:s', $now),
            'expiresAt' => gmdate('Y-m-d H:i:s', $now + self::receiptDays() * 86400),
        ];
        $this->pdo->prepare(
            'INSERT INTO access_receipts (id, user_id, plugin_id, kind, minimum_age, assurance, method, verifier, issued_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)'
        )->execute([$id, $userId, $pluginId, $kind, $value, $strength, $method, $receipt['issuedAt'], $receipt['expiresAt']]);
        $this->met = [];
        return $receipt;
    }

    /** The member's passes, newest first, revoked and expired ones included so they can see them. */
    public function receiptsFor(string $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, plugin_id, kind, minimum_age, assurance, method, issued_at, expires_at, revoked_at
             FROM access_receipts WHERE user_id = ? ORDER BY issued_at DESC LIMIT 100'
        );
        $stmt->execute([$userId]);
        $now = gmdate('Y-m-d H:i:s');
        return array_map(function (array $row) use ($now) {
            $grant = $this->plugins?->grant((string) $row['plugin_id'], (string) $row['kind']);
            return [
                'id' => $row['id'],
                'plugin' => $row['plugin_id'],
                'pluginName' => $this->plugins?->find((string) $row['plugin_id'])['name'] ?? $row['plugin_id'],
                'kind' => $row['kind'],
                'label' => $grant['label'] ?? $row['kind'],
                'value' => (int) $row['minimum_age'],
                'strength' => $row['assurance'],
                'method' => $row['method'],
                'issuedAt' => $row['issued_at'],
                'expiresAt' => $row['expires_at'],
                'revokedAt' => $row['revoked_at'],
                'live' => $row['revoked_at'] === null && $row['expires_at'] > $now,
            ];
        }, $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** Withdraw one of the member's own passes. False when there is no such live pass of theirs. */
    public function revoke(string $userId, string $receiptId): bool
    {
        $stmt = $this->pdo->prepare('UPDATE access_receipts SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL');
        $stmt->execute([gmdate('Y-m-d H:i:s'), $receiptId, $userId]);
        $this->met = [];
        return $stmt->rowCount() === 1;
    }
}
