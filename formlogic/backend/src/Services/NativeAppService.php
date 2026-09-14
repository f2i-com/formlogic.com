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
 */
class NativeAppService
{
    public const CRYPTO_RESTORED = 'restored';
    public const CRYPTO_REISSUED = 'reissued';

    private const PREFLIGHT_TTL = 60;

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
        $root = $this->root($appId);
        if (is_file($root . '/private/recovery-required')) throw new RuntimeException('The app database needs operator recovery before it can be backed up');
        $lock = $this->sharedLock($root);
        try { return $this->snapshotDatabaseLocked($root, $destination, $snapshotter); }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** Shared management lock, or a 409 while an install/removal holds it exclusively. */
    private function sharedLock(string $root)
    {
        $this->directory($root . '/private');
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_SH | LOCK_NB)) { if ($lock) fclose($lock); throw new RuntimeException('The app is being updated. Try the backup again shortly.', 409); }
        return $lock;
    }

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
        $root = $this->root($appId);
        if (!is_file($root . '/project.json')) throw new RuntimeException('Native app not found', 404);
        $lock = $this->sharedLock($root);
        try {
            if (is_file($root . '/private/recovery-required')) throw new RuntimeException('The app database needs operator recovery before it can be backed up');
            $project = $this->get($appId);
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
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            if ($lock) fclose($lock);
            throw new RuntimeException('The app is busy. Try again shortly.', 409);
        }
        $staging = $root . '/staging-' . bin2hex(random_bytes(8));
        try {
            $config = $hostConfig ?? ['appId' => $manifest['id'], 'development' => false, 'keyHex' => bin2hex(random_bytes(32)), 'cryptoDomains' => ['hmac' => $manifest['id'] . ':hmac:v1', 'seal' => $manifest['id'] . ':seal:v1']];
            $config['capabilities'] = $capabilities;
            $config['enableHostContext'] = true;
            $this->writeHostConfig($root . '/private/config.json', json_encode($config, JSON_THROW_ON_ERROR));
            $database = 'none';
            if ($databaseSnapshot !== null) {
                if (!copy($databaseSnapshot, $root . '/private/data/application.sqlite')) throw new RuntimeException('Could not place the restored app database');
                $database = 'restored';
            }
            $this->directory($staging);
            foreach (array_merge($files, $decoded) as $path => $source) {
                $this->directory(dirname($staging . '/' . $path));
                if (file_put_contents($staging . '/' . $path, $source) === false) throw new RuntimeException('Could not stage app source');
            }
            if (!rename($staging, $root . '/app')) throw new RuntimeException('Could not activate restored app source');
            $health = $this->invoke($root, ['method' => 'GET', 'path' => '/api/meta', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
            if (($health['status'] ?? 500) !== 200) throw new RuntimeException('Restored native app failed validation: ' . ($health['body']['diagnostic'] ?? 'runtime unavailable'), 422);
            $version = max(1, (int) ($project['version'] ?? 1));
            $saved = ['home' => ($project['home'] ?? false) === true, 'version' => $version, 'updatedAt' => gmdate('c'), 'files' => $files, 'assets' => is_array($project['assets'] ?? null) ? $project['assets'] : [], 'access' => ($project['access'] ?? '') === 'members' ? 'members' : 'application'];
            $temp = $root . '/project.pending.json';
            file_put_contents($temp, json_encode($saved, JSON_THROW_ON_ERROR));
            if (!rename($temp, $root . '/project.json')) throw new RuntimeException('Could not save the restored project');
            return ['version' => $version, 'database' => $database, 'cryptoMaterial' => $hostConfig !== null ? self::CRYPTO_RESTORED : self::CRYPTO_REISSUED];
        } catch (\Throwable $error) {
            flock($lock, LOCK_UN); fclose($lock); $lock = null;
            try { $this->remove($appId); } catch (\Throwable $cleanup) { error_log('Native restore cleanup: ' . $cleanup->getMessage()); }
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
        if (!is_array($protocol) || ($protocol['nativeProtocol'] ?? null) !== 1) {
            if (!$missing) $fail('runtime.protocol', 'The prepared runtime does not speak native hosting protocol 1');
        } else {
            $runtime['nativeProtocol'] = 1;
            $runtime['recordEvents'] = ($protocol['recordEvents'] ?? null) === 1 && is_file($this->runtime() . '/record-events.mjs') ? 1 : 0;
            $pass('runtime.protocol', 'Native hosting protocol 1' . ($runtime['recordEvents'] === 1 ? ' with record automations' : ' (record automations unavailable)'));
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
        $pending = $path . '.pending';
        try {
            if (file_put_contents($pending, $source) !== strlen($source) || !chmod($pending, 0600) || !rename($pending, $path)) {
                throw new RuntimeException('Could not save host configuration');
            }
        } finally { if (is_file($pending)) unlink($pending); }
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
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            if ($lock) fclose($lock);
            throw new RuntimeException('The app is busy. Try again shortly.', 409);
        }
        $staging = $root . '/staging-' . bin2hex(random_bytes(8));
        $backup = null;
        $activated = false;
        $snapshot = null;
        $configPath = $root . '/private/config.json';
        $originalConfig = null;
        $configChanged = false;
        try {
            if (is_file($root . '/private/recovery-required')) throw new RuntimeException('Restore the app database before installing another update');
            $old = $this->get($appId);
            if (($old['version'] ?? 0) !== $expectedVersion) throw new RuntimeException('The project changed. Reload before importing.', 409);
            if ($old && json_decode($old['files']['manifest.json'], true)['id'] !== $manifest['id']) throw new InvalidArgumentException('Import updates with the same app identity to preserve its database');
            $this->directory($staging);
            foreach (array_merge($files, $decoded) as $path => $source) {
                $this->directory(dirname($staging . '/' . $path));
                if (file_put_contents($staging . '/' . $path, $source) === false) throw new RuntimeException('Could not stage app source');
            }
            if (!is_file($configPath)) {
                $config = ['appId' => $manifest['id'], 'development' => false, 'keyHex' => bin2hex(random_bytes(32)), 'capabilities' => $capabilities, 'cryptoDomains' => ['hmac' => $manifest['id'] . ':hmac:v1', 'seal' => $manifest['id'] . ':seal:v1']];
                $this->writeHostConfig($configPath, json_encode($config, JSON_THROW_ON_ERROR));
            }
            $originalConfig = file_get_contents($configPath);
            if ($originalConfig === false) throw new RuntimeException('Could not read host configuration');
            $config = json_decode($originalConfig, true, 64, JSON_THROW_ON_ERROR);
            // Owner-authorized updates use the same validated capabilities as a new install.
            // Retain the app identity and cryptographic keys across source updates.
            $config['capabilities'] = $capabilities;
            $config['enableHostContext'] = true;
            $this->writeHostConfig($configPath, json_encode($config, JSON_THROW_ON_ERROR));
            $configChanged = true;
            $database = $root . '/private/data/application.sqlite';
            if (is_file($database)) {
                $snapshot = $root . '/private/pre-install-' . bin2hex(random_bytes(8)) . '.sqlite';
                $db = new PDO('sqlite:' . $database, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $db->exec('PRAGMA busy_timeout=1500');
                $db->exec('VACUUM INTO ' . $db->quote($snapshot));
                $db = null;
            }
            if (is_dir($root . '/app')) {
                $backup = $root . '/previous-' . ($old['version'] ?? 0) . '-' . bin2hex(random_bytes(4));
                if (!rename($root . '/app', $backup)) throw new RuntimeException('Could not stage the update');
            }
            if (!rename($staging, $root . '/app')) throw new RuntimeException('Could not activate app source');
            $activated = true;
            // This runs the native host's manifest and migration validation, using its real SQLite database.
            $health = $this->invoke($root, ['method' => 'GET', 'path' => '/api/meta', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
            if (($health['status'] ?? 500) !== 200) throw new RuntimeException('Native host validation failed: ' . ($health['body']['diagnostic'] ?? 'runtime unavailable'), 422);
            $saved = ['home' => ($project['home'] ?? false) === true, 'version' => $expectedVersion + 1, 'updatedAt' => gmdate('c'), 'files' => $files, 'assets' => $assets, 'access' => ($project['access'] ?? '') === 'members' ? 'members' : 'application'];
            $temp = $root . '/project.pending.json';
            file_put_contents($temp, json_encode($saved, JSON_THROW_ON_ERROR));
            if (!rename($temp, $root . '/project.json')) throw new RuntimeException('Could not save the project');
            if ($snapshot !== null) { unlink($snapshot); $snapshot = null; }
            return $saved;
        } catch (\Throwable $error) {
            if ($configChanged && is_string($originalConfig)) {
                try { $this->writeHostConfig($configPath, $originalConfig); }
                catch (\Throwable $configError) {
                    file_put_contents($root . '/private/recovery-required', 'Restore private/config.json capabilities from the previous manifest before resuming.');
                    error_log('Native app configuration recovery required');
                }
            }
            if ($activated && $snapshot !== null && is_file($snapshot)) {
                try {
                    $db = new PDO('sqlite:' . $root . '/private/data/application.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                    $db->exec('PRAGMA wal_checkpoint(TRUNCATE)'); $db = null;
                    if (!rename($snapshot, $root . '/private/data/application.sqlite')) throw new RuntimeException('Could not restore app database');
                } catch (\Throwable $restoreError) {
                    file_put_contents($root . '/private/recovery-required', basename($snapshot));
                    error_log('Native app database recovery required: ' . $restoreError->getMessage());
                }
            }
            if ($activated && is_dir($root . '/app') && !is_dir($staging)) rename($root . '/app', $staging);
            if ($backup !== null && is_dir($backup)) rename($backup, $root . '/app');
            throw $error;
        } finally {
            if (!is_file($root . '/private/recovery-required')) {
                if ($snapshot !== null && is_file($snapshot)) unlink($snapshot);
                // Keep one previous source version; discarded staging files are not durable backups.
                $previous = glob($root . '/previous-*', GLOB_ONLYDIR) ?: [];
                usort($previous, static fn($a, $b) => (int) explode('-', basename($b))[1] <=> (int) explode('-', basename($a))[1]);
                foreach (array_merge(array_slice($previous, 1), glob($root . '/staging-*', GLOB_ONLYDIR) ?: []) as $discard) {
                    try { $this->removeStagedSource($root, $discard); }
                    catch (\Throwable $cleanupError) { error_log('Native source cleanup: ' . $cleanupError->getMessage()); }
                }
            }
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

    public function request(string $appId, array $request, array $identity = [], array $subscriptions = []): array
    {
        $root = $this->root($appId);
        if (!$this->get($appId)) throw new RuntimeException('Native app not found', 404);
        if (is_file($root . '/private/recovery-required')) throw new RuntimeException('The app database needs operator recovery');
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_SH | LOCK_NB)) {
            if ($lock) fclose($lock);
            throw new RuntimeException('The app is being updated. Try again shortly.', 409);
        }
        try { return $this->invoke($root, $request, $identity, $subscriptions); }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** Deliver committed events only. Failed delivery leaves the event available for retry. */
    public function dispatchRecordEvents(string $appId, callable $deliver, int $limit = 100): int
    {
        $root = $this->root($appId);
        $path = $root . '/private/data/application.sqlite';
        if (!is_file($path)) return 0;
        if (is_file($root . '/private/recovery-required')) throw new RuntimeException('The app database needs operator recovery');
        $manage = fopen($root . '/private/manage.lock', 'c');
        $dispatch = fopen($root . '/private/events.lock', 'c');
        try {
            if (!$manage || !$dispatch || !flock($manage, LOCK_SH | LOCK_NB) || !flock($dispatch, LOCK_EX | LOCK_NB)) return 0;
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
        if ($subscriptions && (!is_file($this->runtime() . '/record-events.mjs') || (json_decode(file_get_contents($this->runtime() . '/host-protocol.json'), true)['recordEvents'] ?? null) !== 1)) throw new RuntimeException('Update the native runtime to enable record automations');
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
            $node = $this->nodeBinary ?? ($_ENV['FORMLOGIC_NODE_BIN'] ?? getenv('FORMLOGIC_NODE_BIN') ?: 'node');
            $env = array_merge(getenv(), ['SOFTN_BACKEND_ROOT' => $root, 'NODE_NO_WARNINGS' => '1', 'SOFTN_HOST_CONTEXT' => json_encode($identity, JSON_THROW_ON_ERROR), 'SOFTN_RECORD_EVENTS' => json_encode($subscriptions, JSON_THROW_ON_ERROR)]);
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
    public function records(string $appId, ?string $table = null, int $offset = 0): array
    {
        $root = $this->root($appId);
        if (!$this->get($appId)) throw new RuntimeException('Native app not found', 404);
        if (is_file($root . '/private/recovery-required')) throw new RuntimeException('The app database needs operator recovery');
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_SH | LOCK_NB)) {
            if ($lock) fclose($lock);
            throw new RuntimeException('The app is being updated. Try again shortly.', 409);
        }
        try { return $this->readRecords($appId, $table, $offset); }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    public function manageRecord(string $appId, array $input, array $subscriptions = []): array
    {
        $root = $this->root($appId);
        $path = $root . '/private/data/application.sqlite';
        if (!$this->get($appId) || !is_file($path)) throw new RuntimeException('App database not found', 404);
        if (is_file($root . '/private/recovery-required')) throw new RuntimeException('The app database needs operator recovery');
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_SH | LOCK_NB)) {
            if ($lock) fclose($lock);
            throw new RuntimeException('The app is being updated. Try again shortly.', 409);
        }
        try {
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
        if (!$visible) return ['tables' => $tables, 'columns' => [], 'rows' => [], 'hasMore' => false];
        $select = implode(',', array_map(static function ($name) {
            $column = '"' . str_replace('"', '""', $name) . '"';
            return "CASE WHEN typeof($column)='blob' THEN '[binary]' WHEN typeof($column)='text' THEN substr($column,1,400) ELSE $column END AS $column";
        }, $visible));
        $primary = array_values(array_filter($columns, static fn($column) => $column['pk'] > 0));
        usort($primary, static fn($a, $b) => $a['pk'] <=> $b['pk']);
        $order = $primary ? implode(',', array_map(static fn($column) => '"' . str_replace('"', '""', $column['name']) . '"', $primary)) : 'rowid';
        $statement = $db->query('SELECT ' . $select . ' FROM ' . $quoted . ' ORDER BY ' . $order . ' LIMIT 51 OFFSET ' . min(100000, max(0, $offset)));
        $rows = $statement->fetchAll();
        $more = count($rows) > 50;
        $rows = array_slice($rows, 0, 50);
        foreach ($rows as &$row) foreach ($row as &$value) if (is_string($value) && strlen($value) > 4000) $value = mb_strcut($value, 0, 4000) . '…';
        $schema = (new NativeRecordStore($db))->schema($table);
        $keys = [];
        if ($schema['primaryKey']) {
            $keySelect = implode(',', array_map(static fn($name) => 'CAST("' . str_replace('"', '""', $name) . '" AS TEXT) AS "' . str_replace('"', '""', $name) . '"', $schema['primaryKey']));
            $keys = $db->query('SELECT ' . $keySelect . ' FROM ' . $quoted . ' ORDER BY ' . $order . ' LIMIT 50 OFFSET ' . min(100000, max(0, $offset)))->fetchAll();
            $keys = array_map(static fn($key) => in_array(null, $key, true) ? null : $key, $keys);
        }
        return ['tables' => $tables, 'columns' => $visible, 'rows' => $rows, 'hasMore' => $more, 'schema' => $schema, 'keys' => $keys];
    }
}
