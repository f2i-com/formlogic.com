<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * In-place upgrades through the admin panel: upload the CI-built release zip
 * (built UI at the zip root, backend under api/, manifest.json with sha256s),
 * validate + stage it, auto-export the MySQL database, snapshot the current
 * code, apply the new files, and roll back from the snapshot if needed.
 *
 * DATA SAFETY INVARIANTS (the reason this class exists):
 *  - api/.env, api/storage/** (per-form SQLite databases, uploads, packs) and
 *    api/logs/** are NEVER written by apply/rollback — every copy filters them
 *    on BOTH the source and destination side (see PROTECTED_API_PATHS).
 *  - the MySQL database is exported to a backup BEFORE any apply.
 *  - maintenance mode is enabled around an apply so nothing writes mid-swap.
 *  - schema migrations self-apply on the FIRST request served by the new code
 *    (MySQLConnection::ensureSchemaCurrent md5-stamps itself), so this class
 *    never runs new-version migrations from old loaded classes.
 */
class UpgradeService
{
    /** Paths (relative to the api root) an upgrade must never write or restore over. */
    private const PROTECTED_API_PATHS = ['.env', 'storage', 'logs'];

    /** Web-root entries never touched when applying the zip-root files (the api
     *  dir is handled by the api-side copy; on dev machines webRoot/api is a junction).
     *  `.well-known` is operator data (ACME challenges etc.) — never managed. */
    private const PROTECTED_WEB_PATHS = ['api', '.well-known'];

    /** Package files that live OUTSIDE the manifest inventory (the manifest
     *  cannot list itself; the signature envelope signs the manifest bytes). */
    private const MANIFEST_EXEMPT_FILES = ['manifest.json', 'manifest.sig.json', '.staged-info.json'];

    private PDO $pdo;
    /** Raw pinned Ed25519 release public key, or null when none is configured. */
    private ?string $releasePublicKeyRaw;
    /** Conspicuous development-only override — force-disabled in production. */
    private bool $allowUnsignedDev;
    private bool $production;

    public function __construct(
        private string $apiRoot,
        private MySQLConnection $mysql,
        private MaintenanceService $maintenance,
        ?string $releasePublicKeyB64 = null,
        ?bool $allowUnsigned = null,
        ?bool $isProduction = null,
    ) {
        $this->pdo = $mysql->getConnection();
        $keyB64 = $releasePublicKeyB64 ?? (string) ($_ENV['UPGRADE_RELEASE_PUBKEY'] ?? '');
        if ($keyB64 === '') {
            $this->releasePublicKeyRaw = null;
        } else {
            $raw = base64_decode($keyB64, true);
            if (!is_string($raw) || strlen($raw) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
                throw new \RuntimeException('UPGRADE_RELEASE_PUBKEY must be a base64 32-byte Ed25519 public key');
            }
            $this->releasePublicKeyRaw = $raw;
        }
        $this->production = $isProduction ?? ((string) ($_ENV['APP_ENV'] ?? '') === 'production');
        $override = $allowUnsigned
            ?? filter_var((string) ($_ENV['UPGRADE_ALLOW_UNSIGNED'] ?? ''), FILTER_VALIDATE_BOOLEAN);
        // The override can never be enabled in production, accidentally or not.
        $this->allowUnsignedDev = $override && !$this->production;
    }

    public static function defaultApiRoot(): string
    {
        return dirname(__DIR__, 2);
    }

    // ── layout + status ─────────────────────────────────────────────────────

    /**
     * Where this installation lives. 'deployed' = the packaged single-domain
     * layout (web root with index.html, backend under api/). 'dev' = a source
     * checkout (web root = ui/dist). Anything else is unsupported for apply.
     */
    public function layout(): array
    {
        $apiRoot = rtrim($this->apiRoot, '/\\');
        $webRoot = null;
        $mode = 'unknown';
        $override = (string) ($_ENV['FORMLOGIC_WEB_ROOT'] ?? '');
        if ($override !== '' && is_dir($override)) {
            $webRoot = realpath($override) ?: $override;
            $mode = 'env-override';
        } elseif (strtolower(basename($apiRoot)) === 'api' && is_file(dirname($apiRoot) . '/index.html')) {
            $webRoot = dirname($apiRoot);
            $mode = 'deployed';
        } elseif (is_file(dirname($apiRoot) . '/ui/dist/index.html')) {
            $webRoot = dirname($apiRoot) . '/ui/dist';
            $mode = 'dev';
        }
        return ['apiRoot' => $apiRoot, 'webRoot' => $webRoot, 'mode' => $mode, 'supported' => $webRoot !== null];
    }

    /** The running app version: api/VERSION (written by the packager) → schema_meta stamp → 'dev'. */
    public function currentVersion(): string
    {
        $file = $this->apiRoot . '/VERSION';
        if (is_file($file)) {
            $v = trim((string) @file_get_contents($file));
            if ($v !== '') {
                return $v;
            }
        }
        try {
            $stmt = $this->pdo->query("SELECT meta_value FROM schema_meta WHERE meta_key = 'app_version'");
            $v = $stmt ? $stmt->fetchColumn() : false;
            if ($v !== false && $v !== null && $v !== '') {
                return (string) $v;
            }
        } catch (\Throwable) {
        }
        return 'dev';
    }

    public function status(): array
    {
        return [
            'currentVersion' => $this->currentVersion(),
            'layout' => $this->layout(),
            'staged' => $this->stagedInfo(),
            'backups' => $this->listBackups(),
            'history' => $this->history(),
            'maintenance' => $this->maintenance->status(),
        ];
    }

    // ── upload + validate + stage ───────────────────────────────────────────

    /**
     * Accept an uploaded package zip, extract it into an IMMUTABLE per-digest
     * package directory, and fully verify it (review FL-006/FL-008): a signed
     * manifest whose inventory covers every file exactly once, verified against
     * the pinned release key. Unsigned/incomplete packages are refused — the
     * only exception is the conspicuous development override, which cannot be
     * enabled in production. Returns the staged-package report (packageId +
     * digest bind the later apply to these exact bytes).
     *
     * @throws \RuntimeException on any validation failure (staging is cleared)
     * @throws UpgradeInProgressException when another upgrade operation runs
     */
    public function stageUploadedPackage(string $zipPath): array
    {
        if (!class_exists(\ZipArchive::class)) {
            throw new \RuntimeException('The PHP zip extension is required for upgrades');
        }
        return $this->withUpgradeLock(function () use ($zipPath): array {
            $digest = (string) hash_file('sha256', $zipPath);
            $packageId = 'pkg-' . substr($digest, 0, 32);
            $dir = $this->packagesDir() . '/' . $packageId;
            $this->rrmdir($dir);
            if (!@mkdir($dir, 0750, true)) {
                throw new \RuntimeException('Cannot create the package staging directory');
            }

            try {
                $zip = new \ZipArchive();
                if ($zip->open($zipPath) !== true) {
                    throw new \RuntimeException('The uploaded file is not a readable zip archive');
                }
                // Zip-slip guard: refuse entries that escape the staging dir.
                for ($i = 0; $i < $zip->numFiles; $i++) {
                    $name = (string) $zip->getNameIndex($i);
                    $norm = str_replace('\\', '/', $name);
                    if (str_contains($norm, '../') || str_starts_with($norm, '/') || preg_match('/^[a-zA-Z]:/', $norm)) {
                        throw new \RuntimeException("Unsafe path in archive: {$name}");
                    }
                }
                if (!$zip->extractTo($dir)) {
                    throw new \RuntimeException('Could not extract the archive (disk full or permissions?)');
                }
                $zip->close();

                $report = $this->verifyPackageTree($dir);

                $info = [
                    'packageId' => $packageId,
                    'digest' => $digest,
                    'version' => $report['version'],
                    'integrity' => $report['integrity'],
                    'verifiedFiles' => $report['verifiedFiles'],
                    'currentVersion' => $this->currentVersion(),
                    'isDowngrade' => version_compare($this->normalizeVersion($report['version']), $this->normalizeVersion($this->currentVersion()), '<'),
                    'stagedAt' => gmdate('c'),
                    'state' => 'verified',
                ];
                $encoded = (string) json_encode($info);
                if (file_put_contents("{$dir}/.staged-info.json", $encoded) === false
                    || file_put_contents($this->pointerFile(), $encoded) === false
                ) {
                    throw new \RuntimeException('Could not record the staged package');
                }
                // Exactly one staged package at a time: retire the others.
                foreach (scandir($this->packagesDir()) ?: [] as $entry) {
                    if ($entry !== '.' && $entry !== '..' && $entry !== $packageId) {
                        $this->rrmdir($this->packagesDir() . '/' . $entry);
                    }
                }
                $this->rrmdir($this->legacyStagingDir());
                return $info;
            } catch (\Throwable $e) {
                $this->rrmdir($dir);
                throw $e instanceof \RuntimeException ? $e : new \RuntimeException($e->getMessage(), 0, $e);
            }
        });
    }

    /**
     * Full package-tree verification (review FL-006). Runs at staging AND
     * again immediately before apply:
     *  - structural sanity (single-domain FormLogic package);
     *  - manifest.json present, well-formed, every listed file existing with
     *    the exact sha256, safe paths, no case-variant duplicates;
     *  - NO unlisted regular file anywhere in the tree;
     *  - an Ed25519 signature over the exact manifest bytes by the PINNED
     *    release key (unknown key IDs and bad signatures are refused).
     * Without a pinned key, production refuses outright; development refuses
     * unless the explicit UPGRADE_ALLOW_UNSIGNED override is set.
     *
     * @return array{integrity: string, verifiedFiles: int, version: string}
     */
    private function verifyPackageTree(string $dir): array
    {
        foreach (['index.html', 'api/public/index.php', 'api/vendor/autoload.php', 'api/database/schema.sql'] as $required) {
            if (!is_file("{$dir}/{$required}")) {
                throw new \RuntimeException("Not a FormLogic release package — missing {$required}");
            }
        }

        $manifestPath = "{$dir}/manifest.json";
        if (!is_file($manifestPath)) {
            if ($this->allowUnsignedDev) {
                $version = trim((string) @file_get_contents("{$dir}/VERSION"));
                if ($version === '') {
                    throw new \RuntimeException('The package carries no version (no manifest.json and no VERSION file)');
                }
                return ['integrity' => 'unsigned-dev-override', 'verifiedFiles' => 0, 'version' => $version];
            }
            throw new \RuntimeException('This package has no manifest.json — unverifiable releases are refused (development installs may set UPGRADE_ALLOW_UNSIGNED=true)');
        }
        $manifestBytes = (string) file_get_contents($manifestPath);
        $manifest = json_decode($manifestBytes, true);
        if (!is_array($manifest) || !is_string($manifest['version'] ?? null) || !is_array($manifest['files'] ?? null)) {
            throw new \RuntimeException('manifest.json is present but malformed');
        }

        if ($this->releasePublicKeyRaw !== null) {
            $sigPath = "{$dir}/manifest.sig.json";
            if (!is_file($sigPath)) {
                throw new \RuntimeException('This package is unsigned (manifest.sig.json is missing) — refused');
            }
            $sig = json_decode((string) file_get_contents($sigPath), true);
            if (!is_array($sig) || ($sig['algorithm'] ?? null) !== 'ed25519' || !is_string($sig['signature'] ?? null)) {
                throw new \RuntimeException('manifest.sig.json is malformed');
            }
            $pinnedKeyId = substr(hash('sha256', $this->releasePublicKeyRaw), 0, 16);
            if (($sig['keyId'] ?? null) !== $pinnedKeyId) {
                throw new \RuntimeException('This package is signed by an unknown release key — refused');
            }
            $sigRaw = base64_decode((string) $sig['signature'], true);
            if (
                !is_string($sigRaw) || strlen($sigRaw) !== SODIUM_CRYPTO_SIGN_BYTES
                || !sodium_crypto_sign_verify_detached($sigRaw, $manifestBytes, $this->releasePublicKeyRaw)
            ) {
                throw new \RuntimeException('Package signature verification FAILED — refused');
            }
            $integrity = 'signed';
        } elseif ($this->allowUnsignedDev) {
            $integrity = 'unsigned-dev-override';
        } else {
            throw new \RuntimeException(
                $this->production
                    ? 'No release signing key is pinned (UPGRADE_RELEASE_PUBKEY) — production refuses unverifiable self-updates'
                    : 'No release signing key is pinned — set UPGRADE_RELEASE_PUBKEY, or UPGRADE_ALLOW_UNSIGNED=true on a development install'
            );
        }

        // Inventory: complete, exact, and exclusive.
        $verified = 0;
        $listed = [];
        foreach ($manifest['files'] as $rel => $sha) {
            $rel = (string) $rel;
            $norm = str_replace('\\', '/', $rel);
            if (
                $norm === '' || str_contains($norm, '../') || str_starts_with($norm, '/')
                || preg_match('/^[a-zA-Z]:/', $norm) || str_contains($norm, "\0")
            ) {
                throw new \RuntimeException("Unsafe path in manifest: {$rel}");
            }
            $key = strtolower($norm);
            if (isset($listed[$key])) {
                throw new \RuntimeException("Duplicate manifest entry: {$rel}");
            }
            $listed[$key] = true;
            $abs = "{$dir}/{$norm}";
            if (!is_file($abs)) {
                throw new \RuntimeException("Package integrity failure: {$rel} listed in the manifest is missing");
            }
            if (!hash_equals((string) $sha, hash_file('sha256', $abs) ?: '')) {
                throw new \RuntimeException("Package integrity failure: {$rel} does not match its manifest checksum");
            }
            $verified++;
        }
        foreach ($this->walkRelativeFiles($dir) as $rel) {
            if (in_array($rel, self::MANIFEST_EXEMPT_FILES, true)) {
                continue;
            }
            if (!isset($listed[strtolower($rel)])) {
                throw new \RuntimeException("Package integrity failure: {$rel} is not listed in the manifest — refused");
            }
        }

        return ['integrity' => $integrity, 'verifiedFiles' => $verified, 'version' => (string) $manifest['version']];
    }

    public function stagedInfo(): ?array
    {
        $file = $this->pointerFile();
        if (!is_file($file)) {
            return null;
        }
        $info = json_decode((string) file_get_contents($file), true);
        if (!is_array($info) || !is_string($info['packageId'] ?? null)) {
            return null;
        }
        if (!is_dir($this->packagesDir() . '/' . $info['packageId'])) {
            return null;
        }
        return $info;
    }

    public function discardStagedPackage(): void
    {
        $this->withUpgradeLock(function (): bool {
            $info = $this->stagedInfo();
            if ($info !== null) {
                $this->rrmdir($this->packagesDir() . '/' . $info['packageId']);
            }
            @unlink($this->pointerFile());
            $this->rrmdir($this->legacyStagingDir());
            return true;
        });
    }

    // ── apply ────────────────────────────────────────────────────────────────

    /**
     * Apply the staged package. Steps (each recorded in the returned journal):
     * verify identity + signature again → maintenance on → DB export → code
     * snapshot → copy api/ (protected paths excluded) → remove stale managed
     * files → copy web-root files (+ stale removal) → stamp version → history.
     * Migrations run automatically on the next request served by the new code.
     *
     * Review FL-008: the caller names the exact package (`packageId`, and
     * optionally the upload digest) it reviewed; a concurrent re-stage yields
     * a typed mismatch instead of silently applying different bytes, and the
     * whole operation holds the cross-process upgrade lock. The immutable
     * staged tree is fully re-verified (signature + inventory) immediately
     * before any file is copied (review FL-006).
     *
     * @throws \RuntimeException with the journal context on failure
     */
    public function apply(string $actingUserId, bool $keepMaintenanceOn = false, ?string $packageId = null, ?string $expectedDigest = null): array
    {
        @set_time_limit(600);
        return $this->withUpgradeLock(function () use ($actingUserId, $keepMaintenanceOn, $packageId, $expectedDigest): array {
            $staged = $this->stagedInfo();
            if ($staged === null) {
                throw new \RuntimeException('No validated package is staged — upload one first');
            }
            if ($packageId !== null && $packageId !== $staged['packageId']) {
                throw new StagedPackageMismatchException("expected {$packageId}, staged is {$staged['packageId']}");
            }
            if ($expectedDigest !== null && !hash_equals((string) ($staged['digest'] ?? ''), $expectedDigest)) {
                throw new StagedPackageMismatchException('the content digest differs');
            }
            if (($staged['state'] ?? 'verified') !== 'verified') {
                throw new \RuntimeException("The staged package is in state '{$staged['state']}' — re-stage it");
            }
            $layout = $this->layout();
            if (!$layout['supported']) {
                throw new \RuntimeException('This installation layout is not recognized — set FORMLOGIC_WEB_ROOT in .env to the folder holding index.html');
            }
            $staging = $this->packagesDir() . '/' . $staged['packageId'];

            // Re-verify the immutable tree RIGHT before touching the live code:
            // signature, complete inventory, no unlisted file (FL-006/FL-008).
            $report = $this->verifyPackageTree($staging);
            if ($report['version'] !== ($staged['version'] ?? null)) {
                throw new StagedPackageMismatchException('the package version changed on disk');
            }

            $journal = [];
            $fromVersion = $this->currentVersion();
            $maintenanceWasOn = $this->maintenance->enabled();

            // 1. Close the site so nothing writes mid-swap (kept on if it already was).
            if (!$maintenanceWasOn) {
                $this->maintenance->enable('We are upgrading FormLogic — back in a few minutes.', $actingUserId);
            }
            $journal[] = 'Maintenance mode enabled';
            $this->markPointerState('applying');

            try {
                // 2. Automatic database export + code snapshot = the revert point.
                $backupId = gmdate('Ymd-His') . '-' . substr(bin2hex(random_bytes(3)), 0, 6);
                $backupDir = $this->backupsDir() . '/' . $backupId;
                @mkdir($backupDir, 0750, true);
                $this->dumpDatabase("{$backupDir}/database.sql.gz");
                $journal[] = 'Database exported to backup';

                $counts = $this->copyTree($this->apiRoot, "{$backupDir}/api", self::PROTECTED_API_PATHS);
                $journal[] = "Backend snapshot taken ({$counts} files)";
                $counts = $this->copyTree($layout['webRoot'], "{$backupDir}/web", self::PROTECTED_WEB_PATHS);
                $journal[] = "Frontend snapshot taken ({$counts} files)";
                file_put_contents("{$backupDir}/backup-info.json", json_encode([
                    'id' => $backupId, 'at' => gmdate('c'), 'version' => $fromVersion, 'by' => $actingUserId,
                ], JSON_PRETTY_PRINT));

                // 3. Apply: backend first, then the web root. Protected paths are
                //    excluded on the DESTINATION side, and the package's own (empty)
                //    api/storage skeleton is excluded on the SOURCE side — the
                //    per-form SQLite databases are never written under any input.
                //    After each copy, managed files ABSENT from the package are
                //    removed (review FL-007: obsolete public endpoints must not
                //    stay deployed) — protected paths are equally exempt here.
                $counts = $this->copyTree("{$staging}/api", $this->apiRoot, self::PROTECTED_API_PATHS);
                $journal[] = "Backend files applied ({$counts} files)";
                $removed = $this->deleteStale($this->apiRoot, "{$staging}/api", self::PROTECTED_API_PATHS);
                $journal[] = "Stale backend files removed ({$removed})";
                $webExclude = array_merge(self::PROTECTED_WEB_PATHS, ['.staged-info.json']);
                $counts = $this->copyTree($staging, $layout['webRoot'], $webExclude);
                $journal[] = "Frontend files applied ({$counts} files)";
                $removed = $this->deleteStale($layout['webRoot'], $staging, $webExclude);
                $journal[] = "Stale frontend files removed ({$removed})";

                // 4. Version stamps: api/VERSION already copied; mirror into schema_meta
                //    (the same stamp bin/upgrade.php writes) so --check agrees.
                $this->stampSchemaMeta($staged['version']);
                $journal[] = "Version stamped ({$fromVersion} → {$staged['version']})";

                $this->appendHistory([
                    'action' => 'upgrade', 'at' => gmdate('c'), 'by' => $actingUserId,
                    'fromVersion' => $fromVersion, 'toVersion' => $staged['version'],
                    'backupId' => $backupId, 'integrity' => $staged['integrity'],
                ]);
                $this->rrmdir($staging);
                @unlink($this->pointerFile());

                // 5. Reopen unless the admin asked to stay closed (or it was already closed).
                if (!$maintenanceWasOn && !$keepMaintenanceOn) {
                    $this->maintenance->disable($actingUserId);
                    $journal[] = 'Maintenance mode disabled';
                } else {
                    $journal[] = 'Maintenance mode left ON (turn it off from the Maintenance tab)';
                }
                $journal[] = 'Schema migrations will run automatically on the next request';

                return [
                    'ok' => true,
                    'fromVersion' => $fromVersion,
                    'toVersion' => $staged['version'],
                    'backupId' => $backupId,
                    'journal' => $journal,
                ];
            } catch (\Throwable $e) {
                // Leave maintenance ON — a half-applied tree must not serve users.
                $this->markPointerState('failed', $e->getMessage());
                $journal[] = 'FAILED: ' . $e->getMessage();
                throw new \RuntimeException(
                    'Upgrade failed (site left in maintenance mode; use Rollback if files were already applied): '
                    . $e->getMessage() . ' | journal: ' . implode(' → ', $journal),
                    0,
                    $e
                );
            }
        });
    }

    // ── rollback / restore ──────────────────────────────────────────────────

    /**
     * Restore the code snapshot from a backup (the DB is NOT auto-restored —
     * see restoreDatabase). Review FL-007: the snapshot is authoritative —
     * managed files that exist now but were not in the snapshot (files the
     * newer release introduced) are REMOVED, so the prior inventory is
     * reconstructed exactly; protected data/config paths stay untouched.
     */
    public function rollback(string $backupId, string $actingUserId): array
    {
        @set_time_limit(600);
        return $this->withUpgradeLock(fn (): array => $this->rollbackLocked($backupId, $actingUserId));
    }

    private function rollbackLocked(string $backupId, string $actingUserId): array
    {
        $backupDir = $this->backupDirFor($backupId);
        $layout = $this->layout();
        if (!$layout['supported']) {
            throw new \RuntimeException('This installation layout is not recognized');
        }
        if (!is_dir("{$backupDir}/api") || !is_dir("{$backupDir}/web")) {
            throw new \RuntimeException('This backup has no code snapshot to restore');
        }

        $maintenanceWasOn = $this->maintenance->enabled();
        if (!$maintenanceWasOn) {
            $this->maintenance->enable('We are restoring a previous version — back shortly.', $actingUserId);
        }
        $journal = ['Maintenance mode enabled'];
        $fromVersion = $this->currentVersion();

        $counts = $this->copyTree("{$backupDir}/api", $this->apiRoot, self::PROTECTED_API_PATHS);
        $journal[] = "Backend restored ({$counts} files)";
        $removed = $this->deleteStale($this->apiRoot, "{$backupDir}/api", self::PROTECTED_API_PATHS);
        $journal[] = "Backend files not in the snapshot removed ({$removed})";
        $counts = $this->copyTree("{$backupDir}/web", $layout['webRoot'], self::PROTECTED_WEB_PATHS);
        $journal[] = "Frontend restored ({$counts} files)";
        $removed = $this->deleteStale($layout['webRoot'], "{$backupDir}/web", self::PROTECTED_WEB_PATHS);
        $journal[] = "Frontend files not in the snapshot removed ({$removed})";

        $info = json_decode((string) @file_get_contents("{$backupDir}/backup-info.json"), true);
        $restoredVersion = is_array($info) ? (string) ($info['version'] ?? 'unknown') : 'unknown';
        $this->stampSchemaMeta($restoredVersion !== 'unknown' ? $restoredVersion : $fromVersion);

        $this->appendHistory([
            'action' => 'rollback', 'at' => gmdate('c'), 'by' => $actingUserId,
            'fromVersion' => $fromVersion, 'toVersion' => $restoredVersion, 'backupId' => $backupId,
        ]);

        if (!$maintenanceWasOn) {
            $this->maintenance->disable($actingUserId);
            $journal[] = 'Maintenance mode disabled';
        }
        $journal[] = 'Database was NOT restored (records created since the upgrade are intact) — restore it separately only if needed';

        return ['ok' => true, 'restoredVersion' => $restoredVersion, 'journal' => $journal];
    }

    /**
     * Restore the MySQL export from a backup. DESTRUCTIVE for anything written
     * since that backup — requires the literal confirm phrase. Per-form SQLite
     * databases are untouched (they were never part of the problem).
     */
    public function restoreDatabase(string $backupId, string $confirm, string $actingUserId): array
    {
        if ($confirm !== 'RESTORE-DATABASE') {
            throw new \RuntimeException("Confirmation phrase mismatch — send confirm: 'RESTORE-DATABASE'");
        }
        @set_time_limit(600);
        $dump = $this->backupDirFor($backupId) . '/database.sql.gz';
        if (!is_file($dump)) {
            throw new \RuntimeException('This backup has no database export');
        }

        $maintenanceWasOn = $this->maintenance->enabled();
        if (!$maintenanceWasOn) {
            $this->maintenance->enable('We are restoring data — back shortly.', $actingUserId);
        }

        $gz = gzopen($dump, 'rb');
        if ($gz === false) {
            throw new \RuntimeException('Cannot open the database export');
        }
        $statements = 0;
        try {
            $this->pdo->exec('SET FOREIGN_KEY_CHECKS=0');
            $buffer = '';
            while (!gzeof($gz)) {
                $buffer .= gzread($gz, 1 << 20);
                // Our own dump format: exactly one statement per line, ";"-terminated
                // (newlines inside values are \n-escaped at dump time).
                while (($nl = strpos($buffer, "\n")) !== false) {
                    $line = substr($buffer, 0, $nl);
                    $buffer = substr($buffer, $nl + 1);
                    $line = rtrim($line, "\r");
                    if ($line === '' || str_starts_with($line, '--')) {
                        continue;
                    }
                    $this->pdo->exec($line);
                    $statements++;
                }
            }
            if (trim($buffer) !== '' && !str_starts_with(trim($buffer), '--')) {
                $this->pdo->exec(trim($buffer));
                $statements++;
            }
        } finally {
            try {
                $this->pdo->exec('SET FOREIGN_KEY_CHECKS=1');
            } catch (\Throwable) {
            }
            gzclose($gz);
        }

        $this->appendHistory([
            'action' => 'restore-database', 'at' => gmdate('c'), 'by' => $actingUserId, 'backupId' => $backupId,
        ]);
        if (!$maintenanceWasOn) {
            $this->maintenance->disable($actingUserId);
        }
        return ['ok' => true, 'statements' => $statements];
    }

    /** On-demand database export (same dumper the automatic pre-upgrade backup uses). */
    public function exportDatabaseBackup(string $actingUserId): array
    {
        @set_time_limit(600);
        $backupId = gmdate('Ymd-His') . '-' . substr(bin2hex(random_bytes(3)), 0, 6) . '-manual';
        $backupDir = $this->backupsDir() . '/' . $backupId;
        @mkdir($backupDir, 0750, true);
        $this->dumpDatabase("{$backupDir}/database.sql.gz");
        file_put_contents("{$backupDir}/backup-info.json", json_encode([
            'id' => $backupId, 'at' => gmdate('c'), 'version' => $this->currentVersion(), 'by' => $actingUserId, 'manual' => true,
        ], JSON_PRETTY_PRINT));
        $this->appendHistory(['action' => 'db-export', 'at' => gmdate('c'), 'by' => $actingUserId, 'backupId' => $backupId]);
        return ['ok' => true, 'backupId' => $backupId];
    }

    public function listBackups(): array
    {
        $dir = $this->backupsDir();
        if (!is_dir($dir)) {
            return [];
        }
        $out = [];
        foreach (scandir($dir, SCANDIR_SORT_DESCENDING) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..' || !is_dir("{$dir}/{$entry}")) {
                continue;
            }
            $info = json_decode((string) @file_get_contents("{$dir}/{$entry}/backup-info.json"), true);
            // Only REAL backups belong in this list: anything without an info
            // file, a code snapshot, or a DB export is a stray directory (e.g.
            // a temp/staging folder) — listing it as restorable is misleading.
            if (!is_array($info) && !is_dir("{$dir}/{$entry}/api") && !is_file("{$dir}/{$entry}/database.sql.gz")) {
                continue;
            }
            $out[] = [
                'id' => $entry,
                'at' => is_array($info) ? ($info['at'] ?? null) : null,
                'version' => is_array($info) ? ($info['version'] ?? null) : null,
                'manual' => is_array($info) ? (bool) ($info['manual'] ?? false) : false,
                'hasCode' => is_dir("{$dir}/{$entry}/api"),
                'hasDatabase' => is_file("{$dir}/{$entry}/database.sql.gz"),
                'sizeBytes' => $this->dirSize("{$dir}/{$entry}"),
            ];
        }
        return array_slice($out, 0, 20);
    }

    // ── internals ────────────────────────────────────────────────────────────

    public function uploadsDir(): string
    {
        return $this->apiRoot . '/storage/upgrades';
    }

    /** Immutable per-digest package directories (review FL-008). */
    private function packagesDir(): string
    {
        $dir = $this->uploadsDir() . '/packages';
        if (!is_dir($dir)) {
            @mkdir($dir, 0750, true);
        }
        return $dir;
    }

    /** Pointer to the currently staged package (id + digest + state). */
    private function pointerFile(): string
    {
        return $this->uploadsDir() . '/staged.json';
    }

    /** The pre-FL-008 mutable staging dir — only ever cleaned up now. */
    private function legacyStagingDir(): string
    {
        return $this->uploadsDir() . '/staging';
    }

    private function markPointerState(string $state, ?string $error = null): void
    {
        $info = $this->stagedInfo();
        if ($info === null) {
            return;
        }
        $info['state'] = $state;
        if ($error !== null) {
            $info['error'] = substr($error, 0, 300);
        }
        @file_put_contents($this->pointerFile(), json_encode($info));
    }

    /**
     * Cross-process upgrade mutual exclusion (review FL-008): stage, apply,
     * discard, and rollback all hold one DB advisory lock.
     *
     * @template T
     * @param callable():T $fn
     * @return T
     */
    private function withUpgradeLock(callable $fn)
    {
        try {
            $db = (string) $this->pdo->query('SELECT DATABASE()')->fetchColumn();
            $lockName = 'formlogic.upgrade.' . $db;
            $stmt = $this->pdo->prepare('SELECT GET_LOCK(?, 0)');
            $stmt->execute([$lockName]);
            $got = (int) $stmt->fetchColumn() === 1;
        } catch (\Throwable) {
            throw new UpgradeInProgressException();
        }
        if (!$got) {
            throw new UpgradeInProgressException();
        }
        try {
            return $fn();
        } finally {
            try {
                $release = $this->pdo->prepare('SELECT RELEASE_LOCK(?)');
                $release->execute([$lockName]);
                $release->fetchColumn();
            } catch (\Throwable) {
            }
        }
    }

    /**
     * Every regular file under $dir as a forward-slash relative path
     * (symlinks skipped — they are never package content).
     *
     * @return list<string>
     */
    private function walkRelativeFiles(string $dir): array
    {
        $out = [];
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::LEAVES_ONLY,
        );
        $prefix = rtrim($dir, '/\\');
        foreach ($it as $item) {
            /** @var \SplFileInfo $item */
            if (!$item->isFile() || $item->isLink()) {
                continue;
            }
            $rel = substr($item->getPathname(), strlen($prefix) + 1);
            $out[] = str_replace('\\', '/', $rel);
        }
        return $out;
    }

    /**
     * Remove files under $dst that have no counterpart file in $src
     * (review FL-007). Exclusions apply to top-level names on the $dst side
     * exactly as copyTree applies them, so protected data/config paths can
     * never be deleted. Empty directories left behind are pruned. Returns the
     * number of files removed.
     */
    private function deleteStale(string $dst, string $src, array $excludeTopLevel): int
    {
        if (!is_dir($dst) || !is_dir($src)) {
            return 0;
        }
        $exclude = array_map('strtolower', $excludeTopLevel);
        $removed = 0;
        foreach (scandir($dst) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if (in_array(strtolower(rtrim($entry, '/\\')), $exclude, true)) {
                continue;
            }
            $removed += $this->deleteStaleEntry("{$dst}/{$entry}", "{$src}/{$entry}");
        }
        return $removed;
    }

    private function deleteStaleEntry(string $dst, string $src): int
    {
        if (is_link($dst)) {
            return 0; // never follow or judge links
        }
        if (is_dir($dst)) {
            $removed = 0;
            foreach (scandir($dst) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..') {
                    continue;
                }
                $removed += $this->deleteStaleEntry("{$dst}/{$entry}", "{$src}/{$entry}");
            }
            if (!is_dir($src)) {
                @rmdir($dst); // prune only if now empty
            }
            return $removed;
        }
        if (!is_file($src)) {
            return @unlink($dst) ? 1 : 0;
        }
        return 0;
    }

    private function backupsDir(): string
    {
        return $this->apiRoot . '/storage/backups';
    }

    private function backupDirFor(string $backupId): string
    {
        // Ids are self-generated; still, never let a crafted id escape the backups dir.
        if (!preg_match('/^[a-zA-Z0-9\-]{1,64}$/', $backupId)) {
            throw new \RuntimeException('Invalid backup id');
        }
        $dir = $this->backupsDir() . '/' . $backupId;
        if (!is_dir($dir)) {
            throw new \RuntimeException('Backup not found');
        }
        return $dir;
    }

    /**
     * Recursive copy with top-level exclusions applied to BOTH sides: an entry
     * whose top-level name is protected is neither read from the source nor
     * written over at the destination. Returns the number of files copied.
     */
    private function copyTree(string $src, string $dst, array $excludeTopLevel): int
    {
        if (!is_dir($src)) {
            throw new \RuntimeException("Source directory missing: {$src}");
        }
        $exclude = array_map('strtolower', $excludeTopLevel);
        $count = 0;
        $entries = scandir($src) ?: [];
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if (in_array(strtolower(rtrim($entry, '/\\')), $exclude, true)) {
                continue;
            }
            $count += $this->copyEntry("{$src}/{$entry}", "{$dst}/{$entry}");
        }
        return $count;
    }

    private function copyEntry(string $src, string $dst): int
    {
        if (is_link($src)) {
            return 0; // never follow links out of the tree
        }
        if (is_dir($src)) {
            if (!is_dir($dst) && !@mkdir($dst, 0750, true)) {
                throw new \RuntimeException("Cannot create directory {$dst}");
            }
            $count = 0;
            foreach (scandir($src) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..') {
                    continue;
                }
                $count += $this->copyEntry("{$src}/{$entry}", "{$dst}/{$entry}");
            }
            return $count;
        }
        $dir = dirname($dst);
        if (!is_dir($dir) && !@mkdir($dir, 0750, true)) {
            throw new \RuntimeException("Cannot create directory {$dir}");
        }
        if (!@copy($src, $dst)) {
            throw new \RuntimeException("Cannot copy {$src} → {$dst}");
        }
        // ZipArchive::extractTo does not restore unix modes and copy() does not
        // carry them, so an upgrade would silently strip the execute bit from the
        // sandbox launcher: every form evaluation then fails at exec while the
        // health check, which only looks for the file, stays green. Restore it by
        // path — the staged copy has no bit to inherit.
        if (PHP_OS_FAMILY !== 'Windows' && str_contains(str_replace('\\', '/', $dst), '/bin/runtime/')) {
            @chmod($dst, 0755);
        }
        return 1;
    }

    /**
     * Pure-PHP MySQL export (no mysqldump dependency): DROP+CREATE per table +
     * chunked INSERTs, one statement per line ("\n"/"\r" inside values are
     * \-escaped so restoreDatabase can split on newlines safely), gzip-written.
     * PUBLIC: shared with ScheduledBackupService (the nightly site dump), which
     * must not create a Backups-panel entry the way exportDatabaseBackup does.
     *
     * Review FL-004: every table is read inside ONE repeatable-read consistent
     * snapshot (a restore can never mix instants), every gzip write is
     * length-checked, the dump is written to a temporary sibling, gzip-verified
     * end-to-end, and only then renamed into place — a short write or disk-full
     * publishes nothing. Non-InnoDB tables (outside the snapshot guarantee) are
     * flagged in the dump header.
     *
     * @param callable(string):void|null $afterTable test hook fired after each
     *   table finishes (used by the concurrent-writer barrier test).
     */
    public function dumpDatabase(string $outGzPath, ?callable $afterTable = null): void
    {
        if ($this->pdo->inTransaction()) {
            // START TRANSACTION would implicitly commit the caller's work and
            // our ROLLBACK would then eat theirs — refuse instead.
            throw new \RuntimeException('dumpDatabase must not run inside an open transaction');
        }
        $tmpPath = $outGzPath . '.tmp-' . bin2hex(random_bytes(4));
        $gz = gzopen($tmpPath, 'wb6');
        if ($gz === false) {
            throw new \RuntimeException('Cannot create the database export file');
        }
        try {
            $write = static function (string $line) use ($gz): void {
                if (gzwrite($gz, $line) !== strlen($line)) {
                    throw new \RuntimeException('Short write while exporting the database');
                }
            };

            $this->pdo->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $this->pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
            try {
                $write("-- FormLogic database export " . gmdate('c') . "\n");
                $write("SET NAMES utf8mb4;\n");
                $write("SET FOREIGN_KEY_CHECKS=0;\n");
                $engines = $this->pdo
                    ->query('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')
                    ->fetchAll(PDO::FETCH_KEY_PAIR);
                $tables = $this->pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
                foreach ($tables as $table) {
                    $engine = $engines[(string) $table] ?? null;
                    if ($engine !== null && strtolower((string) $engine) !== 'innodb') {
                        $write("-- WARNING: table `{$table}` uses ENGINE={$engine}; its rows are read outside the consistent snapshot\n");
                    }
                    $quoted = '`' . str_replace('`', '``', (string) $table) . '`';
                    $create = $this->pdo->query("SHOW CREATE TABLE {$quoted}")->fetch(PDO::FETCH_ASSOC);
                    $createSql = $create['Create Table'] ?? ($create['Create View'] ?? null);
                    if ($createSql === null) {
                        continue;
                    }
                    $write("DROP TABLE IF EXISTS {$quoted};\n");
                    // One line per statement: collapse the pretty-printed CREATE.
                    $write(preg_replace('/\r?\n/', ' ', $createSql) . ";\n");

                    $stmt = $this->pdo->query("SELECT * FROM {$quoted}");
                    $batch = [];
                    while (($row = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
                        $values = [];
                        foreach ($row as $value) {
                            if ($value === null) {
                                $values[] = 'NULL';
                            } else {
                                // Escape real newlines so every statement stays on one line.
                                $values[] = str_replace(["\r", "\n"], ['\\r', '\\n'], $this->pdo->quote((string) $value));
                            }
                        }
                        $batch[] = '(' . implode(',', $values) . ')';
                        if (count($batch) >= 200) {
                            $write("INSERT INTO {$quoted} VALUES " . implode(',', $batch) . ";\n");
                            $batch = [];
                        }
                    }
                    if ($batch !== []) {
                        $write("INSERT INTO {$quoted} VALUES " . implode(',', $batch) . ";\n");
                    }
                    if ($afterTable !== null) {
                        $afterTable((string) $table);
                    }
                }
                $write("SET FOREIGN_KEY_CHECKS=1;\n");
            } finally {
                // Read-only snapshot: rolling back simply releases it.
                try {
                    $this->pdo->exec('ROLLBACK');
                } catch (\Throwable) {
                }
            }

            if (!gzclose($gz)) {
                $gz = null;
                throw new \RuntimeException('Could not finalize the database export');
            }
            $gz = null;

            // Verify the gzip stream end-to-end before publishing.
            $check = gzopen($tmpPath, 'rb');
            if ($check === false) {
                throw new \RuntimeException('Database export failed gzip verification');
            }
            while (!gzeof($check)) {
                if (gzread($check, 1 << 20) === false) {
                    gzclose($check);
                    throw new \RuntimeException('Database export failed gzip verification');
                }
            }
            gzclose($check);

            if (!rename($tmpPath, $outGzPath)) {
                // Windows refuses rename-onto-existing; replace explicitly.
                @unlink($outGzPath);
                if (!rename($tmpPath, $outGzPath)) {
                    throw new \RuntimeException('Could not publish the database export');
                }
            }
        } catch (\Throwable $e) {
            if ($gz !== null) {
                @gzclose($gz);
            }
            @unlink($tmpPath);
            throw $e;
        }
    }

    private function stampSchemaMeta(string $version): void
    {
        try {
            $this->pdo->exec("CREATE TABLE IF NOT EXISTS schema_meta (
                meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
                meta_value TEXT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $stmt = $this->pdo->prepare("
                INSERT INTO schema_meta (meta_key, meta_value) VALUES
                    ('app_version', :v), ('last_upgrade_at', :at), ('upgrade_source', 'admin-panel')
                ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)
            ");
            $stmt->execute(['v' => $version, 'at' => gmdate('c')]);
        } catch (\Throwable) {
            // stamping is informational — never fail an upgrade over it
        }
    }

    private function history(): array
    {
        $file = $this->uploadsDir() . '/history.json';
        $data = json_decode((string) @file_get_contents($file), true);
        return is_array($data) ? array_slice(array_reverse($data), 0, 20) : [];
    }

    private function appendHistory(array $entry): void
    {
        $file = $this->uploadsDir() . '/history.json';
        @mkdir(dirname($file), 0750, true);
        $data = json_decode((string) @file_get_contents($file), true);
        $data = is_array($data) ? $data : [];
        $data[] = $entry;
        @file_put_contents($file, json_encode(array_slice($data, -100), JSON_PRETTY_PRINT));
    }

    /** "v1.2.3" and sha-date dev versions both become comparable strings. */
    private function normalizeVersion(string $v): string
    {
        $v = ltrim(trim($v), 'vV');
        return preg_match('/^\d+\.\d+/', $v) ? $v : '0.0.0';
    }

    private function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = "{$dir}/{$entry}";
            if (is_dir($path) && !is_link($path)) {
                $this->rrmdir($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($dir);
    }

    private function dirSize(string $dir): int
    {
        $size = 0;
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = "{$dir}/{$entry}";
            $size += is_dir($path) ? $this->dirSize($path) : (int) @filesize($path);
        }
        return $size;
    }
}
