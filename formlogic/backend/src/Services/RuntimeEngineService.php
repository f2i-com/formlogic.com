<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Which client engine an embedded Softn app runs on, decided by the SERVER on every runtime GET.
 *
 * Three ids: 'zipp-web-python' (the ZIPP wasm VM this install ships, and the universal fallback),
 * 'zipp-web' (the JavaScript-only ZIPP variant) and 'host-js' (no VM — the author's code runs as
 * host JavaScript inside the sandboxed, opaque-origin frame). host-js is an explicit transfer of
 * trust to the app OWNER, so it is allowed only for an account an admin marked code-trust verified
 * (AdminService::setCodeTrust) and only when the installed runtime advertises it.
 *
 * Three inputs, all re-read per call (the responses are no-store, so a revocation or a policy
 * change applies at the app's next load with no data migration):
 *   - apps.client_engine — the owner's stored choice, NULL = the site default;
 *   - users.code_trust_verified_at of apps.owner_id;
 *   - the site policy in system_meta 'client_engine_policy'.
 * Nothing is read from the client, the package/native manifest, permission.json or apps.settings.
 *
 * Everything fails closed to zipp-web-python: a missing or corrupt policy row, an install record
 * that does not advertise an engine, an owner who is not verified. host-js became effective when
 * the installed hosted runtime began advertising it (its second entry document, host.html) and
 * the frame learned to mount that document; zipp-web is still advertised by no runtime, so it
 * still resolves to the fallback with reason 'not-installed'.
 */
class RuntimeEngineService
{
    public const ZIPP_WEB_PYTHON = 'zipp-web-python';
    public const ZIPP_WEB = 'zipp-web';
    public const HOST_JS = 'host-js';

    /** Every engine id this server knows. */
    public const ENGINES = [self::ZIPP_WEB_PYTHON, self::ZIPP_WEB, self::HOST_JS];
    /** Engines that run author code inside the ZIPP VM; a fallback is always one of these. */
    public const ZIPP_ENGINES = [self::ZIPP_WEB_PYTHON, self::ZIPP_WEB];
    /** The one engine that can never be removed from the allow-list: it is the universal fallback. */
    public const REQUIRED_ENGINE = self::ZIPP_WEB_PYTHON;

    public const POLICY_KEY = 'client_engine_policy';

    /** Why the effective engine is not the requested one. */
    public const REASON_POLICY = 'policy';
    public const REASON_UNVERIFIED = 'unverified';
    public const REASON_NOT_INSTALLED = 'not-installed';
    public const REASON_PYTHON_REQUIRED = 'python-required';

    private PDO $mysql;
    /** Memoized: installedEngines() is read on every runtime GET and every action. */
    private ?array $installed = null;

    public function __construct(MySQLConnection $mysql, private ?string $provenancePath = null)
    {
        $this->mysql = $mysql->getConnection();
        $this->provenancePath ??= dirname(__DIR__, 2) . '/resources/softn-native/provenance.json';
    }

    /** Today's behaviour, and what a missing or invalid policy row falls back to. */
    public static function defaults(): array
    {
        return [
            'revision' => 0,
            'default' => self::ZIPP_WEB_PYTHON,
            'allowed' => [self::ZIPP_WEB_PYTHON],
            'hostJsRequireWorker' => false,
        ];
    }

    /**
     * The site policy. A missing row, unreadable JSON or any value outside the rules is the
     * fail-closed default — an admin sees their policy has not taken effect rather than an
     * install silently widening what owners may choose (PlatformPlansService::status discipline).
     */
    public function readPolicy(): array
    {
        try {
            $stmt = $this->mysql->prepare('SELECT meta_value FROM system_meta WHERE meta_key = :k');
            $stmt->execute(['k' => self::POLICY_KEY]);
            $raw = $stmt->fetchColumn();
            if (!is_string($raw) || $raw === '') {
                return self::defaults();
            }
            return self::validatePolicy(json_decode($raw, true, 8, JSON_THROW_ON_ERROR));
        } catch (\Throwable) {
            return self::defaults();
        }
    }

    /**
     * Replace the policy. The revision is the server's, not the caller's: it only ever goes up, so
     * a frame carrying an older engine revision can be told to remount. Runs inside the caller's
     * transaction when there is one (the audit row and the policy commit together).
     *
     * @throws \InvalidArgumentException on any rule violation
     */
    public function writePolicy(array $policy): array
    {
        $next = self::validatePolicy($policy + ['revision' => 0]);
        $next['revision'] = $this->readPolicy()['revision'] + 1;
        $stmt = $this->mysql->prepare(
            'INSERT INTO system_meta (meta_key, meta_value) VALUES (:k, :v)
             ON DUPLICATE KEY UPDATE meta_value = :v2'
        );
        $json = json_encode($next, JSON_THROW_ON_ERROR);
        $stmt->execute(['k' => self::POLICY_KEY, 'v' => $json, 'v2' => $json]);
        return $next;
    }

    /**
     * writePolicy plus its audit row, in one transaction: the policy decides which owners may run
     * code outside the VM, so it must never change without a record of who changed it to what.
     *
     * @throws \InvalidArgumentException on any rule violation
     */
    public function writePolicyAudited(array $policy, AuditService $audit, ?string $userId, ?string $ipAddress): array
    {
        $previous = $this->readPolicy();
        $ownsTx = !$this->mysql->inTransaction();
        if ($ownsTx) {
            $this->mysql->beginTransaction();
        }
        try {
            $next = $this->writePolicy($policy);
            $audit->logStrict('admin.engine_policy_update', 'platform', null, $userId, $ipAddress, [
                'previous' => $previous,
                'next' => $next,
            ]);
            if ($ownsTx) {
                $this->mysql->commit();
            }
            return $next;
        } catch (\Throwable $e) {
            if ($ownsTx && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * @throws \InvalidArgumentException
     */
    public static function validatePolicy(mixed $data): array
    {
        if (!is_array($data)) {
            throw new \InvalidArgumentException('The engine policy must be an object.');
        }
        $allowed = $data['allowed'] ?? null;
        if (!is_array($allowed) || !array_is_list($allowed) || $allowed === []) {
            throw new \InvalidArgumentException('allowed must be a non-empty list of engine ids.');
        }
        $clean = [];
        foreach ($allowed as $engine) {
            if (!is_string($engine) || !in_array($engine, self::ENGINES, true)) {
                throw new \InvalidArgumentException('allowed may only contain: ' . implode(', ', self::ENGINES) . '.');
            }
            $clean[$engine] = true;
        }
        // The universal fallback. Without it a later policy edit could leave apps with no engine.
        if (!isset($clean[self::REQUIRED_ENGINE])) {
            throw new \InvalidArgumentException(self::REQUIRED_ENGINE . ' cannot be removed from the allowed engines.');
        }
        $default = $data['default'] ?? null;
        if (!is_string($default) || !in_array($default, self::ZIPP_ENGINES, true)) {
            throw new \InvalidArgumentException('The site default must be a ZIPP engine: ' . implode(' or ', self::ZIPP_ENGINES) . '.');
        }
        if (!isset($clean[$default])) {
            throw new \InvalidArgumentException('The site default must be one of the allowed engines.');
        }
        $revision = $data['revision'] ?? 0;
        if (!is_int($revision) || $revision < 0) {
            throw new \InvalidArgumentException('revision must be a non-negative integer.');
        }
        $requireWorker = $data['hostJsRequireWorker'] ?? false;
        if (!is_bool($requireWorker)) {
            throw new \InvalidArgumentException('hostJsRequireWorker must be a boolean.');
        }
        return [
            'revision' => $revision,
            'default' => $default,
            // Sorted by the canonical id order so the stored JSON (and the revision) is stable.
            'allowed' => array_values(array_filter(self::ENGINES, static fn (string $e) => isset($clean[$e]))),
            'hostJsRequireWorker' => $requireWorker,
        ];
    }

    /**
     * The engines the INSTALLED hosted runtime advertises, from the native runtime's
     * provenance.json — the one file fetch-softn-release.mjs stamps from the release archive, so
     * it names what this install actually serves rather than what a web root happens to contain.
     * Field path: hostedRuntime.engines. Absent (every install from before that stamp), empty,
     * malformed or not naming zipp-web-python at all: the record says nothing trustworthy, so the
     * answer is the fallback alone.
     *
     * @return list<string>
     */
    public function installedEngines(): array
    {
        if ($this->installed !== null) {
            return $this->installed;
        }
        $record = null;
        if (is_string($this->provenancePath) && is_file($this->provenancePath)) {
            $record = json_decode((string) @file_get_contents($this->provenancePath), true);
        }
        return $this->installed = self::enginesFromRecord($record);
    }

    /**
     * @return list<string>
     */
    public static function enginesFromRecord(mixed $record): array
    {
        $engines = is_array($record) && is_array($record['hostedRuntime'] ?? null)
            ? ($record['hostedRuntime']['engines'] ?? null)
            : null;
        if (!is_array($engines) || !array_is_list($engines)) {
            return [self::REQUIRED_ENGINE];
        }
        $known = [];
        foreach ($engines as $engine) {
            // An id this server does not know is dropped, not fatal: a newer runtime may advertise
            // engines a later FormLogic adds.
            if (is_string($engine) && in_array($engine, self::ENGINES, true)) {
                $known[$engine] = true;
            }
        }
        // A record that does not name the fallback is not a record of this runtime.
        if (!isset($known[self::REQUIRED_ENGINE])) {
            return [self::REQUIRED_ENGINE];
        }
        return array_values(array_filter(self::ENGINES, static fn (string $e) => isset($known[$e])));
    }

    /**
     * The engine one app runs on. $languages names the logic languages the app needs (empty today:
     * no Softn app declares Python yet).
     *
     * @return array{id: string, requested: string, stored: string|null, reason?: string, revision: string}
     */
    public function effective(string $appId, array $languages = []): array
    {
        $stmt = $this->mysql->prepare(
            'SELECT a.client_engine, u.email AS owner_email, u.code_trust_verified_at
             FROM apps a LEFT JOIN users u ON u.id = a.owner_id
             WHERE a.id = :id'
        );
        $stmt->execute(['id' => $appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        return self::resolve(
            is_string($row['client_engine'] ?? null) ? $row['client_engine'] : null,
            $this->readPolicy(),
            $this->installedEngines(),
            self::ownerOf($row),
            $languages
        );
    }

    /**
     * The app owner's verification and demo status. An app with no owner row reads as unverified.
     *
     * @return array{verifiedAt: string|null, isDemo: bool}
     */
    public function ownerFacts(string $appId): array
    {
        $stmt = $this->mysql->prepare(
            'SELECT u.email AS owner_email, u.code_trust_verified_at
             FROM apps a LEFT JOIN users u ON u.id = a.owner_id WHERE a.id = :id'
        );
        $stmt->execute(['id' => $appId]);
        return self::ownerOf($stmt->fetch(PDO::FETCH_ASSOC) ?: []);
    }

    /**
     * Store an owner's engine choice (NULL = the site default) and record it, in one transaction.
     * The column is written ONLY here: it is deliberately absent from updateApp, sanitizeAppSettings,
     * packs, backups, the MCP merge and the admin acting-as allowlist, so nothing can replay or
     * import it.
     *
     * @return array{id: string, requested: string, stored: string|null, reason?: string, revision: string}
     * @throws \InvalidArgumentException when the choice would never take effect
     */
    public function storeChoice(string $appId, ?string $engine, AuditService $audit, ?string $userId, ?string $ipAddress): array
    {
        $owner = $this->ownerFacts($appId);
        $refusal = $this->refuseChoice($engine, $owner);
        if ($refusal !== null) {
            throw new \InvalidArgumentException($refusal);
        }
        $ownsTx = !$this->mysql->inTransaction();
        if ($ownsTx) {
            $this->mysql->beginTransaction();
        }
        try {
            $read = $this->mysql->prepare('SELECT client_engine FROM apps WHERE id = :id');
            $read->execute(['id' => $appId]);
            $from = $read->fetchColumn();
            $this->mysql->prepare('UPDATE apps SET client_engine = :e WHERE id = :id')
                ->execute(['e' => $engine, 'id' => $appId]);
            $effective = self::resolve($engine, $this->readPolicy(), $this->installedEngines(), $owner);
            $audit->logStrict('app.engine_change', 'app', $appId, $userId, $ipAddress, [
                'from' => is_string($from) ? $from : null,
                'to' => $engine,
                'effective' => $effective['id'],
                'reason' => $effective['reason'] ?? null,
            ]);
            if ($ownsTx) {
                $this->mysql->commit();
            }
            return $effective;
        } catch (\Throwable $e) {
            if ($ownsTx && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Whether a parent's X-FormLogic-Client-Engine header still matches what the server would
     * decide now. Absent (an older page, or a request that is not from a frame) is not a mismatch:
     * the header grants nothing, it only lets a page that loaded before a revocation be told to
     * remount instead of finishing the session on a relaxed frame.
     */
    public static function headerMatches(string $header, array $effective): bool
    {
        if ($header === '') {
            return true;
        }
        [$id, $revision] = array_pad(explode(';', $header, 2), 2, '');
        return $id === $effective['id'] && $revision === $effective['revision'];
    }

    /**
     * The owner facts the resolver needs, from a row that selected email + code_trust_verified_at.
     *
     * @return array{verifiedAt: string|null, isDemo: bool}
     */
    public static function ownerOf(array $row): array
    {
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        $verifiedAt = $row['code_trust_verified_at'] ?? null;
        return [
            'verifiedAt' => is_string($verifiedAt) && $verifiedAt !== '' ? $verifiedAt : null,
            'isDemo' => strtolower((string) ($row['owner_email'] ?? $row['email'] ?? '')) === $demoEmail,
        ];
    }

    /**
     * The whole decision, as a pure function of the four inputs, so the write endpoint and the
     * read path cannot drift apart.
     *
     * `revision` changes whenever any input does; the parent sends it back on an action
     * (X-FormLogic-Client-Engine) and a mismatch answers 409 engine_changed, so a page that was
     * loaded before a revocation is told to remount rather than keeping a relaxed frame.
     *
     * @param array{verifiedAt: string|null, isDemo: bool} $owner
     * @param list<string> $installed
     * @param list<string> $languages
     * @return array{id: string, requested: string, stored: string|null, reason?: string, revision: string}
     */
    public static function resolve(?string $stored, array $policy, array $installed, array $owner, array $languages = []): array
    {
        $fallback = in_array($policy['default'] ?? '', self::ZIPP_ENGINES, true) && in_array($policy['default'], $installed, true)
            ? (string) $policy['default']
            : self::REQUIRED_ENGINE;
        $requested = $stored ?? (is_string($policy['default'] ?? null) ? $policy['default'] : self::REQUIRED_ENGINE);
        $allowed = is_array($policy['allowed'] ?? null) ? $policy['allowed'] : [self::REQUIRED_ENGINE];

        $id = $requested;
        $reason = null;
        if (!in_array($requested, self::ENGINES, true) || !in_array($requested, $allowed, true)) {
            $id = $fallback;
            $reason = self::REASON_POLICY;
        } elseif ($requested === self::HOST_JS && ($owner['verifiedAt'] === null || $owner['isDemo'])) {
            // Enforcement always reads the OWNER's verification, never the viewer's: a member of
            // someone else's app is not the account that was trusted with host JavaScript.
            $id = $fallback;
            $reason = self::REASON_UNVERIFIED;
        } elseif (!in_array($requested, $installed, true)) {
            $id = $fallback;
            $reason = self::REASON_NOT_INSTALLED;
        }

        // Python runs only on the web-python VM; no other engine can execute it at all. So this is
        // a clamp on the RESOLVED id, not another branch of the chain above: a fallback is only
        // "safe" for JavaScript, and a site whose default is zipp-web would otherwise hand a Python
        // bundle the JavaScript-only build whenever one of those branches fired. The clamp can only
        // ever produce zipp-web-python, which validatePolicy makes un-removable from `allowed` and
        // enginesFromRecord always reports as installed, so it can never name an engine the policy
        // forbids or the install does not serve.
        //
        // It also takes the reason: an owner looking at "runs on ZIPP (JavaScript and Python)" is
        // looking at it because the app needs Python, and that does not change when they fix their
        // policy or verification — the other reasons would then be answered and wrong.
        if (in_array('python', $languages, true) && $id !== self::ZIPP_WEB_PYTHON) {
            $id = self::ZIPP_WEB_PYTHON;
            $reason = self::REASON_PYTHON_REQUIRED;
        }

        $revision = substr(hash('sha256', implode('|', [
            (string) ($policy['revision'] ?? 0),
            (string) ($owner['verifiedAt'] ?? ''),
            (string) ($stored ?? ''),
            implode(',', $installed),
        ])), 0, 16);

        return ['id' => $id, 'requested' => $requested, 'stored' => $stored, 'revision' => $revision]
            + ($reason !== null ? ['reason' => $reason] : []);
    }

    /** What an owner may choose from, for the app-settings select (never the whole policy row). */
    public function ownerPolicy(): array
    {
        $policy = $this->readPolicy();
        return ['default' => $policy['default'], 'allowed' => $policy['allowed'], 'installed' => $this->installedEngines()];
    }

    /**
     * Whether an owner's choice may be STORED. Read-time clamping stays authoritative, so this
     * refuses only what would never take effect — a policy or verification refusal, which the
     * owner must resolve with their admin. An engine the installed runtime does not advertise yet
     * is deliberately storable: the install changes without the owner doing anything, and the
     * settings UI shows the effective engine with its reason meanwhile.
     *
     * @return string|null the refusal, or null when the choice is storable
     */
    public function refuseChoice(?string $engine, array $owner): ?string
    {
        if ($engine === null) {
            return null; // back to the site default
        }
        if (!in_array($engine, self::ENGINES, true)) {
            return 'Unknown engine. Choose one of: ' . implode(', ', self::ENGINES) . '.';
        }
        $policy = $this->readPolicy();
        if (!in_array($engine, $policy['allowed'], true)) {
            return 'This site does not allow that engine.';
        }
        if ($engine === self::HOST_JS && ($owner['verifiedAt'] === null || $owner['isDemo'])) {
            return 'Host JavaScript is only available to accounts an administrator has verified for code trust.';
        }
        return null;
    }
}
