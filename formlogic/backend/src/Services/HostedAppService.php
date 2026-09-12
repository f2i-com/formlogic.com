<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;
use RuntimeException;
use InvalidArgumentException;

/** Private app deployment + database. App identity is resolved by the controller, never the bundle. */
class HostedAppService
{
    public function __construct(private SandboxRunner $runner, private ?string $storagePath = null) {}

    private function database(string $appId): PDO
    {
        if (!preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $appId)) {
            throw new InvalidArgumentException('Invalid app identity');
        }
        $root = $this->storagePath ?? dirname(__DIR__, 2) . '/storage/hosted-apps';
        if (!is_dir($root) && !mkdir($root, 0700, true) && !is_dir($root)) {
            throw new RuntimeException('App storage is unavailable');
        }
        $db = new PDO('sqlite:' . $root . '/' . hash('sha256', $appId) . '.sqlite', null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $db->exec('PRAGMA busy_timeout=2000');
        $db->exec('PRAGMA max_page_count=32768');
        $db->exec('CREATE TABLE IF NOT EXISTS deployment (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, package TEXT NOT NULL, updated_at TEXT NOT NULL)');
        $db->exec('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(collection,id))');
        $db->exec('CREATE INDEX IF NOT EXISTS records_recent ON records(collection,updated_at DESC,id DESC)');
        return $db;
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
            return $path;
        } catch (\Throwable $e) { @unlink($path); throw $e; }
    }

    /** Strict text bundle for the first hosting version; no executable JS/HTML or private files in client output. */
    public function validate(array $package): array
    {
        if (($package['version'] ?? null) !== 1 || !is_array($package['client'] ?? null) || !is_array($package['actions'] ?? null)) {
            throw new InvalidArgumentException('Expected version 1, client files and backend actions');
        }
        $files = $package['client'];
        if (count($files) > 100 || !is_string($files['manifest.json'] ?? null)) {
            throw new InvalidArgumentException('Include manifest.json and at most 100 client files');
        }
        foreach ($files as $path => $source) {
            if (!is_string($path) || !preg_match('~^(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\.(?:ui|logic|json)$~D', $path)
                || str_contains($path, '..') || preg_match('~^(?:server|backend|private)/~i', $path)
                || !is_string($source) || strlen($source) > 200000) {
                throw new InvalidArgumentException('Client files must be .ui, .logic or .json files without private directories (200 KB each)');
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
            if (!is_string($path) || !str_ends_with($path, '.logic') || !isset($files[$path])) throw new InvalidArgumentException('Missing client logic file');
        }
        $files['manifest.json'] = json_encode([
            'name' => mb_substr((string) ($manifest['name'] ?? 'App'), 0, 120),
            'version' => '1.0.0', 'main' => $manifest['main'],
            'files' => ['logic' => $logic],
        ], JSON_THROW_ON_ERROR);
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

    public function get(string $appId, bool $private = false): ?array
    {
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

    /** Entire action is one transaction; any host error poisons it even if guest code catches that error. */
    public function run(string $appId, string $actionName, array $input, string $userId, bool $owner): mixed
    {
        if (strlen(json_encode($input, JSON_THROW_ON_ERROR)) > 32768) throw new InvalidArgumentException('Action input exceeds 32 KB');
        $db = $this->database($appId);
        $db->exec('BEGIN IMMEDIATE');
        try {
            $raw = $db->query('SELECT package FROM deployment WHERE id=1')->fetchColumn();
            $package = $raw ? json_decode($raw, true, 64, JSON_THROW_ON_ERROR) : [];
            $action = $package['actions'][$actionName] ?? null;
            if (!$action || (!$owner && $action['access'] !== 'member')) throw new RuntimeException('Action not found or access denied', 404);
            $calls = 0;
            $failed = false;
            $handler = function (string $module, string $method, array $args) use ($db, $action, &$calls, &$failed): mixed {
                try {
                    if (++$calls > 50 || $module !== 'db' || $method !== 'getField' || !is_string($args[0] ?? null)) throw new RuntimeException('Unsupported backend operation');
                    $operation = json_decode($args[0], true, 32, JSON_THROW_ON_ERROR);
                    return $this->recordOperation($db, $operation, $action['mode'] === 'write');
                } catch (\Throwable $e) { $failed = true; throw $e; }
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
            if ($failed || isset($done['error'])) throw new RuntimeException('Backend action failed; database changes were rolled back', 422);
            if (($done['reject'] ?? false) === true) throw new RuntimeException(mb_substr((string) ($done['message'] ?? 'Action rejected'), 0, 300), 422);
            $result = $done['result'] ?? null;
            if (strlen(json_encode($result, JSON_THROW_ON_ERROR)) > 262144) throw new RuntimeException('Action result exceeds 256 KB', 422);
            $db->exec('COMMIT');
            return $result;
        } catch (\Throwable $e) {
            $db->exec('ROLLBACK');
            throw $e;
        }
    }

    private function recordOperation(PDO $db, array $op, bool $write): mixed
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
                $bytes += strlen($row['data']);
                if ($bytes > 200000) throw new RuntimeException('Page too large; request fewer records');
                $rows[] = ['id' => $row['id'], 'data' => json_decode($row['data'], true), 'updatedAt' => $row['updated_at']];
            }
            return $rows;
        }
        if (!is_string($id) || !preg_match('/^[a-zA-Z0-9_-]{1,128}$/D', $id)) throw new InvalidArgumentException('Invalid record id');
        if ($op['op'] === 'get') {
            $stmt = $db->prepare('SELECT data FROM records WHERE collection=? AND id=?');
            $stmt->execute([$collection, $id]);
            $data = $stmt->fetchColumn();
            return $data === false ? null : json_decode($data, true);
        }
        if (!$write) throw new RuntimeException('This action is read only');
        if ($op['op'] === 'put') {
            if (!is_array($op['data'] ?? null)) throw new InvalidArgumentException('Record data must be an object');
            $data = json_encode($op['data'], JSON_THROW_ON_ERROR);
            if (strlen($data) > 16384) throw new InvalidArgumentException('Record exceeds 16 KB');
            $exists = $db->prepare('SELECT 1 FROM records WHERE collection=? AND id=?');
            $exists->execute([$collection, $id]);
            if (!$exists->fetchColumn() && (int) $db->query('SELECT COUNT(*) FROM records')->fetchColumn() >= 10000) throw new RuntimeException('App record limit reached');
            $stmt = $db->prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at');
            $stmt->execute([$collection, $id, $data, gmdate('c')]);
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
