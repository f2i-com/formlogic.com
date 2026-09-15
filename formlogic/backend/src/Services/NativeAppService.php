<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\SqliteSnapshot;
use InvalidArgumentException;
use RuntimeException;
use PDO;

/**
 * Owner-managed native SoftN installations. Runtime code is operator supplied; uploads contain data and DSL source only.
 *
 * Three different questions, answered by three different methods (audit FL-03):
 *  - available()  — are the runtime ARTIFACTS prepared on this host? Cheap file/extension checks only.
 *  - preflight()  — can the runtime actually RUN here? Executes the configured Node binary, loads the
 *                   engine, starts a throw-away app in a temporary root and proves private storage is
 *                   writable. Bounded, non-destructive, briefly cached.
 *  - install()'s /api/meta health call — is THIS app's source and migration state usable?
 *
 * Storage layout under root(appId) (audit FL-02 inventory):
 *  - app/                          active source (restorable, portable)
 *  - project.json                  source + media + version/home/access (restorable, portable)
 *  - private/data/application.sqlite   records + migration state + record-event queue (restorable, account data)
 *  - private/config.json           host-generated key material + capabilities (restorable ONLY through a
 *                                  privileged recovery backup; otherwise reissued and reported as such)
 *  - private/manage.lock, events.lock, staging-*, previous-*, pre-install-*.sqlite, recovery-required
 *                                  host-local; never archived
 *  - private/install.json          the install journal (FL-S03): written before an update changes
 *                                  anything, advanced at every phase, removed when the update is
 *                                  complete. A process that dies mid-update leaves it behind, and
 *                                  the next operation to take the management lock settles it —
 *                                  rolls the old generation back, or the finished one forward —
 *                                  before anything else runs.
 *
 * Every file this service publishes (project.json, config.json, staged source and media, the
 * journal, the recovery marker) is written completely or not at all (FL-S02): a private temporary
 * file beside the destination, the byte count compared with the byte count intended, flushed,
 * then renamed into place. A short write leaves the previous file and fails the operation.
 *
 * Every entry point takes the management lock FIRST and decides only afterwards (FL-S04): whether
 * the installation exists, whether an update was left unfinished, whether operator recovery is
 * required, and whether the generation the caller was looking at is still the one installed.
 */
class NativeAppService
{
    public const CRYPTO_RESTORED = 'restored';
    public const CRYPTO_REISSUED = 'reissued';

    /**
     * The native hosting protocol this service speaks, and the record-event protocol it
     * understands. Softn's runtime declares its own in host-protocol.json; the prepared
     * runtime is refused unless they agree. The UI keeps the same numbers in
     * formlogic/ui/src/lib/softn/protocol.json (NativeAppServiceTest pins the two together).
     */
    public const NATIVE_PROTOCOL = 1;
    public const RECORD_EVENTS_PROTOCOL = 1;

    private const PREFLIGHT_TTL = 60;

    /** The install journal, relative to the installation root. */
    private const JOURNAL = '/private/install.json';

    /** Records browsing: rows per page, and the furthest offset a page may start at. */
    public const RECORD_PAGE = 50;
    public const RECORD_OFFSET_LIMIT = 100000;

    /**
     * Environment variables the Node runtime is allowed to inherit from PHP. Everything else
     * (database credentials, API keys, whatever the operator's .env put in the process
     * environment) stays with PHP: the guest cannot read process.env, but the runtime should
     * not hold secrets it has no use for. Compared case-insensitively (Windows).
     */
    private const NODE_ENV_ALLOWLIST = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

    public function __construct(private ?string $storagePath = null, private ?string $runtimePath = null, private ?string $nodeBinary = null) {}

    private function root(string $appId): string
    {
        if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $appId)) throw new InvalidArgumentException('Invalid app identity');
        return ($this->storagePath ?? dirname(__DIR__, 2) . '/storage/native-apps') . '/' . hash('sha256', $appId);
    }

    public function available(): bool
    {
        return function_exists('proc_open') && extension_loaded('pdo_sqlite') && is_file($this->runtime() . '/host-protocol.json') && is_file($this->runtime() . '/runner.mjs') && is_file($this->runtime() . '/wasm/zipp_wasm_bg.wasm');
    }

    private function runtime(): string { return $this->runtimePath ?? dirname(__DIR__, 2) . '/resources/softn-native'; }

    private function storageRoot(): string { return $this->storagePath ?? dirname(__DIR__, 2) . '/storage/native-apps'; }

    // ── Backup / restore surface (audit FL-02) ────────────────────────────────

    /**
     * What a backup can carry for this app, or null when no native installation exists.
     * Never returns key material; hostConfig() is the separate, privileged read.
     *
     * @return array{manifestId:string, version:int, home:bool, access:string, capabilities:list<string>, hasDatabase:bool, recoveryRequired:bool}|null
     */
    public function describe(string $appId): ?array
    {
        $project = $this->get($appId);
        if (!$project) return null;
        $root = $this->root($appId);
        $manifest = json_decode((string) ($project['files']['manifest.json'] ?? ''), true);
        $capabilities = is_array($manifest['server']['requires']['capabilities'] ?? null) ? array_values(array_map('strval', $manifest['server']['requires']['capabilities'])) : [];
        return [
            'manifestId' => (string) ($manifest['id'] ?? ''),
            'version' => (int) ($project['version'] ?? 0),
            'home' => (bool) ($project['home'] ?? false),
            'access' => (string) ($project['access'] ?? 'application'),
            'capabilities' => $capabilities,
            'hasDatabase' => is_file($root . '/private/data/application.sqlite'),
            'recoveryRequired' => is_file($root . '/private/recovery-required'),
            'updateUnfinished' => is_file($root . self::JOURNAL),
        ];
    }

    /**
     * The private host configuration (key material + capabilities) for a PRIVILEGED recovery backup.
     * Callers must never place this in a user-downloadable export.
     */
    public function hostConfig(string $appId): ?array
    {
        $path = $this->root($appId) . '/private/config.json';
        if (!is_file($path)) return null;
        $config = json_decode((string) file_get_contents($path), true);
        return is_array($config) ? $config : null;
    }

    /**
     * Consistent snapshot of the app's private database into $destination (audit FL-01 helper),
     * taken under the shared management lock so an in-progress install cannot interleave.
     *
     * @return array|null SqliteSnapshot metadata, or null when the app has no database yet
     */
    public function snapshotDatabase(string $appId, string $destination, ?SqliteSnapshot $snapshotter = null): ?array
    {
        [$root, $lock] = $this->openShared($appId, null, false);
        if ($lock === null) return null;
        try { return $this->snapshotDatabaseLocked($root, $destination, $snapshotter); }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** Shared management lock, or a 409 while an install/removal holds it exclusively. */
    private function sharedLock(string $root)
    {
        $this->directory($root . '/private');
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_SH | LOCK_NB)) { if ($lock) fclose($lock); throw new RuntimeException('The app is being updated. Try again shortly.', 409); }
        return $lock;
    }

    /** Exclusive management lock for an install, restore or removal; a 409 when anyone else holds it. */
    private function exclusiveLock(string $root, string $busy)
    {
        $this->directory($root . '/private');
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { if ($lock) fclose($lock); throw new RuntimeException($busy, 409); }
        return $lock;
    }

    /**
     * The one way in for every operation that reads or uses an installation (FL-S04): take the
     * shared management lock, THEN decide. An unfinished update left by a terminated process is
     * settled under an exclusive lock first (rolled back, or rolled forward when it had reached
     * its last step), then the shared lock is taken again and the checks run against what is
     * actually installed: the recovery marker, the project, and — when the caller names the
     * generation it was looking at — that this is still that generation.
     *
     * @return array{0:string, 1:resource|null, 2:array|null} root, the held shared lock, the project
     */
    private function openShared(string $appId, ?int $generation = null, bool $requireProject = true): array
    {
        $root = $this->root($appId);
        if (!is_file($root . '/project.json') && !is_file($root . self::JOURNAL)) {
            if ($requireProject) throw new RuntimeException('Native app not found', 404);
            return [$root, null, null];
        }
        $this->beforeLock($root, 'shared');
        $lock = null;
        for ($attempt = 0; $attempt < 2 && $lock === null; $attempt++) {
            $lock = $this->sharedLock($root);
            if (!is_file($root . self::JOURNAL)) break;
            flock($lock, LOCK_UN); fclose($lock); $lock = null;
            $exclusive = $this->exclusiveLock($root, 'The app is being updated. Try again shortly.');
            try { $this->resolveJournal($root); }
            finally { flock($exclusive, LOCK_UN); fclose($exclusive); }
        }
        if ($lock === null) throw new RuntimeException('The app is being updated. Try again shortly.', 409);
        try {
            if (is_file($root . self::JOURNAL)) throw new RuntimeException('The app is being updated. Try again shortly.', 409);
            $this->assertNotRecoveryRequired($root);
            $project = $this->get($appId);
            if ($project === null && $requireProject) throw new RuntimeException('Native app not found', 404);
            if ($generation !== null && (int) ($project['version'] ?? 0) !== $generation) throw new RuntimeException('The app was updated while this request was in flight. Reload and try again.', 409);
            return [$root, $lock, $project];
        } catch (\Throwable $error) {
            flock($lock, LOCK_UN); fclose($lock);
            throw $error;
        }
    }

    private function assertNotRecoveryRequired(string $root, string $message = 'The app database needs operator recovery'): void
    {
        if (is_file($root . '/private/recovery-required')) throw new RuntimeException($message);
    }

    /** A seam for deterministic tests: called after the pre-lock existence check and before the lock is taken. */
    protected function beforeLock(string $root, string $operation): void {}

    /** Caller holds the management lock. */
    private function snapshotDatabaseLocked(string $root, string $destination, ?SqliteSnapshot $snapshotter): ?array
    {
        $path = $root . '/private/data/application.sqlite';
        if (!is_file($path)) return null;
        return ($snapshotter ?? new SqliteSnapshot())->snapshot($path, $destination);
    }

    /**
     * ONE managed recovery snapshot of an installation (R2-FL-01): the project
     * source and media, the app version, the private host configuration and a
     * consistent database snapshot are captured under a single shared
     * management lock, so an install (which holds the lock exclusively while
     * it activates source and runs migrations) cannot complete between two
     * captures and leave an archive whose source and schema belong to
     * different versions. The lock is released before the caller compresses.
     *
     * @return array{project: array, version: int, manifestId: string, databasePath: ?string, snapshot: ?array, hostConfig: ?array}
     */
    public function captureForBackup(string $appId, string $databaseDestination, ?SqliteSnapshot $snapshotter = null, bool $includeHostSecrets = false): array
    {
        [$root, $lock, $project] = $this->openShared($appId);
        try {
            if ($project === null) throw new RuntimeException('Native app not found', 404);
            $manifest = json_decode((string) ($project['files']['manifest.json'] ?? ''), true);
            $snapshot = $this->snapshotDatabaseLocked($root, $databaseDestination, $snapshotter);
            $hostConfig = $includeHostSecrets ? $this->hostConfig($appId) : null;
            if ($includeHostSecrets && $hostConfig === null) throw new RuntimeException('The native host configuration is missing; the app cannot be captured consistently');
            // The version read AFTER every capture must still be the version read
            // before: with the lock held it cannot differ, and this is the check
            // that says so in the archive.
            $after = $this->get($appId);
            if (($after['version'] ?? null) !== ($project['version'] ?? null)) throw new RuntimeException('The native app changed during capture; retry the backup');
            return [
                'project' => ['files' => is_array($project['files'] ?? null) ? $project['files'] : [], 'assets' => is_array($project['assets'] ?? null) ? $project['assets'] : [], 'version' => (int) ($project['version'] ?? 1), 'home' => (bool) ($project['home'] ?? false), 'access' => (string) ($project['access'] ?? 'application')],
                'version' => (int) ($project['version'] ?? 1),
                'manifestId' => (string) ($manifest['id'] ?? ''),
                'databasePath' => $snapshot !== null ? $databaseDestination : null,
                'snapshot' => $snapshot,
                'hostConfig' => $hostConfig,
            ];
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * Disaster-recovery restore of an installation captured by describe()/get()/snapshotDatabase().
     *
     * - Never overwrites: an existing installation for $appId is an explicit error.
     * - $databaseSnapshot (a closed, verified SQLite file) becomes the private database; without it the
     *   app starts empty and the result says so.
     * - $hostConfig restores the original key material ("restored"); without it a NEW key is generated
     *   and the result reports "reissued" — values sealed/HMACed by the old installation are then
     *   unverifiable, which the caller must surface rather than hide.
     * - Everything is cleaned up on failure; a half-restored app never remains.
     *
     * @return array{version:int, database:string, cryptoMaterial:string}
     */
    public function restore(string $appId, array $project, ?string $databaseSnapshot, ?array $hostConfig): array
    {
        if (!$this->available()) throw new RuntimeException('Prepare the native app runtime before restoring native apps');
        [$files, $decoded, $manifest, $capabilities] = self::validateProject($project);
        $root = $this->root($appId);
        if (is_dir($root) && (is_file($root . '/project.json') || is_dir($root . '/app') || is_file($root . '/private/data/application.sqlite'))) {
            throw new RuntimeException('A native installation already exists for this app; remove it before restoring');
        }
        if ($databaseSnapshot !== null) {
            if (!is_file($databaseSnapshot)) throw new RuntimeException('The native database snapshot is missing');
            $this->assertSnapshotHealthy($databaseSnapshot);
        }
        if ($hostConfig !== null) {
            if (!is_string($hostConfig['keyHex'] ?? null) || !preg_match('/^[0-9a-f]{64}$/', $hostConfig['keyHex']) || ($hostConfig['appId'] ?? null) !== $manifest['id']) {
                throw new InvalidArgumentException('The native host configuration does not belong to this app');
            }
        }
        $this->directory($root);
        $this->directory($root . '/private');
        $this->directory($root . '/private/data');
        $this->beforeLock($root, 'restore');
        $lock = $this->exclusiveLock($root, 'The app is busy. Try again shortly.');
        $staging = $root . '/staging-' . bin2hex(random_bytes(8));
        $writing = false;
        try {
            // Decided under the lock, not before it: an unfinished update is settled first, and
            // the create-only rule is checked against what is there now. Until it passes nothing
            // of ours has been written, so a refusal must not clean anything up.
            $this->resolveJournal($root);
            if (is_file($root . '/project.json') || is_dir($root . '/app') || is_file($root . '/private/data/application.sqlite')) {
                throw new RuntimeException('A native installation already exists for this app; remove it before restoring');
            }
            $writing = true;
            $config = $hostConfig ?? ['appId' => $manifest['id'], 'development' => false, 'keyHex' => bin2hex(random_bytes(32)), 'cryptoDomains' => ['hmac' => $manifest['id'] . ':hmac:v1', 'seal' => $manifest['id'] . ':seal:v1']];
            $config['capabilities'] = $capabilities;
            $config['enableHostContext'] = true;
            $this->writeHostConfig($root . '/private/config.json', json_encode($config, JSON_THROW_ON_ERROR));
            $database = 'none';
            if ($databaseSnapshot !== null) {
                $target = $root . '/private/data/application.sqlite';
                if (!copy($databaseSnapshot, $target) || filesize($target) !== filesize($databaseSnapshot)) throw new RuntimeException('Could not place the restored app database');
                $database = 'restored';
            }
            $this->stageProject($staging, array_merge($files, $decoded));
            if (!rename($staging, $root . '/app')) throw new RuntimeException('Could not activate restored app source');
            $health = $this->invoke($root, ['method' => 'GET', 'path' => '/api/meta', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
            if (($health['status'] ?? 500) !== 200) throw new RuntimeException('Restored native app failed validation: ' . ($health['body']['diagnostic'] ?? 'runtime unavailable'), 422);
            $version = max(1, (int) ($project['version'] ?? 1));
            $saved = ['home' => ($project['home'] ?? false) === true, 'version' => $version, 'updatedAt' => gmdate('c'), 'files' => $files, 'assets' => is_array($project['assets'] ?? null) ? $project['assets'] : [], 'access' => ($project['access'] ?? '') === 'members' ? 'members' : 'application'];
            $this->writeExact($root . '/project.json', json_encode($saved, JSON_THROW_ON_ERROR), 0600);
            return ['version' => $version, 'database' => $database, 'cryptoMaterial' => $hostConfig !== null ? self::CRYPTO_RESTORED : self::CRYPTO_REISSUED];
        } catch (\Throwable $error) {
            flock($lock, LOCK_UN); fclose($lock); $lock = null;
            if ($writing) { try { $this->remove($appId); } catch (\Throwable $cleanup) { error_log('Native restore cleanup: ' . $cleanup->getMessage()); } }
            throw $error;
        } finally {
            if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    private function assertSnapshotHealthy(string $path): void
    {
        // Explicitly closed handle (see SqliteSnapshot::readRows for why that matters on Windows).
        if (class_exists(\SQLite3::class)) {
            $db = new \SQLite3($path, SQLITE3_OPEN_READONLY);
            try { $db->enableExceptions(true); $check = (string) $db->querySingle('PRAGMA quick_check'); }
            catch (\Throwable $e) { $check = $e->getMessage(); }
            finally { $db->close(); }
        } else {
            $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            try { $check = (string) $pdo->query('PRAGMA quick_check')->fetchColumn(); } catch (\Throwable $e) { $check = $e->getMessage(); }
            $pdo = null;
        }
        if ($check !== 'ok') throw new RuntimeException('The native database snapshot failed its integrity check: ' . $check);
    }

    // ── Runtime preflight (audit FL-03) ───────────────────────────────────────

    /**
     * Bounded, non-destructive capability preflight. Distinct failures for: missing/unsupported
     * artifacts, an unrunnable or too-old Node binary, missing built-in modules, a worker that cannot
     * start the engine, and unwritable private storage. Results are cached briefly (invalidated when
     * the runtime files, binary or storage path change) so a public page never forks a worker.
     *
     * Messages name relative files only — never absolute paths or secrets — so they can be shown to
     * an app owner. Operators get the same structure through the admin tooling.
     *
     * @return array{ok:bool, checkedAt:string, cached:bool, checks:list<array{id:string,ok:bool,message:string}>, runtime:array<string,mixed>}
     */
    public function preflight(bool $fresh = false): array
    {
        $cacheFile = $this->storageRoot() . '/.preflight.json';
        $key = $this->preflightKey();
        if (!$fresh && is_file($cacheFile)) {
            $cached = json_decode((string) file_get_contents($cacheFile), true);
            if (is_array($cached) && ($cached['key'] ?? null) === $key && (int) ($cached['at'] ?? 0) > time() - self::PREFLIGHT_TTL && is_array($cached['result'] ?? null)) {
                return ['cached' => true] + $cached['result'];
            }
        }
        $result = $this->runPreflight();
        try {
            $this->directory($this->storageRoot());
            $pending = $cacheFile . '.' . bin2hex(random_bytes(4));
            if (file_put_contents($pending, json_encode(['key' => $key, 'at' => time(), 'result' => $result], JSON_THROW_ON_ERROR)) !== false) rename($pending, $cacheFile);
        } catch (\Throwable $e) { /* caching is best effort */ }
        return ['cached' => false] + $result;
    }

    private function nodeBinary(): string
    {
        return $this->nodeBinary ?? ($_ENV['FORMLOGIC_NODE_BIN'] ?? getenv('FORMLOGIC_NODE_BIN') ?: 'node');
    }

    private function preflightKey(): string
    {
        $parts = [$this->runtime(), $this->storageRoot(), $this->nodeBinary()];
        foreach (['host-protocol.json', 'runner.mjs', 'request-worker.mjs', 'provenance.json', 'wasm/zipp_wasm_bg.wasm'] as $file) {
            $path = $this->runtime() . '/' . $file;
            $parts[] = is_file($path) ? $file . ':' . filemtime($path) . ':' . filesize($path) : $file . ':missing';
        }
        return hash('sha256', implode('|', $parts));
    }

    private function runPreflight(): array
    {
        $checks = [];
        $runtime = [];
        $fail = static function (string $id, string $message) use (&$checks): void { $checks[] = ['id' => $id, 'ok' => false, 'message' => $message]; };
        $pass = static function (string $id, string $message) use (&$checks): void { $checks[] = ['id' => $id, 'ok' => true, 'message' => $message]; };

        function_exists('proc_open') ? $pass('php.proc_open', 'PHP can start worker processes') : $fail('php.proc_open', 'PHP proc_open() is disabled; the native runtime cannot start');
        extension_loaded('pdo_sqlite') ? $pass('php.pdo_sqlite', 'PDO SQLite is available') : $fail('php.pdo_sqlite', 'The pdo_sqlite PHP extension is not loaded');

        $missing = [];
        foreach (['host-protocol.json', 'runner.mjs', 'request-worker.mjs', 'wasm-host.mjs', 'migrations.mjs', 'wasm/zipp_wasm.mjs', 'wasm/zipp_wasm_bg.wasm'] as $file) {
            if (!is_file($this->runtime() . '/' . $file)) $missing[] = $file;
        }
        $missing ? $fail('runtime.files', 'Native runtime is not prepared; missing ' . implode(', ', $missing) . ' (run scripts/prepare-native-runtime.mjs)') : $pass('runtime.files', 'Native runtime artifacts are present');

        $protocol = $missing ? null : json_decode((string) file_get_contents($this->runtime() . '/host-protocol.json'), true);
        if (!is_array($protocol) || ($protocol['nativeProtocol'] ?? null) !== self::NATIVE_PROTOCOL) {
            if (!$missing) $fail('runtime.protocol', 'The prepared runtime does not speak native hosting protocol ' . self::NATIVE_PROTOCOL);
        } else {
            $runtime['nativeProtocol'] = self::NATIVE_PROTOCOL;
            $runtime['recordEvents'] = ($protocol['recordEvents'] ?? null) === self::RECORD_EVENTS_PROTOCOL && is_file($this->runtime() . '/record-events.mjs') ? self::RECORD_EVENTS_PROTOCOL : 0;
            $pass('runtime.protocol', 'Native hosting protocol ' . self::NATIVE_PROTOCOL . ($runtime['recordEvents'] === self::RECORD_EVENTS_PROTOCOL ? ' with record automations' : ' (record automations unavailable)'));
        }
        $provenance = is_file($this->runtime() . '/provenance.json') ? json_decode((string) file_get_contents($this->runtime() . '/provenance.json'), true) : null;
        if (is_array($provenance)) $runtime['zipp'] = ['version' => $provenance['zipp']['version'] ?? null, 'sha256' => $provenance['zipp']['sha256'] ?? null];

        $node = $this->nodeBinary();
        $version = $this->runBounded([$node, '--version'], 8);
        if ($version === null || $version['exit'] !== 0 || !preg_match('/^v?(\d+\.\d+\.\d+)/', trim($version['stdout']), $m)) {
            $fail('node.executable', 'The configured Node.js binary could not be executed (set FORMLOGIC_NODE_BIN to a working Node.js install)');
        } else {
            $runtime['node'] = $m[1];
            $pass('node.executable', 'The configured Node.js binary runs');
            $minimum = is_array($protocol) && is_string($protocol['minimumNode'] ?? null) ? $protocol['minimumNode'] : null;
            if ($minimum !== null && version_compare($m[1], $minimum, '<')) $fail('node.version', 'Node.js ' . $m[1] . ' is older than the runtime minimum ' . $minimum);
            else $pass('node.version', 'Node.js ' . $m[1] . ($minimum !== null ? ' meets the runtime minimum ' . $minimum : ''));
            if (!$missing) {
                $probe = 'const m=[];for(const n of ["node:sqlite","node:worker_threads","node:crypto"]){try{await import(n)}catch{m.push(n)}}'
                    . 'if(typeof WebAssembly!=="object")m.push("WebAssembly");'
                    . 'if(m.length){console.log(JSON.stringify({missing:m}));process.exit(2)}'
                    . 'const fs=await import("node:fs");try{await WebAssembly.compile(fs.readFileSync(process.argv[1]))}catch(e){console.log(JSON.stringify({missing:["zipp-wasm:"+String(e.message).slice(0,80)]}));process.exit(3)}'
                    . 'console.log(JSON.stringify({missing:[]}))';
                $caps = $this->runBounded([$node, '--no-warnings', '--input-type=module', '-e', $probe, $this->runtime() . '/wasm/zipp_wasm_bg.wasm'], 15);
                $decoded = $caps !== null ? json_decode(trim((string) strrchr("\n" . rtrim($caps['stdout']), "\n")), true) : null;
                if ($caps === null) $fail('node.capabilities', 'Node.js did not finish the capability probe within its deadline');
                elseif (!is_array($decoded)) $fail('node.capabilities', 'Node.js could not run the capability probe');
                elseif (!empty($decoded['missing'])) $fail('node.capabilities', 'Node.js is missing required built-ins: ' . implode(', ', array_map('strval', $decoded['missing'])));
                else $pass('node.capabilities', 'Node.js provides SQLite, worker threads, crypto and can compile the ZIPP engine');
            }
        }

        $storageOk = false;
        try {
            $this->directory($this->storageRoot());
            $probeRoot = $this->storageRoot() . '/.preflight-' . bin2hex(random_bytes(6));
            $this->directory($probeRoot);
            try {
                $this->directory($probeRoot . '/private/data');
                if (file_put_contents($probeRoot . '/private/probe.txt', 'ok') !== 2) throw new RuntimeException('write failed');
                $dbPath = $probeRoot . '/private/data/probe.sqlite';
                if (class_exists(\SQLite3::class)) { $db = new \SQLite3($dbPath); try { $db->enableExceptions(true); $db->exec('CREATE TABLE probe(id INTEGER)'); } finally { $db->close(); } }
                else { $pdo = new PDO('sqlite:' . $dbPath, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); $pdo->exec('CREATE TABLE probe(id INTEGER)'); $pdo = null; }
                $storageOk = true;
                $pass('storage.writable', 'Private app storage is writable');
                // Only when everything else passed: start a minimal isolated app in the throw-away root.
                if (!array_filter($checks, static fn ($c) => !$c['ok'])) {
                    $started = $this->probeWorker($probeRoot);
                    $started === null ? $pass('worker.startup', 'A minimal native app started and answered /api/meta') : $fail('worker.startup', $started);
                }
            } finally {
                $this->removeProbeRoot($probeRoot);
            }
        } catch (\Throwable $e) {
            if (!$storageOk) $fail('storage.writable', 'Private app storage is not writable: ' . $e->getMessage());
        }

        $ok = !array_filter($checks, static fn ($c) => !$c['ok']);
        return ['ok' => $ok, 'checkedAt' => gmdate('c'), 'checks' => $checks, 'runtime' => $runtime];
    }

    /** Start a real worker against a throw-away app root; null on success, else the operator message. */
    private function probeWorker(string $root): ?string
    {
        try {
            $manifest = ['id' => 'formlogic.preflight', 'version' => '1.0.0', 'main' => 'ui/main.ui', 'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'database' => ['kind' => 'private-sqlite', 'migrations' => []], 'routes' => []]];
            $files = ['manifest.json' => json_encode($manifest, JSON_THROW_ON_ERROR), 'ui/main.ui' => '<Text>Preflight</Text>', 'server/main.logic' => 'function noop() { return { status: 200, body: {} }; }'];
            foreach ($files as $path => $source) { $this->directory(dirname($root . '/app/' . $path)); file_put_contents($root . '/app/' . $path, $source); }
            $this->writeHostConfig($root . '/private/config.json', json_encode(['appId' => 'formlogic.preflight', 'development' => false, 'keyHex' => bin2hex(random_bytes(32)), 'capabilities' => ['sql'], 'cryptoDomains' => ['hmac' => 'formlogic.preflight:hmac:v1', 'seal' => 'formlogic.preflight:seal:v1'], 'enableHostContext' => true], JSON_THROW_ON_ERROR));
            $health = $this->invoke($root, ['method' => 'GET', 'path' => '/api/meta', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
            if (($health['status'] ?? 500) !== 200) return 'The native worker started but could not validate a minimal app: ' . (string) ($health['body']['diagnostic'] ?? 'runtime unavailable');
            return null;
        } catch (\Throwable $e) {
            return 'The native worker could not start: ' . $e->getMessage();
        }
    }

    private function removeProbeRoot(string $root): void
    {
        $resolved = realpath($root);
        if (!$resolved || !str_starts_with(basename($resolved), '.preflight-')) return;
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($resolved, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $entry) { if ($entry->isLink() || !$entry->isDir()) @unlink($entry->getPathname()); else @rmdir($entry->getPathname()); }
        @rmdir($resolved);
    }

    /** Run a command with a hard deadline; null when it did not finish in time. @return array{exit:int, stdout:string}|null */
    /**
     * The version of the configured Node binary, cached on disk for PREFLIGHT_TTL under a key
     * that names the binary (path, and its mtime/size when the path is a file), so a request
     * costs one `node --version` per minute at most rather than one per request. Null when the
     * binary does not run.
     */
    private function nodeVersion(): ?string
    {
        $node = $this->nodeBinary();
        $key = $node . '|' . (is_file($node) ? filemtime($node) . ':' . filesize($node) : 'path');
        $cacheFile = $this->storageRoot() . '/.node-version.json';
        if (is_file($cacheFile)) {
            $cached = json_decode((string) file_get_contents($cacheFile), true);
            if (is_array($cached) && ($cached['key'] ?? null) === $key && (int) ($cached['at'] ?? 0) > time() - self::PREFLIGHT_TTL && is_string($cached['version'] ?? null)) return $cached['version'];
        }
        $result = $this->runBounded([$node, '--version'], 8);
        if ($result === null || $result['exit'] !== 0 || !preg_match('/^v?(\d+\.\d+\.\d+)/', trim($result['stdout']), $m)) return null;
        try {
            $this->directory($this->storageRoot());
            $pending = $cacheFile . '.' . bin2hex(random_bytes(4));
            if (file_put_contents($pending, json_encode(['key' => $key, 'at' => time(), 'version' => $m[1]], JSON_THROW_ON_ERROR)) !== false) rename($pending, $cacheFile);
        } catch (\Throwable $e) { /* caching is best effort */ }
        return $m[1];
    }

    /**
     * Refuse to start the runtime on a Node binary older than the runtime's own minimum
     * (host-protocol.json `minimumNode`). Preflight reports the same condition for operators,
     * but its result is cached and the binary can change underneath it; a request that would
     * otherwise fail deep inside the worker (node:sqlite is Node 22.5+) gets a clear message.
     */
    private function assertNodeMeetsMinimum(?array $protocol): void
    {
        $minimum = is_array($protocol) && is_string($protocol['minimumNode'] ?? null) ? $protocol['minimumNode'] : null;
        if ($minimum === null) return;
        $version = $this->nodeVersion();
        if ($version === null) throw new RuntimeException('The native runtime\'s Node.js binary could not be executed (set FORMLOGIC_NODE_BIN to a working Node.js install)', 503);
        if (version_compare($version, $minimum, '<')) throw new RuntimeException('Node.js ' . $version . ' is older than the native runtime minimum ' . $minimum . '; update Node.js or FORMLOGIC_NODE_BIN', 503);
    }

    /**
     * The environment the Node runtime is started with: the allowlisted subset of `$source`
     * (normally PHP's own environment) plus the host's own variables, which always win.
     *
     * @param array<string, mixed> $source
     * @param array<string, string> $host
     * @return array<string, string>
     */
    public static function nodeEnvironment(array $source, array $host): array
    {
        $env = [];
        foreach ($source as $name => $value) {
            if (!is_string($name) || !is_scalar($value) || !in_array(strtoupper($name), self::NODE_ENV_ALLOWLIST, true)) continue;
            $env[$name] = (string) $value;
        }
        return array_merge($env, ['NODE_NO_WARNINGS' => '1'], $host);
    }

    private function runBounded(array $command, int $seconds): ?array
    {
        if (!function_exists('proc_open')) return null;
        $out = tempnam(sys_get_temp_dir(), 'fl-preflight-');
        $process = @proc_open($command, [0 => ['pipe', 'r'], 1 => ['file', $out, 'w'], 2 => ['file', $out, 'a']], $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($process)) { @unlink($out); return null; }
        fclose($pipes[0]);
        $deadline = microtime(true) + $seconds;
        try {
            do {
                $status = proc_get_status($process);
                if (!$status['running']) break;
                if (microtime(true) >= $deadline) { proc_terminate($process); return null; }
                usleep(20000);
            } while (true);
            $exit = (int) $status['exitcode'];
            return ['exit' => $exit, 'stdout' => (string) file_get_contents($out)];
        } finally {
            if (is_resource($process)) proc_close($process);
            @unlink($out);
        }
    }

    private function directory(string $path): void
    {
        if (is_link($path)) throw new RuntimeException('App storage is unavailable');
        if (is_dir($path)) return;
        // A file (or anything else) where the directory belongs: mkdir would only warn.
        if (file_exists($path)) throw new RuntimeException('App storage is unavailable');
        if (!mkdir($path, 0700, true) && !is_dir($path)) throw new RuntimeException('App storage is unavailable');
    }

    /** Replace private configuration atomically so a failed write cannot truncate its keys. */
    private function writeHostConfig(string $path, string $source): void
    {
        try { $this->writeExact($path, $source, 0600); }
        catch (RuntimeException $error) { throw new RuntimeException('Could not save host configuration: ' . $error->getMessage(), 0, $error); }
    }

    /**
     * Write $bytes to $path completely or not at all (FL-S02). The bytes go to a private
     * temporary file beside the destination; the count written is compared with the count
     * intended; the data is flushed to disk; only then does the file take the destination's
     * name. A short write — a full disk, a quota, a signal — leaves the previous file in place
     * and throws. PHP's own warning on a partial write is not a signal anyone reads.
     */
    private function writeExact(string $path, string $bytes, int $mode = 0644): void
    {
        $pending = $path . '.pending-' . bin2hex(random_bytes(6));
        try {
            $stream = @fopen($pending, 'xb');
            if ($stream === false) throw new RuntimeException('Could not create a private file in app storage');
            try {
                $written = $this->writeStream($pending, $stream, $bytes);
                if ($written !== strlen($bytes)) throw new RuntimeException('Short write to ' . basename($path) . ': ' . (int) $written . ' of ' . strlen($bytes) . ' bytes');
                if (!fflush($stream)) throw new RuntimeException('Could not flush ' . basename($path));
                if (function_exists('fsync')) fsync($stream);
            } finally { fclose($stream); }
            clearstatcache(true, $pending);
            if (filesize($pending) !== strlen($bytes)) throw new RuntimeException('Short write to ' . basename($path) . ': the file is not the size intended');
            if (!chmod($pending, $mode)) throw new RuntimeException('Could not set permissions on ' . basename($path));
            if (!rename($pending, $path)) throw new RuntimeException('Could not replace ' . basename($path));
        } finally { if (is_file($pending)) @unlink($pending); }
    }

    /**
     * The raw write behind writeExact, in a loop until every byte is out or the stream refuses.
     * A seam: tests make it come up short for a chosen path. @return int|false bytes written
     */
    protected function writeStream(string $path, $stream, string $bytes): int|false
    {
        $total = 0;
        $length = strlen($bytes);
        while ($total < $length) {
            $count = fwrite($stream, substr($bytes, $total));
            if ($count === false || $count === 0) return $total;
            $total += $count;
        }
        return $total;
    }

    /** Stage every source and media file of a project into $staging, each written completely or not at all. */
    private function stageProject(string $staging, array $entries): void
    {
        $this->directory($staging);
        foreach ($entries as $path => $source) {
            $this->directory(dirname($staging . '/' . $path));
            $this->writeExact($staging . '/' . $path, $source, 0644);
        }
    }

    /** rename() with its result as the answer; a seam so a test can make a rollback step fail. */
    protected function renameChecked(string $from, string $to): bool
    {
        return @rename($from, $to);
    }

    // ── The install journal (FL-S03) ─────────────────────────────────────────

    private function readJournal(string $root): ?array
    {
        $path = $root . self::JOURNAL;
        if (!is_file($path)) return null;
        $journal = json_decode((string) file_get_contents($path), true);
        // An unreadable journal is still an unfinished update: nothing may run until an operator looks.
        if (!is_array($journal) || !is_string($journal['phase'] ?? null) || !is_string($journal['operation'] ?? null)) return ['operation' => 'unreadable', 'phase' => 'recovery', 'problems' => ['the install journal could not be read'], 'staging' => '', 'previous' => null, 'snapshot' => null, 'configBackup' => null, 'hadConfig' => true, 'hadDatabase' => true, 'firstInstall' => false];
        return $journal;
    }

    private function writeJournal(string $root, array $journal): void
    {
        $this->writeExact($root . self::JOURNAL, json_encode($journal, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT), 0600);
    }

    private function clearJournal(string $root): void
    {
        $path = $root . self::JOURNAL;
        if (is_file($path) && !unlink($path)) throw new RuntimeException('Could not retire the install journal');
    }

    /** Move the update to its next phase, durably, before the phase's work begins. */
    private function advance(string $root, array &$journal, string $phase): void
    {
        $journal['phase'] = $phase;
        $this->writeJournal($root, $journal);
        $this->afterPhase($root, $phase);
    }

    /** A seam for termination tests: called once the named phase is durable. */
    protected function afterPhase(string $root, string $phase): void {}

    /**
     * Settle whatever a terminated update left behind. Caller holds the exclusive lock.
     * A journal that reached metadata-promoted describes a complete new generation and is rolled
     * forward; any earlier phase is rolled back to the previous generation. A journal already in
     * recovery, or a rollback that cannot complete, leaves the recovery marker and throws.
     */
    private function resolveJournal(string $root): void
    {
        $journal = $this->readJournal($root);
        if ($journal === null) {
            foreach (glob($root . '/staging-*', GLOB_ONLYDIR) ?: [] as $orphan) {
                try { $this->removeStagedSource($root, $orphan); } catch (\Throwable $e) { error_log('Native source cleanup: ' . $e->getMessage()); }
            }
            return;
        }
        if ($journal['phase'] === 'metadata-promoted') $this->rollForward($root, $journal);
        elseif ($journal['phase'] !== 'recovery') $this->rollBack($root, $journal, 'the previous update was interrupted at phase ' . $journal['phase']);
        if (is_file($root . '/private/recovery-required')) throw new RuntimeException('The app needs operator recovery: ' . trim((string) file_get_contents($root . '/private/recovery-required')));
    }

    /** The new generation is complete: retire what the rollback would have needed. Never throws. */
    private function rollForward(string $root, array $journal): void
    {
        try {
            if (is_string($journal['snapshot'] ?? null) && is_file($root . '/private/' . $journal['snapshot'])) unlink($root . '/private/' . $journal['snapshot']);
            if (is_string($journal['configBackup'] ?? null) && is_file($root . '/private/' . $journal['configBackup'])) unlink($root . '/private/' . $journal['configBackup']);
            // Keep one previous source version — this update's — and discard older ones and every staging directory.
            $keep = is_string($journal['previous'] ?? null) ? $journal['previous'] : null;
            foreach (array_merge(glob($root . '/previous-*', GLOB_ONLYDIR) ?: [], glob($root . '/staging-*', GLOB_ONLYDIR) ?: []) as $directory) {
                if ($keep !== null && basename($directory) === $keep) continue;
                try { $this->removeStagedSource($root, $directory); } catch (\Throwable $e) { error_log('Native source cleanup: ' . $e->getMessage()); }
            }
            $this->clearJournal($root);
        } catch (\Throwable $error) {
            error_log('Native install journal could not be retired: ' . $error->getMessage());
        }
    }

    /**
     * Put the previous generation back: source, database, configuration, in that order, each step
     * checked. What the filesystem says happened decides what to undo, so this serves both an
     * exception in a live install and a journal left by a terminated one. When any step cannot be
     * completed the journal is kept in phase `recovery`, the recovery marker is written naming
     * the problems, and every input the operator needs (staging, previous source, snapshot,
     * configuration backup) is retained. Never throws.
     */
    private function rollBack(string $root, array $journal, string $reason): void
    {
        $problems = [];
        $phase = (string) $journal['phase'];
        $staging = $root . '/' . $journal['staging'];
        $previous = is_string($journal['previous'] ?? null) ? $root . '/' . $journal['previous'] : null;
        $database = $root . '/private/data/application.sqlite';
        $sourceTouched = in_array($phase, ['activating', 'source-activated', 'migrated'], true);
        if ($sourceTouched) {
            // The new source is in app/ exactly when staging/ is gone; the old one is in previous/ exactly when it was moved.
            if (is_dir($root . '/app') && !is_dir($staging) && !$this->renameChecked($root . '/app', $staging)) $problems[] = 'move the new source aside';
            if ($previous !== null) {
                if (is_dir($root . '/app')) { if (is_dir($previous)) $problems[] = 'the new source is still active'; }
                elseif (!is_dir($previous)) $problems[] = 'the previous source is missing';
                elseif (!$this->renameChecked($previous, $root . '/app')) $problems[] = 'restore the previous source';
            }
        }
        if (in_array($phase, ['source-activated', 'migrated'], true)) {
            // Migrations may have run: the database goes back to the verified pre-install snapshot,
            // or, for a first install, away.
            if (!empty($journal['hadDatabase'])) {
                $snapshot = is_string($journal['snapshot'] ?? null) ? $root . '/private/' . $journal['snapshot'] : null;
                if ($snapshot === null || !is_file($snapshot)) $problems[] = 'the pre-install database snapshot is missing';
                else {
                    try {
                        $this->assertSnapshotHealthy($snapshot);
                        if (is_file($database)) {
                            $db = new PDO('sqlite:' . $database, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                            $db->exec('PRAGMA wal_checkpoint(TRUNCATE)'); $db = null;
                        }
                        foreach (['-wal', '-shm'] as $suffix) if (is_file($database . $suffix)) unlink($database . $suffix);
                        // Copied, not moved: the snapshot stays until the journal is retired, so a
                        // rollback that fails later still has it.
                        if (!copy($snapshot, $database) || filesize($database) !== filesize($snapshot)) $problems[] = 'restore the database from its snapshot';
                    } catch (\Throwable $error) { $problems[] = 'restore the database: ' . $error->getMessage(); }
                }
            } else {
                foreach (['', '-wal', '-shm'] as $suffix) if (is_file($database . $suffix) && !unlink($database . $suffix)) $problems[] = 'remove the first install\'s database';
            }
        }
        if ($phase !== 'staged') {
            $configPath = $root . '/private/config.json';
            if (!empty($journal['hadConfig'])) {
                $backup = is_string($journal['configBackup'] ?? null) ? $root . '/private/' . $journal['configBackup'] : null;
                if ($backup === null || !is_file($backup)) $problems[] = 'the configuration backup is missing';
                else {
                    try { $this->writeHostConfig($configPath, (string) file_get_contents($backup)); }
                    catch (\Throwable $error) { $problems[] = 'restore the configuration: ' . $error->getMessage(); }
                }
            } elseif (is_file($configPath) && !unlink($configPath)) $problems[] = 'remove the first install\'s configuration';
        }
        if ($problems) {
            $journal['phase'] = 'recovery';
            $journal['problems'] = $problems;
            $journal['reason'] = $reason;
            $message = 'An update could not be rolled back (' . $reason . '). Unfinished: ' . implode('; ', $problems) . '. Inputs are kept under the installation\'s private/ folder and its staging/previous directories; see private/install.json.';
            try { $this->writeJournal($root, $journal); } catch (\Throwable $e) { error_log('Native install journal: ' . $e->getMessage()); }
            try { $this->writeExact($root . '/private/recovery-required', $message, 0600); } catch (\Throwable $e) { error_log('Native recovery marker: ' . $e->getMessage()); }
            error_log('Native app recovery required: ' . $message);
            return;
        }
        // Everything is back: retire the update's inputs and the journal.
        try {
            if (is_dir($staging)) $this->removeStagedSource($root, $staging);
            if (is_string($journal['snapshot'] ?? null) && is_file($root . '/private/' . $journal['snapshot'])) unlink($root . '/private/' . $journal['snapshot']);
            if (is_string($journal['configBackup'] ?? null) && is_file($root . '/private/' . $journal['configBackup'])) unlink($root . '/private/' . $journal['configBackup']);
            $this->clearJournal($root);
        } catch (\Throwable $error) {
            error_log('Native install rollback cleanup: ' . $error->getMessage());
        }
    }

    /** Source inspection requires owner authorization at the controller. Keys and database contents are never included. */
    public function get(string $appId): ?array
    {
        $file = $this->root($appId) . '/project.json';
        return is_file($file) ? json_decode(file_get_contents($file), true, 64, JSON_THROW_ON_ERROR) : null;
    }

    /** Source/schema validation only; never starts a VM, applies migrations or writes storage. */
    public static function validateProject(array $project): array
    {
        $files = $project['files'] ?? null;
        if (!is_array($files) || count($files) > 200 || !is_string($files['manifest.json'] ?? null)) throw new InvalidArgumentException('Include the app manifest and at most 200 source files');
        $bytes = 0;
        foreach ($files as $path => $source) {
            if (!is_string($path) || !preg_match('~^(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\.(?:ui|logic|json|sql)$~D', $path) || str_contains($path, '..') || !is_string($source) || strlen($source) > 1000000) throw new InvalidArgumentException('Invalid app source file');
            $bytes += strlen($source);
        }
        $assets = $project['assets'] ?? [];
        if (!is_array($assets) || count($assets) > 100) throw new InvalidArgumentException('Include at most 100 media files');
        $decoded = [];
        foreach ($assets as $path => $encoded) {
            if (!is_string($path) || !preg_match('~^assets/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\.(?:png|jpg|jpeg|webp|gif|svg|wav|mp3|ogg|woff2?)$~Di', $path) || str_contains($path, '..') || !is_string($encoded)) throw new InvalidArgumentException('Invalid media file');
            $value = base64_decode($encoded, true);
            if ($value === false || strlen($value) > 8 * 1024 * 1024) throw new InvalidArgumentException('Invalid media data');
            $bytes += strlen($value);
            $decoded[$path] = $value;
        }
        if ($bytes > 16 * 1024 * 1024) throw new InvalidArgumentException('Native project exceeds 16 MB');
        $manifest = json_decode($files['manifest.json'], true, 64, JSON_THROW_ON_ERROR);
        $server = $manifest['server'] ?? [];
        if (!is_string($manifest['id'] ?? null) || !preg_match('/^[a-zA-Z0-9._-]{1,120}$/D', $manifest['id']) || !is_string($manifest['main'] ?? null) || !isset($files[$manifest['main']]) || !str_ends_with($manifest['main'], '.ui')) throw new InvalidArgumentException('Invalid native app manifest');
        if (($server['requires']['apiVersion'] ?? null) !== 1 || !is_string($server['entry'] ?? null) || !isset($files[$server['entry']]) || !str_starts_with($server['entry'], 'server/') || !str_ends_with($server['entry'], '.logic')) throw new InvalidArgumentException('Include a server API v1 .logic entry');
        $capabilities = $server['requires']['capabilities'] ?? null;
        if (!is_array($capabilities) || array_diff($capabilities, ['sql', 'crypto', 'time', 'trusted-client-ip', 'transaction-scope', 'photos']) || ($server['sync']['enabled'] ?? false)) throw new InvalidArgumentException('Unsupported native capabilities');
        if (($server['database']['kind'] ?? null) !== 'private-sqlite') throw new InvalidArgumentException('This host requires private SQLite storage');
        foreach ($server['database']['migrations'] ?? [] as $migration) {
            if (!is_string($migration) || !str_starts_with($migration, 'server/migrations/') || !str_ends_with($migration, '.sql') || !isset($files[$migration])) throw new InvalidArgumentException('A declared migration is missing');
        }
        return [$files, $decoded, $manifest, $capabilities];
    }

    /** Caller must own and be deleting this app, or be rolling back its newly generated ID. */
    public function remove(string $appId): void
    {
        $root = $this->root($appId);
        if (!is_dir($root)) return;
        $resolved = realpath($root);
        $parent = realpath(dirname($root));
        if (!$resolved || !$parent || is_link($root) || dirname($resolved) !== $parent || basename($resolved) !== hash('sha256', $appId)) throw new RuntimeException('Unexpected new installation directory');
        $lockPath = $resolved . '/private/manage.lock';
        $lock = is_dir($resolved . '/private') ? fopen($lockPath, 'c') : null;
        if ($lock === false) throw new RuntimeException('Could not lock app storage for removal');
        if ($lock && !flock($lock, LOCK_EX | LOCK_NB)) { fclose($lock); throw new RuntimeException('The app is busy. Try removing it again shortly.', 409); }
        try {
            $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($resolved, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($iterator as $entry) {
                $path = str_replace('\\', '/', $entry->getPathname());
                if ($lock && ($path === str_replace('\\', '/', $lockPath) || $path === str_replace('\\', '/', $resolved . '/private'))) continue;
                if ($entry->isLink() || !$entry->isDir()) { if (!unlink($entry->getPathname())) throw new RuntimeException('Could not remove app storage'); }
                elseif (!rmdir($entry->getPathname())) throw new RuntimeException('Could not remove app storage');
            }
        } finally { if ($lock) { flock($lock, LOCK_UN); fclose($lock); } }
        if (is_file($lockPath)) unlink($lockPath);
        if (is_dir($resolved . '/private')) rmdir($resolved . '/private');
        if (!rmdir($resolved)) throw new RuntimeException('Could not remove app storage');
    }

    public function install(string $appId, array $project, int $expectedVersion): array
    {
        if (!$this->available()) throw new RuntimeException('Prepare the native app runtime before importing this project');
        [$files, $decoded, $manifest, $capabilities] = self::validateProject($project);
        $assets = $project['assets'] ?? [];
        $root = $this->root($appId);
        $this->directory($root);
        $this->directory($root . '/private');
        $this->directory($root . '/private/data');
        $this->beforeLock($root, 'install');
        $lock = $this->exclusiveLock($root, 'The app is busy. Try again shortly.');
        $operation = bin2hex(random_bytes(8));
        $staging = $root . '/staging-' . $operation;
        $configPath = $root . '/private/config.json';
        $database = $root . '/private/data/application.sqlite';
        $journal = null;
        try {
            // Decided under the lock (FL-S04): an update a terminated process left behind is
            // settled first, then the marker, the version and the identity are checked.
            $this->resolveJournal($root);
            $this->assertNotRecoveryRequired($root, 'Restore the app database before installing another update');
            $old = $this->get($appId);
            if (($old['version'] ?? 0) !== $expectedVersion) throw new RuntimeException('The project changed. Reload before importing.', 409);
            if ($old && json_decode($old['files']['manifest.json'], true)['id'] !== $manifest['id']) throw new InvalidArgumentException('Import updates with the same app identity to preserve its database');
            $this->stageProject($staging, array_merge($files, $decoded));
            // The journal is the durable intent (FL-S03): written before anything active changes,
            // advanced before each phase, so a process that dies leaves a record of how far it got.
            $journal = ['operation' => $operation, 'startedAt' => gmdate('c'), 'phase' => 'staged', 'firstInstall' => $old === null, 'oldVersion' => (int) ($old['version'] ?? 0), 'newVersion' => $expectedVersion + 1, 'staging' => basename($staging), 'previous' => null, 'snapshot' => null, 'configBackup' => null, 'hadConfig' => is_file($configPath), 'hadDatabase' => is_file($database)];
            $this->writeJournal($root, $journal);
            $this->afterPhase($root, 'staged');
            if (!is_file($configPath)) {
                $config = ['appId' => $manifest['id'], 'development' => false, 'keyHex' => bin2hex(random_bytes(32)), 'capabilities' => $capabilities, 'cryptoDomains' => ['hmac' => $manifest['id'] . ':hmac:v1', 'seal' => $manifest['id'] . ':seal:v1']];
                $this->writeHostConfig($configPath, json_encode($config, JSON_THROW_ON_ERROR));
            }
            $originalConfig = file_get_contents($configPath);
            if ($originalConfig === false) throw new RuntimeException('Could not read host configuration');
            if ($journal['hadConfig']) {
                $journal['configBackup'] = 'config.previous-' . $operation . '.json';
                $this->writeExact($root . '/private/' . $journal['configBackup'], $originalConfig, 0600);
            }
            $this->advance($root, $journal, 'config-changed');
            $config = json_decode($originalConfig, true, 64, JSON_THROW_ON_ERROR);
            // Owner-authorized updates use the same validated capabilities as a new install.
            // Retain the app identity and cryptographic keys across source updates.
            $config['capabilities'] = $capabilities;
            $config['enableHostContext'] = true;
            $this->writeHostConfig($configPath, json_encode($config, JSON_THROW_ON_ERROR));
            if ($journal['hadDatabase']) {
                $snapshot = 'pre-install-' . $operation . '.sqlite';
                $db = new PDO('sqlite:' . $database, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $db->exec('PRAGMA busy_timeout=1500');
                $db->exec('VACUUM INTO ' . $db->quote($root . '/private/' . $snapshot));
                $db = null;
                // Recorded only once it is known to be a snapshot worth restoring from.
                $this->assertSnapshotHealthy($root . '/private/' . $snapshot);
                $journal['snapshot'] = $snapshot;
            }
            $journal['previous'] = is_dir($root . '/app') ? 'previous-' . $journal['oldVersion'] . '-' . $operation : null;
            $this->advance($root, $journal, 'activating');
            if ($journal['previous'] !== null && !rename($root . '/app', $root . '/' . $journal['previous'])) throw new RuntimeException('Could not stage the update');
            if (!rename($staging, $root . '/app')) throw new RuntimeException('Could not activate app source');
            $this->advance($root, $journal, 'source-activated');
            // This runs the native host's manifest and migration validation, using its real SQLite database.
            $health = $this->invoke($root, ['method' => 'GET', 'path' => '/api/meta', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
            if (($health['status'] ?? 500) !== 200) throw new RuntimeException('Native host validation failed: ' . ($health['body']['diagnostic'] ?? 'runtime unavailable'), 422);
            $this->advance($root, $journal, 'migrated');
            $saved = ['home' => ($project['home'] ?? false) === true, 'version' => $expectedVersion + 1, 'updatedAt' => gmdate('c'), 'files' => $files, 'assets' => $assets, 'access' => ($project['access'] ?? '') === 'members' ? 'members' : 'application'];
            $this->writeExact($root . '/project.json', json_encode($saved, JSON_THROW_ON_ERROR), 0600);
            $this->advance($root, $journal, 'metadata-promoted');
            $this->rollForward($root, $journal);
            $journal = null;
            return $saved;
        } catch (\Throwable $error) {
            if ($journal !== null) {
                if ($journal['phase'] === 'metadata-promoted') $this->rollForward($root, $journal);
                else $this->rollBack($root, $journal, $error->getMessage());
            } elseif (is_dir($staging)) {
                try { $this->removeStagedSource($root, $staging); } catch (\Throwable $cleanupError) { error_log('Native source cleanup: ' . $cleanupError->getMessage()); }
            }
            throw $error;
        } finally {
            flock($lock, LOCK_UN); fclose($lock);
        }
    }

    private function removeStagedSource(string $root, string $directory): void
    {
        $resolved = realpath($directory);
        if (!$resolved || is_link($directory) || dirname($resolved) !== realpath($root) || !preg_match('/^(staging|previous)-[a-zA-Z0-9-]+$/D', basename($resolved))) throw new RuntimeException('Unexpected staging directory');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($resolved, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $entry) {
            if ($entry->isLink() || !$entry->isDir()) unlink($entry->getPathname());
            else rmdir($entry->getPathname());
        }
        rmdir($resolved);
    }

    /**
     * Run one app request. $generation, when given, is the project version the caller's access
     * decision was made against: the request is refused (409) if the installation has moved on.
     */
    public function request(string $appId, array $request, array $identity = [], array $subscriptions = [], ?int $generation = null): array
    {
        [$root, $lock] = $this->openShared($appId, $generation);
        try { return $this->invoke($root, $request, $identity, $subscriptions); }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** Deliver committed events only. Failed delivery leaves the event available for retry. */
    public function dispatchRecordEvents(string $appId, callable $deliver, int $limit = 100): int
    {
        $path = $this->root($appId) . '/private/data/application.sqlite';
        if (!is_file($path)) return 0;
        try { [$root, $manage] = $this->openShared($appId, null, false); }
        catch (RuntimeException $busy) { if ($busy->getCode() === 409) return 0; throw $busy; }
        if ($manage === null) return 0;
        $dispatch = fopen($root . '/private/events.lock', 'c');
        try {
            if (!$dispatch || !flock($dispatch, LOCK_EX | LOCK_NB)) return 0;
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            $db->exec('PRAGMA busy_timeout=1500');
            if (!$db->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_formlogic_record_events'")->fetchColumn()) return 0;
            $events = $db->query('SELECT * FROM _formlogic_record_events ORDER BY created_at, rowid LIMIT ' . max(1, min(500, $limit)))->fetchAll();
            $ack = $db->prepare('DELETE FROM _formlogic_record_events WHERE id=?');
            foreach ($events as $event) {
                $deliver($event['id'], $event['event_name'], json_decode($event['data_json'], true, 64, JSON_THROW_ON_ERROR), json_decode($event['bindings_json'], true, 64, JSON_THROW_ON_ERROR));
                $ack->execute([$event['id']]);
            }
            return count($events);
        } finally {
            foreach ([$dispatch, $manage] as $lock) if (is_resource($lock)) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    private function invoke(string $root, array $request, array $identity = [], array $subscriptions = []): array
    {
        $protocol = json_decode((string) file_get_contents($this->runtime() . '/host-protocol.json'), true);
        if ($subscriptions && (!is_file($this->runtime() . '/record-events.mjs') || ($protocol['recordEvents'] ?? null) !== self::RECORD_EVENTS_PROTOCOL)) throw new RuntimeException('Update the native runtime to enable record automations');
        $this->assertNodeMeetsMinimum(is_array($protocol) ? $protocol : null);
        $base = $root . '/private/request-' . bin2hex(random_bytes(12));
        $input = json_encode($request, JSON_THROW_ON_ERROR);
        if (strlen($input) > 6000000) throw new InvalidArgumentException('Request exceeds the native host limit');
        file_put_contents($base . '.in', $input);
        $process = null;
        // Bound concurrent native workers across every app in this storage root.
        $slots = dirname($root) . '/.runtime-slots';
        $this->directory($slots);
        $slot = null;
        for ($index = 0; $index < 4; $index++) {
            $candidate = fopen($slots . '/' . $index . '.lock', 'c');
            if ($candidate && flock($candidate, LOCK_EX | LOCK_NB)) { $slot = $candidate; break; }
            if ($candidate) fclose($candidate);
        }
        if (!$slot) { unlink($base . '.in'); throw new RuntimeException('The native host is busy. Try again shortly.', 429); }
        try {
            $node = $this->nodeBinary();
            // Only the allowlisted variables reach the runtime (see NODE_ENV_ALLOWLIST); the
            // three SOFTN_* values are the whole host context the worker reads.
            $env = self::nodeEnvironment(getenv(), ['SOFTN_BACKEND_ROOT' => $root, 'SOFTN_HOST_CONTEXT' => json_encode($identity, JSON_THROW_ON_ERROR), 'SOFTN_RECORD_EVENTS' => json_encode($subscriptions, JSON_THROW_ON_ERROR)]);
            $process = proc_open([$node, '--max-old-space-size=128', '--disable-proto=throw', $this->runtime() . '/runner.mjs'], [0 => ['file', $base . '.in', 'r'], 1 => ['file', $base . '.out', 'w'], 2 => ['file', $base . '.err', 'w']], $pipes, $root, $env, ['bypass_shell' => true]);
            if (!is_resource($process)) throw new RuntimeException('Native runtime could not start');
            $deadline = microtime(true) + 25;
            do {
                $status = proc_get_status($process);
                if (!$status['running']) break;
                if (microtime(true) >= $deadline) { proc_terminate($process); throw new RuntimeException('Native request timed out'); }
                usleep(20000);
            } while (true);
            $output = is_file($base . '.out') ? file_get_contents($base . '.out', false, null, 0, 3200000) : '';
            $result = json_decode($output, true);
            if (!is_array($result) || !is_int($result['status'] ?? null) || !array_key_exists('body', $result)) throw new RuntimeException('Native runtime returned no response');
            return $result;
        } finally {
            if (is_resource($process)) proc_close($process);
            flock($slot, LOCK_UN); fclose($slot);
            foreach (['.in', '.out', '.err'] as $suffix) if (is_file($base . $suffix)) unlink($base . $suffix);
        }
    }

    /** Browse the same database used by ZIPP; host metadata and auth secrets are excluded from the table view. */
    public function records(string $appId, ?string $table = null, int $offset = 0, ?int $generation = null): array
    {
        [$root, $lock] = $this->openShared($appId, $generation);
        try { return $this->readRecords($appId, $table, $offset); }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    public function manageRecord(string $appId, array $input, array $subscriptions = [], ?int $generation = null): array
    {
        [$root, $lock] = $this->openShared($appId, $generation);
        try {
            $path = $root . '/private/data/application.sqlite';
            if (!is_file($path)) throw new RuntimeException('App database not found', 404);
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            return (new NativeRecordStore($db))->operate($input, $subscriptions);
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    private function readRecords(string $appId, ?string $table, int $offset): array
    {
        $path = $this->root($appId) . '/private/data/application.sqlite';
        if (!$this->get($appId) || !is_file($path)) throw new RuntimeException('App database not found', 404);
        $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $db->exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN');
        $tables = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1) != '_' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
        if ($table === null) return ['installed' => true, 'tables' => $tables];
        if (!in_array($table, $tables, true)) throw new RuntimeException('Table not found', 404);
        $quoted = '"' . str_replace('"', '""', $table) . '"';
        $columns = $db->query('PRAGMA table_info(' . $quoted . ')')->fetchAll();
        $hidden = '/password|token|secret|code_hash|challenge|encrypted|sealed/i';
        $visible = array_slice(array_values(array_filter(array_column($columns, 'name'), static fn($name) => !preg_match($hidden, $name))), 0, 100);
        // Paging contract (FL-S06): the response says which offset it actually used and why it
        // stops. A requested offset past the window is clamped to it and reported, never
        // silently repeated under a new page number: `end` is 'more' (a next page exists inside
        // the window), 'limit' (rows exist beyond the window; the browser is bounded) or 'end'.
        $effective = min(self::RECORD_OFFSET_LIMIT, max(0, $offset));
        $paging = ['offset' => $effective, 'limit' => self::RECORD_PAGE, 'offsetLimit' => self::RECORD_OFFSET_LIMIT];
        if (!$visible) return ['tables' => $tables, 'columns' => [], 'rows' => [], 'hasMore' => false, 'end' => 'end'] + $paging;
        $select = implode(',', array_map(static function ($name) {
            $column = '"' . str_replace('"', '""', $name) . '"';
            return "CASE WHEN typeof($column)='blob' THEN '[binary]' WHEN typeof($column)='text' THEN substr($column,1,400) ELSE $column END AS $column";
        }, $visible));
        $primary = array_values(array_filter($columns, static fn($column) => $column['pk'] > 0));
        usort($primary, static fn($a, $b) => $a['pk'] <=> $b['pk']);
        // Ordered by the TABLE's columns (t."id"), never by an output alias: the previews and the
        // keys alias every column, and an ORDER BY on a bare name would sort by the alias — the
        // CAST(... AS TEXT) key, as text — and put the keys out of step with the rows.
        $order = $primary ? implode(',', array_map(static fn($column) => 't."' . str_replace('"', '""', $column['name']) . '"', $primary)) : 't.rowid';
        $statement = $db->query('SELECT ' . $select . ' FROM ' . $quoted . ' AS t ORDER BY ' . $order . ' LIMIT ' . (self::RECORD_PAGE + 1) . ' OFFSET ' . $effective);
        $rows = $statement->fetchAll();
        $more = count($rows) > self::RECORD_PAGE;
        $rows = array_slice($rows, 0, self::RECORD_PAGE);
        $end = !$more ? 'end' : ($effective + self::RECORD_PAGE > self::RECORD_OFFSET_LIMIT ? 'limit' : 'more');
        foreach ($rows as &$row) foreach ($row as &$value) if (is_string($value) && strlen($value) > 4000) $value = mb_strcut($value, 0, 4000) . '…';
        $schema = (new NativeRecordStore($db))->schema($table);
        $keys = [];
        if ($schema['primaryKey']) {
            $keySelect = implode(',', array_map(static fn($name) => 'CAST("' . str_replace('"', '""', $name) . '" AS TEXT) AS "' . str_replace('"', '""', $name) . '"', $schema['primaryKey']));
            $keys = $db->query('SELECT ' . $keySelect . ' FROM ' . $quoted . ' AS t ORDER BY ' . $order . ' LIMIT ' . self::RECORD_PAGE . ' OFFSET ' . $effective)->fetchAll();
            $keys = array_map(static fn($key) => in_array(null, $key, true) ? null : $key, $keys);
        }
        return ['tables' => $tables, 'columns' => $visible, 'rows' => $rows, 'hasMore' => $end === 'more', 'end' => $end, 'schema' => $schema, 'keys' => $keys] + $paging;
    }
}
