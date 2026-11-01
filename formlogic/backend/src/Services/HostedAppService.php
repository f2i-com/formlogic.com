<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Support\DataEncryption;
use PDO;
use RuntimeException;
use InvalidArgumentException;

/** Private app deployment + database. App identity is resolved by the controller, never the bundle. */
class HostedAppService
{
    /** Encrypted text takes a third more room, so the 128 MB an app could hold is this many pages now. */
    private const MAX_PAGES = 43700;
    private const COPY_BATCH = 200;
    private const MAX_RECORDS = 10000;
    private const MAX_RECORD_BYTES = 16384;
    private const CHECKPOINT_TRIES = 3;

    public function __construct(private SandboxRunner $runner, private ?string $storagePath = null) {}

    /** Where an app's database is, or would be. Unlike opening it, this creates nothing. */
    public static function databasePath(string $appId, ?string $storagePath = null): string
    {
        if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $appId)) {
            throw new InvalidArgumentException('Invalid app identity');
        }
        return ($storagePath ?? dirname(__DIR__, 2) . '/storage/hosted-apps') . '/' . hash('sha256', $appId) . '.sqlite';
    }

    /**
     * Puts a snapshot in place as an app's database, in one rename. What the app already has is
     * never replaced: it says false, and an undeleted app keeps what it has.
     *
     * Only rows cross, into a database made here, because a backup can be an upload and a SQLite
     * file carries triggers and views as well as data. An upload's deployment also has to pass
     * what publishing asks ($validate). An archive this server kept was checked when published,
     * and later rules must not stop a disaster recovery. Rows arrive plain and are encrypted under
     * the new app's own key.
     */
    public static function restoreDatabase(string $appId, string $snapshot, ?string $storagePath = null, bool $validate = true): bool
    {
        $path = self::databasePath($appId, $storagePath);
        if (is_file($path)) return false;
        $root = dirname($path);
        if (!is_dir($root) && !@mkdir($root, 0700, true) && !is_dir($root)) {
            throw new RuntimeException('App storage is unavailable');
        }
        // A worker killed part way skips the finally below.
        foreach (glob($path . '.restore-*') ?: [] as $stale) {
            if ((int) filemtime($stale) < time() - 3600) @unlink($stale);
        }
        $staged = $path . '.restore-' . bin2hex(random_bytes(4));
        try {
            self::copyRows($appId, $snapshot, $staged, $validate);
            // SQLite replays a -wal it finds beside a database, whichever database wrote it.
            foreach (['-wal', '-shm', '-journal'] as $sidecar) {
                if (is_file($path . $sidecar) && !unlink($path . $sidecar)) throw new RuntimeException('Cannot restore the app database');
            }
            if (!rename($staged, $path)) throw new RuntimeException('Cannot restore the app database');
        } finally {
            if (is_file($staged)) unlink($staged);
        }
        return true;
    }

    private static function copyRows(string $appId, string $snapshot, string $staged, bool $validate): void
    {
        $source = new PDO('sqlite:' . $snapshot, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $source->exec('PRAGMA trusted_schema=OFF');
        $source->exec('PRAGMA query_only=1');
        // A file can make either of these a view that never ends: they have to be tables.
        $tables = $source->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('deployment','records')")->fetchColumn();
        if ((int) $tables !== 2) throw new InvalidArgumentException('This backup does not hold an app database');
        $target = new PDO('sqlite:' . $staged, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $target->exec('PRAGMA max_page_count=' . self::MAX_PAGES);
        self::createTables($target);
        $cipher = HostedRecordCipher::forApp($target, $appId);
        $target->exec('BEGIN IMMEDIATE');
        $deployments = $source->query('SELECT version, package, updated_at FROM deployment WHERE id=1')->fetchAll();
        foreach ($deployments as $deployment) {
            if ($validate) self::checkedPackage(json_decode((string) $deployment['package'], true, 64, JSON_THROW_ON_ERROR));
            $target->prepare('INSERT INTO deployment (id, version, package, updated_at) VALUES (1, ?, ?, ?)')
                ->execute([(int) $deployment['version'], (string) $deployment['package'], (string) $deployment['updated_at']]);
        }
        $insert = $target->prepare('INSERT INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)');
        $copied = 0;
        foreach ($source->query('SELECT collection, id, data, updated_at FROM records') as $record) {
            $data = (string) $record['data'];
            if (HostedRecordCipher::isEncrypted($data)) throw new InvalidArgumentException('This backup holds records encrypted on another server');
            if ($validate && (++$copied > self::MAX_RECORDS || strlen($data) > self::MAX_RECORD_BYTES)) {
                throw new InvalidArgumentException('This backup holds more than an app can');
            }
            $insert->execute([(string) $record['collection'], (string) $record['id'], $cipher->seal((string) $record['collection'], (string) $record['id'], $data), (string) $record['updated_at']]);
        }
        $target->exec('COMMIT');
    }

    private static function createTables(PDO $db): void
    {
        $db->exec('CREATE TABLE IF NOT EXISTS deployment (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, package TEXT NOT NULL, updated_at TEXT NOT NULL)');
        $db->exec('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(collection,id))');
        $db->exec('CREATE INDEX IF NOT EXISTS records_recent ON records(collection,updated_at DESC,id DESC)');
        $db->exec('CREATE TABLE IF NOT EXISTS app_key (id INTEGER PRIMARY KEY CHECK(id=1), wrapped TEXT NOT NULL)');
    }

    private function database(string $appId): PDO
    {
        $path = self::databasePath($appId, $this->storagePath);
        $root = dirname($path);
        if (!is_dir($root) && !mkdir($root, 0700, true) && !is_dir($root)) {
            throw new RuntimeException('App storage is unavailable');
        }
        $db = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $db->exec('PRAGMA busy_timeout=2000');
        // Readers don't wait for a writer, or a writer for readers, as with forms and native apps.
        // Every copy of this file is one read of the database (VACUUM INTO, SqliteSnapshot), so
        // the -wal is in it, and nothing copies the file itself. Changing over needs the file to
        // itself: an app that's busy now stays as it is, and the next connection tries again.
        try { $db->exec('PRAGMA journal_mode=WAL'); } catch (\PDOException) {}
        $db->exec('PRAGMA max_page_count=' . self::MAX_PAGES);
        $db->exec('PRAGMA secure_delete=ON');
        self::createTables($db);
        return $db;
    }

    /** Remove a newly created deployment during a failed pack installation. */
    public function remove(string $appId): void
    {
        self::eraseStorage($appId, $this->storagePath);
    }

    /** Remove an app's database, and SQLite's files beside it. Needs no runner: nothing is run. */
    public static function eraseStorage(string $appId, ?string $storagePath = null): void
    {
        $path = self::databasePath($appId, $storagePath);
        // The database goes last: left on its own it's still whole, and a retry finds it, while a
        // -wal left behind with nothing beside it holds records nothing would look for.
        foreach ([$path . '-wal', $path . '-shm', $path . '-journal', $path] as $file) {
            if (is_file($file) && !unlink($file)) throw new RuntimeException('Cannot remove app deployment');
        }
    }

    /** A consistent SQLite snapshot, including private actions; owner download only. */
    public function snapshot(string $appId): string
    {
        $db = $this->database($appId);
        if (!$db->query('SELECT 1 FROM deployment WHERE id=1')->fetchColumn()) throw new RuntimeException('No hosted project', 404);
        $path = tempnam(sys_get_temp_dir(), 'fl-app-db-');
        if ($path === false) throw new RuntimeException('Cannot prepare database download');
        try {
            $db->prepare('VACUUM INTO ?')->execute([$path]);
            self::decryptCopy($path, $appId);
            return $path;
        } catch (\Throwable $e) { @unlink($path); throw $e; }
    }

    /**
     * Makes a copy of an app's database plain, ready to leave the server: a backup has to open under
     * a new id or on another server, where this app's key means nothing. The key doesn't go with it.
     */
    public static function decryptCopy(string $copy, string $appId): void
    {
        $db = new PDO('sqlite:' . $copy, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $db->exec('PRAGMA trusted_schema=OFF');
        $cipher = HostedRecordCipher::forApp($db, $appId);
        $db->exec('BEGIN IMMEDIATE');
        try {
            self::eachRecord($db, static function (array $row) use ($cipher): string {
                return $cipher->open((string) $row['collection'], (string) $row['id'], (string) $row['data']);
            });
            $db->exec('DROP TABLE IF EXISTS app_key');
            $db->exec('COMMIT');
        } catch (\Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
        $db->exec('VACUUM');
    }

    /**
     * Brings one app's stored records and key onto the current master key.
     *
     * @return int how many records changed
     */
    public static function encryptDatabase(string $path, DataEncryption $crypto): int
    {
        $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $db->exec('PRAGMA busy_timeout=5000');
        $db->exec('PRAGMA secure_delete=ON');
        self::createTables($db);
        $cipher = new HostedRecordCipher($db, basename($path, '.sqlite'), $crypto);
        $db->exec('BEGIN IMMEDIATE');
        try {
            $cipher->rewrapKey();
            $changed = self::eachRecord($db, static function (array $row) use ($cipher): string {
                return $cipher->seal((string) $row['collection'], (string) $row['id'], (string) $row['data']);
            }, true);
            $db->exec('COMMIT');
        } catch (\Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
        // Plain text stays in the file's free pages until this, from this run or from an earlier
        // one that stopped before it got here, or from rows that normal writes have since replaced.
        if ($changed > 0 || (int) $db->query('PRAGMA freelist_count')->fetchColumn() > 0) $db->exec('VACUUM');
        // It stays in the -wal too, for as long as any other connection keeps that file alive. A
        // read running now makes this say busy, and then the old pages are still on disk, so the
        // run can't count as done and the next one comes back here. Each try waits a second.
        $db->exec('PRAGMA busy_timeout=1000');
        for ($try = 0; $try < self::CHECKPOINT_TRIES; $try++) {
            if ((int) $db->query('PRAGMA wal_checkpoint(TRUNCATE)')->fetchAll(PDO::FETCH_NUM)[0][0] === 0) {
                return $changed;
            }
        }
        throw new RuntimeException('The app is being read, so its old pages are still on disk. Run this again.');
    }

    /**
     * Rewrites records in batches, because an app's records can be larger than memory. With
     * $plainOnly it visits rows not yet encrypted, and otherwise only rows that are.
     *
     * @param callable(array<string, mixed>): string $next
     */
    private static function eachRecord(PDO $db, callable $next, bool $plainOnly = false): int
    {
        $select = $db->prepare('SELECT rowid, collection, id, data FROM records WHERE rowid > ? AND substr(data,1,5) ' . ($plainOnly ? '<>' : '=') . ' ? ORDER BY rowid LIMIT ' . self::COPY_BATCH);
        $update = $db->prepare('UPDATE records SET data=? WHERE rowid=?');
        $last = 0;
        $changed = 0;
        do {
            $select->execute([$last, HostedRecordCipher::PREFIX]);
            $rows = $select->fetchAll();
            foreach ($rows as $row) {
                $update->execute([$next($row), $row['rowid']]);
                $last = (int) $row['rowid'];
                $changed++;
            }
        } while (count($rows) === self::COPY_BATCH);
        return $changed;
    }

    public function validate(array $package): array
    {
        return self::checkedPackage($package);
    }

    /** Strict text bundle for the first hosting version; no executable JS/HTML or private files in client output. */
    private static function checkedPackage(array $package): array
    {
        if (($package['version'] ?? null) !== 1 || !is_array($package['client'] ?? null) || !is_array($package['actions'] ?? null)) {
            throw new InvalidArgumentException('Expected version 1, client files and backend actions');
        }
        $files = $package['client'];
        if (count($files) > 100 || !is_string($files['manifest.json'] ?? null)) {
            throw new InvalidArgumentException('Include manifest.json and at most 100 client files');
        }
        // `.py` is client LOGIC written in Python: the name is the whole declaration, the way Softn's
        // shell reads it, and RuntimeEngineService::languagesOf reads the same names to clamp the
        // app onto the one engine that runs Python. Lower case only, like every other extension
        // here — a `.PY` is refused at publish rather than accepted and then run as JavaScript by
        // something that compares case-sensitively. Backend actions below stay JavaScript.
        foreach ($files as $path => $source) {
            if (!is_string($path) || !preg_match('~^(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\.(?:ui|logic|py|json)$~D', $path)
                || str_contains($path, '..') || preg_match('~^(?:server|backend|private)/~i', $path)
                || !is_string($source) || strlen($source) > 200000) {
                throw new InvalidArgumentException('Client files must be .ui, .logic, .py or .json files without private directories (200 KB each)');
            }
        }
        $manifest = json_decode($files['manifest.json'], true);
        if (!is_array($manifest) || !is_string($manifest['main'] ?? null) || !str_ends_with($manifest['main'], '.ui') || !isset($files[$manifest['main']])) {
            throw new InvalidArgumentException('The manifest must name an included .ui entry');
        }
        // Rebuild public metadata. A manifest cannot smuggle server configuration into a download.
        $logic = $manifest['files']['logic'] ?? [];
        if (!is_array($logic) || !array_is_list($logic)) throw new InvalidArgumentException('Invalid logic file list');
        foreach ($logic as $path) {
            if (!is_string($path) || (!str_ends_with($path, '.logic') && !str_ends_with($path, '.py')) || !isset($files[$path])) throw new InvalidArgumentException('Missing client logic file');
        }
        $publicManifest = [
            'name' => mb_substr((string) ($manifest['name'] ?? 'App'), 0, 120),
            'version' => '1.0.0', 'main' => $manifest['main'],
            // Keep module discovery intact when the exported archive becomes a source folder.
            'files' => [
                'ui' => array_values(array_filter(array_keys($files), static fn($path) => str_ends_with($path, '.ui'))),
                'logic' => $logic,
                'json' => array_values(array_filter(array_keys($files), static fn($path) => str_ends_with($path, '.json') && !in_array($path, ['manifest.json', 'permission.json'], true))),
            ],
        ];
        // Python package names are public runtime declarations. Dropping them
        // breaks imports and hides them from the policy check on later loads.
        // Keep only this client field; never copy server configuration or an
        // engine selection from the uploaded manifest into the public bundle.
        $config = json_decode($files['manifest.json'])->config ?? null;
        if ($config instanceof \stdClass && property_exists($config, 'python')) {
            $python = $config->python;
            if (!$python instanceof \stdClass) throw new InvalidArgumentException('config.python must be an object');
            if (property_exists($python, 'packages')) {
                if (!is_array($python->packages)) throw new InvalidArgumentException('config.python.packages must be a list of package names');
                // Match SoftN's supported client package declaration. These are
                // bundled capabilities, never URLs or server-side dependencies.
                foreach ($python->packages as $name) {
                    if ($name !== RuntimeEngineService::TORCH_PACKAGE) throw new InvalidArgumentException('Unsupported Python package; the runtime offers torch');
                }
                $publicManifest['config'] = ['python' => ['packages' => array_values(array_unique($python->packages))]];
            }
        }
        $files['manifest.json'] = json_encode($publicManifest, JSON_THROW_ON_ERROR);
        $files['permission.json'] = '{"permissions":{}}';
        if (count($package['actions']) > 30) throw new InvalidArgumentException('An app can have at most 30 backend actions');
        $actions = [];
        foreach ($package['actions'] as $name => $action) {
            if (!is_string($name) || !preg_match('/^[a-z][a-zA-Z0-9_-]{0,63}$/D', $name) || !is_array($action)
                || !is_string($action['source'] ?? null) || strlen($action['source']) > 50000
                || !in_array($action['access'] ?? null, ['owner', 'member'], true)
                || !in_array($action['mode'] ?? null, ['read', 'write'], true)) {
                throw new InvalidArgumentException('Each action needs a name, .logic source, owner/member access and read/write mode');
            }
            $actions[$name] = array_intersect_key($action, array_flip(['source', 'access', 'mode']));
        }
        $clean = ['version' => 1, 'client' => $files, 'actions' => $actions];
        if (strlen(json_encode($clean, JSON_THROW_ON_ERROR)) > 2 * 1024 * 1024) throw new InvalidArgumentException('App package exceeds 2 MB');
        return $clean;
    }

    /**
     * What the published deployment's client logic is written in, by the one rule
     * ({@see RuntimeEngineService::languagesOf}) applied to the one file list a member's frame
     * receives. Never throws: every caller is deciding an engine, and an unreadable or absent
     * deployment is not a Python app.
     *
     * @return list<string>
     */
    public function clientLanguages(string $appId): array
    {
        try { $deployment = $this->get($appId); }
        catch (\Throwable) { $deployment = null; }
        return RuntimeEngineService::languagesOf($deployment['client'] ?? []);
    }

    public function get(string $appId, bool $private = false): ?array
    {
        if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $appId)) throw new InvalidArgumentException('Invalid app identity');
        $root = $this->storagePath ?? dirname(__DIR__, 2) . '/storage/hosted-apps';
        if (!is_file($root . '/' . hash('sha256', $appId) . '.sqlite')) return null;
        $db = $this->database($appId);
        $row = $db->query('SELECT * FROM deployment WHERE id=1')->fetch();
        if (!$row) return null;
        $package = json_decode($row['package'], true, 64, JSON_THROW_ON_ERROR);
        $result = ['version' => (int) $row['version'], 'updatedAt' => $row['updated_at'], 'client' => $package['client']];
        if ($private) {
            $result['actions'] = $package['actions'];
            $result['recordCount'] = (int) $db->query('SELECT COUNT(*) FROM records')->fetchColumn();
        }
        return $result;
    }

    public function publish(string $appId, array $package, int $expectedVersion): array
    {
        $package = $this->validate($package);
        if (!$this->runner->isAvailable()) throw new RuntimeException('The app script runtime is unavailable');
        $jobs = [];
        foreach ($package['actions'] as $name => $action) {
            // Pure evaluation checks declarations without invoking the handler or granting IO.
            $jobs[] = ['id' => $name, 'expression' => '(function(){' . $action['source'] . "\nreturn typeof onRequest === \"function\";})()"];
        }
        if ($jobs) {
            $checked = $this->runner->evaluateBatch($jobs, [], 1500);
            foreach ($jobs as $job) {
                if (($checked[$job['id']]['ok'] ?? false) !== true || ($checked[$job['id']]['value'] ?? null) !== true) {
                    throw new InvalidArgumentException('Action ' . $job['id'] . ' must contain valid .logic code defining onRequest(ctx)');
                }
            }
        }
        $db = $this->database($appId);
        $db->exec('BEGIN IMMEDIATE');
        try {
            $current = (int) $db->query('SELECT version FROM deployment WHERE id=1')->fetchColumn();
            if ($current !== $expectedVersion) throw new RuntimeException('This app has changed. Reload before publishing.', 409);
            $stmt = $db->prepare('INSERT INTO deployment VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,package=excluded.package,updated_at=excluded.updated_at');
            $stmt->execute([$current + 1, json_encode($package, JSON_THROW_ON_ERROR), gmdate('c')]);
            $db->exec('COMMIT');
        } catch (\Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
        return $this->get($appId, true);
    }

    /** The named action as published, if this caller may run it. */
    private function action(PDO $db, string $actionName, bool $owner): array
    {
        $raw = $db->query('SELECT package FROM deployment WHERE id=1')->fetchColumn();
        $package = $raw ? json_decode($raw, true, 64, JSON_THROW_ON_ERROR) : [];
        $action = $package['actions'][$actionName] ?? null;
        if (!$action || (!$owner && $action['access'] !== 'member')) throw new RuntimeException('Action not found or access denied', 404);
        return $action;
    }

    /** Entire action is one transaction; any host error poisons it even if guest code catches that error. */
    public function run(string $appId, string $actionName, array $input, string $userId, bool $owner): mixed
    {
        if (strlen(json_encode($input, JSON_THROW_ON_ERROR)) > 32768) throw new InvalidArgumentException('Action input exceeds 32 KB');
        $db = $this->database($appId);
        // By hand, not inTransaction(): before PHP 8.4, PDO can't see a transaction opened by exec().
        $open = false;
        try {
            // A read action takes no lock, so any number run at once, and stays in this one read:
            // what it sees doesn't move under it. A write action starts again, because a
            // transaction that has read can't wait for the write lock: SQLite refuses it at once.
            // The action is read again under the lock, as a publish may have changed it since.
            $db->exec('BEGIN');
            $open = true;
            $action = $this->action($db, $actionName, $owner);
            if ($action['mode'] === 'write') {
                $db->exec('ROLLBACK');
                $open = false;
                $db->exec('BEGIN IMMEDIATE');
                $open = true;
                $action = $this->action($db, $actionName, $owner);
            }
            $calls = 0;
            $failed = false;
            $reason = 'Backend action failed';
            $cipher = HostedRecordCipher::forApp($db, $appId);
            $handler = function (string $module, string $method, array $args) use ($db, $cipher, $action, &$calls, &$failed, &$reason): mixed {
                try {
                    // A script may catch the error and carry on, but SQLite can already have rolled
                    // back on its own, and a write after that would commit by itself.
                    if ($failed) throw new RuntimeException('An earlier operation failed');
                    if (++$calls > 50 || $module !== 'db' || $method !== 'getField' || !is_string($args[0] ?? null)) throw new RuntimeException('Unsupported backend operation');
                    $operation = json_decode($args[0], true, 32, JSON_THROW_ON_ERROR);
                    return $this->recordOperation($db, $cipher, $operation, $action['mode'] === 'write');
                } catch (\Throwable $e) {
                    // These are this file's own words ("App record limit reached"). A database
                    // error's, or PHP's own when a script sends the wrong shape, may name paths, so
                    // those stay general.
                    if (!$failed && !$e instanceof \PDOException && !$e instanceof \Error) $reason = $e->getMessage();
                    $failed = true;
                    throw $e;
                }
            };
            // Use the existing sandbox RPC; scripts receive no PDO handle, paths, credentials or network capability.
            $source = $action['source'] . <<<'LOGIC'

function onSubmit(host) {
  function request(op, collection, id, data, limit, offset) {
    return host.db.getField(JSON.stringify({op:op, collection:collection, id:id, data:data, limit:limit, offset:offset}));
  }
  return onRequest({ input: host.answers, requestId: host.meta.requestId, user: {id:host.meta.userId, isOwner:host.meta.isOwner}, db: {
    get: function(collection,id) {return request("get",collection,id);},
    list: function(collection,limit,offset) {return request("list",collection,null,null,limit,offset);},
    put: function(collection,id,data) {return request("put",collection,id,data);},
    remove: function(collection,id) {return request("remove",collection,id);}
  }});
}
LOGIC;
            $done = $this->runner->runScript($source, ['answers' => $input, 'meta' => ['userId' => $userId, 'isOwner' => $owner, 'requestId' => bin2hex(random_bytes(16))]], $handler, 2500);
            if ($failed || isset($done['error'])) throw new RuntimeException($reason . '; database changes were rolled back', 422);
            if (($done['reject'] ?? false) === true) throw new RuntimeException(mb_substr((string) ($done['message'] ?? 'Action rejected'), 0, 300), 422);
            $result = $done['result'] ?? null;
            if (strlen(json_encode($result, JSON_THROW_ON_ERROR)) > 262144) throw new RuntimeException('Action result exceeds 256 KB', 422);
            $db->exec('COMMIT');
            $open = false;
            return $result;
        } catch (\Throwable $e) {
            // SQLite can have ended the transaction itself, and then there is nothing to roll back.
            if ($open) { try { $db->exec('ROLLBACK'); } catch (\PDOException) {} }
            throw $e;
        }
    }

    private function recordOperation(PDO $db, HostedRecordCipher $cipher, array $op, bool $write): mixed
    {
        $collection = $op['collection'] ?? '';
        $id = $op['id'] ?? '';
        if (!is_string($collection) || !preg_match('/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/D', $collection)) throw new InvalidArgumentException('Invalid collection');
        if (($op['op'] ?? '') === 'list') {
            $limit = min(100, max(1, (int) ($op['limit'] ?? 50)));
            $offset = min(10000, max(0, (int) ($op['offset'] ?? 0)));
            $stmt = $db->prepare("SELECT id,data,updated_at FROM records WHERE collection=? ORDER BY updated_at DESC,id DESC LIMIT $limit OFFSET $offset");
            $stmt->execute([$collection]);
            $rows = [];
            $bytes = 0;
            while ($row = $stmt->fetch()) {
                $data = $cipher->open($collection, $row['id'], $row['data']);
                $bytes += strlen($data);
                if ($bytes > 200000) throw new RuntimeException('Page too large; request fewer records');
                $rows[] = ['id' => $row['id'], 'data' => json_decode($data, true), 'updatedAt' => $row['updated_at']];
            }
            return $rows;
        }
        if (!is_string($id) || !preg_match('/^[a-zA-Z0-9_-]{1,128}$/D', $id)) throw new InvalidArgumentException('Invalid record id');
        if ($op['op'] === 'get') {
            $stmt = $db->prepare('SELECT data FROM records WHERE collection=? AND id=?');
            $stmt->execute([$collection, $id]);
            $data = $stmt->fetchColumn();
            return $data === false ? null : json_decode($cipher->open($collection, $id, $data), true);
        }
        if (!$write) throw new RuntimeException('This action is read only');
        if ($op['op'] === 'put') {
            if (!is_array($op['data'] ?? null)) throw new InvalidArgumentException('Record data must be an object');
            $data = json_encode($op['data'], JSON_THROW_ON_ERROR);
            if (strlen($data) > self::MAX_RECORD_BYTES) throw new InvalidArgumentException('Record exceeds 16 KB');
            $exists = $db->prepare('SELECT 1 FROM records WHERE collection=? AND id=?');
            $exists->execute([$collection, $id]);
            if (!$exists->fetchColumn() && (int) $db->query('SELECT COUNT(*) FROM records')->fetchColumn() >= self::MAX_RECORDS) throw new RuntimeException('App record limit reached');
            $stmt = $db->prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at');
            $stmt->execute([$collection, $id, $cipher->seal($collection, $id, $data), gmdate('c')]);
            return ['id' => $id];
        }
        if ($op['op'] === 'remove') {
            $stmt = $db->prepare('DELETE FROM records WHERE collection=? AND id=?');
            $stmt->execute([$collection, $id]);
            return ['removed' => $stmt->rowCount() > 0];
        }
        throw new InvalidArgumentException('Unknown record operation');
    }
}
