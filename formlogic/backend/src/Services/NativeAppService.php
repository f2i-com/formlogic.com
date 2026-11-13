<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\SqliteSnapshot;
use FormLogic\Support\Environment;
use InvalidArgumentException;
use RuntimeException;
use PDO;

/**
 * Owner-managed native SoftN installations. Runtime code is operator supplied; uploads contain data and DSL source only.
 *
 * Three different questions, answered by three different methods (audit FL-03):
 *  - available()  — are the runtime ARTIFACTS prepared on this host? Cheap file/extension checks only.
 *  - preflight()  — can the runtime actually RUN here? Checks the runner (softn-runner, or the
 *                   configured Node binary and its engine), starts a throw-away app in a temporary
 *                   root and proves private storage is writable. Bounded, non-destructive, briefly
 *                   cached.
 *  - install()'s /api/meta health call — is THIS app's source and migration state usable?
 *
 * The runner: a Softn release from v0.0.26 carries softn-runner (native-runtime/bin), which answers
 * the same requests as Softn's runner.mjs without Node, the app's logic in ZIPP under wasmtime. On a
 * server it is built for (Linux or Windows, x86-64) it is the runner; elsewhere, with an older
 * release, or with FORMLOGIC_NATIVE_RUNNER=node, Node runs runner.mjs as before.
 *
 * Storage layout under root(appId) (audit FL-02 inventory):
 *  - app/                          active source (restorable, portable)
 *  - project.json                  source + media + version/home/access (restorable, portable)
 *  - private/data/application.sqlite   records + migration state + record-event queue (restorable, account data)
 *  - private/config.json           host-generated key material + capabilities (restorable ONLY through a
 *                                  privileged recovery backup; otherwise reissued and reported as such)
 *  - private/manage.lock, events.lock, staging-*, previous-*, pre-install-*.sqlite,
 *    config.previous-*.json, project.previous-*.json, recovery-required
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

    /**
     * An app's media, by path: the kinds the SoftN frame serves its page (Softn v0.0.28's
     * apps/formlogic-host/src/media.ts; the UI's HOSTED_MEDIA is the same list).
     */
    public const MEDIA_PATH = '~^assets/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\.(?:png|jpe?g|gif|webp|avif|ico|bmp|svg|hdr|exr|mp3|wav|ogg|opus|aac|flac|m4a|mp4|webm|woff2?|ttf|otf|glb|gltf|obj|stl|fbx|bin|wgsl|txt|md)$~Di';
    /**
     * A JavaScript app's built files, by path: someone's compiled front end (the dist or build
     * folder of their project), kept whole under site/ whatever its layout. Unlike everything
     * else a project holds, these are documents and scripts a browser runs as they are, so they
     * are never handed to the SoftN frame and never served from this site's own origin as a
     * page: SiteAppController sends each one under a sandbox (no origin, no cookies, no network
     * but the app's own files). The UI's SITE_PATH (lib/siteApps.ts) is the same rule.
     *
     * The kinds are what a build is made of: pages, scripts, styles, data, pictures, fonts,
     * sound, video, 3D models and what a game's build carries (.data, .pck, .unityweb). A file
     * packed for the browser (.br, .gz) is kept as it is and sent as what it holds. The rule reads
     * a name's endings in lower case (isSitePath), so IMG_0001.JPG is a .jpg. Nothing a server
     * runs is among them, and no name holds such an ending in its middle either (SITE_RUNS):
     * a web server that reads every ending of a name would run shell.php.js as PHP, were this
     * folder ever served by one.
     */
    public const SITE_PATH = '~^site/(?:[a-zA-Z0-9_.@+\~-]+/)*[a-zA-Z0-9_.@+\~-]+\.(?:html?|js|mjs|cjs|css|json|map|svg|png|jpe?g|gif|webp|avif|ico|cur|bmp|tiff?|jxl|woff2?|ttf|ttc|otf|eot|mp3|wav|ogg|opus|aac|flac|m4a|midi?|mp4|m4v|mov|webm|ogv|vtt|srt|wasm|txt|xml|webmanifest|md|csv|tsv|ya?ml|toml|geojson|ndjson|rss|atom|ics|pdf|zip|glb|gltf|bin|data|dat|mem|pck|pak|unityweb|atlas|fnt|ktx2?|basis|hdr|obj|mtl|dds|tga|ply|stl|usdz|riv|lottie|glsl|vert|frag|wgsl)(?:\.(?:br|gz))?$~D';
    /** Endings a web server may run, wherever in a name they stand: no site file has one. The UI's SITE_RUNS is the same list. */
    public const SITE_RUNS = '~\.(?:php\d?|phtml|phar|phps|cgi|pl|asp|aspx|ashx|jsp|jspx|shtml)(?:\.|$)~Di';
    /** A site file's name is at most this long, folders included. */
    public const MAX_SITE_PATH_LENGTH = 240;

    /** Whether a path is one a built site may keep: the rule, no `..`, and no folder or file that starts with a dot. */
    public static function isSitePath(mixed $path): bool
    {
        if (!is_string($path) || strlen($path) > self::MAX_SITE_PATH_LENGTH || str_contains($path, '..') || preg_match('~(?:^|/)\.~', $path) === 1) return false;
        if (preg_match(self::SITE_RUNS, $path) === 1) return false;
        // The name's endings are read in lower case: what a camera or an old tool wrote in capitals
        // (.JPG, .PNG) is the same kind of file.
        $name = strrpos($path, '/');
        $dot = strpos($path, '.', $name === false ? 0 : $name + 1);
        return preg_match(self::SITE_PATH, $dot === false ? $path : substr($path, 0, $dot) . strtolower(substr($path, $dot))) === 1;
    }

    /**
     * The first page of a project's built site (`site/…`), or null for a project that has none:
     * a SoftN app. Read from the manifest's `site` block, which an install has already checked.
     *
     * @param array<string, mixed> $project
     */
    public static function siteEntry(array $project): ?string
    {
        $manifest = is_string($project['files']['manifest.json'] ?? null) ? json_decode($project['files']['manifest.json'], true) : null;
        $entry = is_array($manifest) && is_array($manifest['site'] ?? null) ? ($manifest['site']['entry'] ?? null) : null;
        return is_string($entry) && self::isSitePath('site/' . $entry) && isset($project['assets']['site/' . $entry]) ? $entry : null;
    }
    /**
     * What a project may hold, which the app page's import (nativeHosting.ts) reads first and a
     * test holds equal: a game's art and sound run to hundreds of files and tens of megabytes.
     * A source file may be 1,500,000 bytes: an app's server logic is one file (the runner reads
     * `server.entry` and nothing else), and a studio's whole library lives in it. The runner
     * compiles that file for every request, about 160 ms for each 1,000,000 bytes of code.
     * A migration stays at 1,000,000: the runner reads no more of one (its "Migration size").
     */
    public const MAX_SOURCE_FILES = 200;
    /**
     * A source file's name: a SoftN app's pages (`.html`; `.ui` in an app made before SoftN's HTML
     * pages), page logic (`.js`; `.logic` before; `.py`), stylesheets (`.css`), its manifest and
     * other JSON, seed data (`.xdb`), and a backend's `.logic` and `.sql`. All are text the app's
     * frame or its runner is handed; none is ever served as a file of this site. The app page's
     * import reads the same list first (ui/src/lib/nativeHosting.ts).
     */
    public const SOURCE_PATH = '~^(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_.-]+\.(?:html|ui|js|logic|py|css|json|sql|xdb)$~D';
    /** Said where a file of another kind is refused. */
    public const SOURCE_KINDS = 'An app\'s source files are .html or .ui pages, .js or .logic page logic (.py for Python), .css, .json, .xdb seed data, and a backend\'s server/….logic and server/migrations/….sql; pictures, sound and other media go under assets/.';
    public const MAX_SOURCE_FILE_BYTES = 1500000;
    public const MAX_MIGRATION_BYTES = 1000000;
    public const MAX_MEDIA_FILES = 1000;
    public const MAX_MEDIA_FILE_BYTES = 8 * 1024 * 1024;
    public const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
    /**
     * An app's media as one file its page fetches whole (runtimeProject, NativeAppController's
     * media route): these eight bytes, the header's length in four bytes big-endian, the header
     * as JSON ({"files":[{"path","offset","size"}]}, offsets from the end of the header), then
     * each file's bytes in that order. One request and one cached download for the lot, where the
     * page was sent every picture and sound in base64 inside the project's JSON on each opening.
     */
    public const MEDIA_PACK_MAGIC = 'FLMEDIA1';
    private const RUNTIME_CACHE = '/runtime-cache';

    private const PREFLIGHT_TTL = 60;

    /**
     * Waiting out another connection's lock while a rollback restores the database: SQLite's busy
     * timeout in one attempt, the time all attempts may take together, how many attempts there are
     * and the pause between them. The total stays small because the exclusive management lock is
     * held throughout.
     */
    private const RESTORE_BUSY_MS = 1500;
    private const RESTORE_BUDGET_MS = 2500;
    private const RESTORE_ATTEMPTS = 3;
    private const RESTORE_PAUSE_MS = 150;

    /** The install journal, relative to the installation root. */
    private const JOURNAL = '/private/install.json';
    /** The runner's queue of committed record events (SoftN's record_events.rs), delivered by dispatchRecordEvents(). */
    private const RECORD_OUTBOX = '_formlogic_record_events';
    /** A photo waiting to be redrawn once the request holds its worker slots (visitorRequest, invoke); never sent on. */
    private const PHOTO_PENDING = "\0photo";
    /** The tables SQLite keeps for itself that an app's database may have; any other `sqlite_` name is not one. */
    private const SQLITE_OWN = ['sqlite_sequence', 'sqlite_stat1', 'sqlite_stat2', 'sqlite_stat3', 'sqlite_stat4'];


    /** Records browsing: rows per page unless another size is asked for, and the furthest offset a page may start at (NativeRecordStore::browse). */
    public const RECORD_PAGE = NativeRecordStore::PAGE;
    public const RECORD_OFFSET_LIMIT = NativeRecordStore::OFFSET_LIMIT;

    /** The longest a request runs, and so how long an update waits for those already running. */
    private const UPDATE_WAIT_SECONDS = 30;

    /**
     * Environment variables the Node runtime is allowed to inherit from PHP. Everything else
     * (database credentials, API keys, whatever the operator's .env put in the process
     * environment) stays with PHP: the guest cannot read process.env, but the runtime should
     * not hold secrets it has no use for. Compared case-insensitively (Windows).
     */
    private const NODE_ENV_ALLOWLIST = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];

    /**
     * Workers across every app here, and how many of them any one app may hold. A worker is held
     * for a whole request, and a query can run for about twenty seconds, so without the second
     * number one app's visitors could turn every other app away. A site with one busy app can
     * raise it with NATIVE_WORKERS_PER_APP.
     */
    private const WORKERS = 4;
    private const WORKERS_PER_APP = 2;

    /** softn-runner as a Softn release carries it in native-runtime/bin, by the server it runs on (x86-64). */
    private const RUNNER_BINARIES = ['Linux' => 'softn-runner-linux-x86_64', 'Windows' => 'softn-runner-windows-x86_64.exe'];

    /**
     * $runner: 'auto' starts softn-runner where the runtime carries it for this server, and Node
     * otherwise; 'node' runs runner.mjs under Node whatever the runtime carries; null reads
     * FORMLOGIC_NATIVE_RUNNER (`auto`, the default, or `node`).
     */
    public function __construct(private ?string $storagePath = null, private ?string $runtimePath = null, private ?string $nodeBinary = null, private ?string $runner = null) {}

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
     * @return array{manifestId:string, version:int, home:bool, access:string, capabilities:list<string>, hasDatabase:bool, recoveryRequired:bool, updateUnfinished:bool}|null
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
            'recoveryRequired' => is_file($root . '/private/recovery-required') || ($this->readJournal($root)['phase'] ?? null) === 'recovery',
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
        $pending = $root . '/private/update.pending';
        clearstatcache(true, $pending);
        if (is_file($pending) && (int) filemtime($pending) > time() - self::UPDATE_WAIT_SECONDS) {
            throw new RuntimeException('The app is being updated. Try again shortly.', 409);
        }
        $lock = fopen($root . '/private/manage.lock', 'c');
        if (!$lock || !flock($lock, LOCK_SH | LOCK_NB)) { if ($lock) fclose($lock); throw new RuntimeException('The app is being updated. Try again shortly.', 409); }
        return $lock;
    }

    /** Exclusive management lock for an install, restore or removal; a 409 when anyone else holds it. */
    private function exclusiveLock(string $root, string $busy, bool $wait = false)
    {
        $this->directory($root . '/private');
        $lock = fopen($root . '/private/manage.lock', 'c');
        $held = $lock && flock($lock, LOCK_EX | LOCK_NB);
        if ($lock && !$held && $wait) {
            // Requests overlap on a busy app, so a holder could always be found: new ones are
            // turned away (see sharedLock) while the ones running finish. A crash leaves the
            // marker behind, and it stops counting after the same time.
            $pending = $root . '/private/update.pending';
            touch($pending);
            for ($until = microtime(true) + self::UPDATE_WAIT_SECONDS; !$held && microtime(true) < $until; $held = flock($lock, LOCK_EX | LOCK_NB)) {
                usleep(100000);
            }
            @unlink($pending);
        }
        if (!$held) { if ($lock) fclose($lock); throw new RuntimeException($busy, 409); }
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
     * project.json (every file and base64 asset) is decoded only when the caller needs the project
     * or a generation check; event delivery and database snapshots need neither.
     *
     * @return array{0:string, 1:resource|null, 2:array|null} root, the held shared lock, the project (null when not read)
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
            $project = $requireProject || $generation !== null ? $this->get($appId) : null;
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
        self::assertOwnDatabase($path);
        return ($snapshotter ?? new SqliteSnapshot())->snapshot($path, $destination);
    }

    /**
     * An app's database is the file in its own data folder, never a link. PHP follows a link when
     * it opens, snapshots or vacuums the database, so one left there (by the app's own server
     * logic, were it ever to get out of its sandbox) would hand the app's owner another app's
     * records, or any SQLite file this account can read, through the records, backup and update
     * paths. The runner refuses such a database too and, locked down on Linux, cannot make a link
     * at all; this is FormLogic's own side of that boundary.
     */
    private static function linkedDatabase(string $path): bool
    {
        return is_link($path) || is_link(dirname($path)) || is_link(dirname($path, 2));
    }

    private static function assertOwnDatabase(string $path): void
    {
        if (self::linkedDatabase($path)) throw new RuntimeException('The app\'s database is a link, not its own file', 409);
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
        [$files, $decoded, $manifest, $capabilities] = self::validateProject($project);
        // An app with no backend runs nothing on this server: it needs no runner to be restored.
        if (array_key_exists('server', $manifest) && !$this->available()) throw new RuntimeException('Prepare the native app runtime before restoring native apps');
        // Restored under a new app id: an app that declares no id keeps the identity its keys were
        // made under, which the captured configuration names. That identity is the runner's to
        // compare, so it is held to the form a manifest id has before it is used anywhere.
        $captured = is_string($hostConfig['appId'] ?? null) && preg_match('/^[a-zA-Z0-9._-]{1,120}$/D', $hostConfig['appId']) ? $hostConfig['appId'] : null;
        $identity = self::identity($manifest, $appId, $captured);
        $root = $this->root($appId);
        if (is_dir($root) && (is_file($root . '/project.json') || is_dir($root . '/app') || is_file($root . '/private/data/application.sqlite'))) {
            throw new RuntimeException('A native installation already exists for this app; remove it before restoring');
        }
        if ($databaseSnapshot !== null) {
            if (!is_file($databaseSnapshot)) throw new RuntimeException('The native database snapshot is missing');
            $this->assertSnapshotHealthy($databaseSnapshot);
        }
        if ($hostConfig !== null) {
            if (!is_string($hostConfig['keyHex'] ?? null) || !preg_match('/^[0-9a-f]{64}$/', $hostConfig['keyHex']) || ($hostConfig['appId'] ?? null) !== $identity) {
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
            $config = $hostConfig ?? ['appId' => $identity, 'development' => false, 'keyHex' => bin2hex(random_bytes(32)), 'cryptoDomains' => ['hmac' => $identity . ':hmac:v1', 'seal' => $identity . ':seal:v1']];
            $config['capabilities'] = $capabilities;
            $config['enableHostContext'] = true;
            $this->writeHostConfig($root . '/private/config.json', json_encode($config, JSON_THROW_ON_ERROR));
            $database = 'none';
            if ($databaseSnapshot !== null) {
                $target = $root . '/private/data/application.sqlite';
                if (!copy($databaseSnapshot, $target) || !$this->sameSize($target, $databaseSnapshot)) throw new RuntimeException('Could not place the restored app database');
                $database = 'restored';
            }
            $this->stageProject($staging, array_merge(self::runnerFiles($files, $manifest, $identity), $decoded));
            if (!rename($staging, $root . '/app')) throw new RuntimeException('Could not activate restored app source');
            // A client-only app has no backend to start, so there is nothing for the runner to check.
            if (array_key_exists('server', $manifest)) {
                $health = $this->invoke($root, ['method' => 'GET', 'path' => '/api/meta', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
                if (($health['status'] ?? 500) !== 200) throw new RuntimeException('Restored native app failed validation: ' . ($health['body']['diagnostic'] ?? 'runtime unavailable'), 422);
            }
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

    /**
     * Whether a copy landed whole. The sizes are read after clearing PHP's stat
     * cache for both paths: an earlier is_file()/filesize() on the destination
     * leaves its old size cached, and copy() does not invalidate it (PHP 8.2
     * answered the stale size and called a complete restore short).
     */
    private function sameSize(string $copy, string $original): bool
    {
        clearstatcache(true, $copy);
        clearstatcache(true, $original);
        return filesize($copy) === filesize($original);
    }

    /**
     * Updating an installed app snapshots its database first and, when the update fails, restores
     * it from that snapshot through SQLite's backup API (the sqlite3 extension; PDO has none).
     * Refused before anything is created, locked or changed, so a host without the extension
     * leaves the installation as it was. A first install has no database to restore, and serving
     * and restore() never use the backup API, so none of them needs the extension.
     */
    private function assertCanRestoreDatabase(string $database): void
    {
        if (is_file($database) && !extension_loaded('sqlite3')) {
            throw new RuntimeException('Updating this app needs the sqlite3 PHP extension (it restores the database if an update fails). Enable it and try again.', 422);
        }
    }

    /**
     * A snapshot is used only if SQLite can open it, it holds at least one page and `quick_check`
     * passes. A lock on the snapshot is waited out like the restore's own locks; one that does not
     * clear is reported as a snapshot that could not be checked, not as a damaged one.
     */
    private function assertSnapshotHealthy(string $path, int $busyMs = self::RESTORE_BUSY_MS): void
    {
        // Explicitly closed handle (see SqliteSnapshot::readRows for why that matters on Windows).
        $pages = 0;
        $check = '';
        $locked = null;
        if (class_exists(\SQLite3::class)) {
            try { $db = new \SQLite3($path, SQLITE3_OPEN_READONLY); }
            catch (\Throwable $e) { throw new RuntimeException('The snapshot could not be opened: ' . $e->getMessage(), 0, $e); }
            try {
                $db->enableExceptions(true);
                $db->busyTimeout($busyMs);
                $pages = (int) $db->querySingle('PRAGMA page_count');
                $check = (string) $db->querySingle('PRAGMA quick_check');
            } catch (\Throwable $e) {
                $code = $db->lastErrorCode();
                if (self::isTransientSqliteError($code)) $locked = [$e->getMessage(), $code];
                else $check = $e->getMessage();
            }
            finally { $db->close(); }
        } else {
            $pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            try {
                $pdo->exec('PRAGMA busy_timeout=' . $busyMs);
                $pages = (int) $pdo->query('PRAGMA page_count')->fetchColumn();
                $check = (string) $pdo->query('PRAGMA quick_check')->fetchColumn();
            } catch (\Throwable $e) {
                $code = $e instanceof \PDOException ? (int) ($e->errorInfo[1] ?? 0) : 0;
                if (self::isTransientSqliteError($code)) $locked = [$e->getMessage(), $code];
                else $check = $e->getMessage();
            }
            $pdo = null;
        }
        if ($locked !== null) throw new RuntimeException('The native database snapshot could not be checked because it is locked: ' . $locked[0], $locked[1]);
        if ($check !== 'ok') throw new RuntimeException('The native database snapshot failed its integrity check: ' . $check);
        // A snapshot with no pages passes quick_check as an empty database, and restoring it would
        // empty the live one. VACUUM INTO and SqliteSnapshot never write one.
        if ($pages < 1) throw new RuntimeException('The native database snapshot is empty (it has no pages)');
    }

    /** SQLite's BUSY (5) and LOCKED (6), whichever extended code carries them: another connection holds a lock, which can pass. */
    private static function isTransientSqliteError(int $code): bool
    {
        return in_array($code & 0xFF, [5, 6], true);
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
     * `ok` means the runtime can run here. A check marked `warning` (not ok, listed in `checks` and
     * repeated in `warnings`) limits something without stopping it, and does not count against `ok`.
     *
     * @return array{ok:bool, checkedAt:string, cached:bool, checks:list<array{id:string,ok:bool,warning?:bool,message:string}>, warnings:list<string>, runtime:array<string,mixed>}
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

    /**
     * The command a native request's worker is started with. One definition: preflight starts
     * Node with the same options, so a Node that refuses one fails the check and not every
     * request.
     *
     * The two wasm options keep V8's optimizing compiler off the engine. A worker lives for one
     * request, and the engine's dispatch loop is one WebAssembly function of 280 KB: V8 begins
     * optimizing it as soon as it runs hot, which takes about 450 ms and over 100 MB, and a
     * process cannot exit while that compile runs. So every request waited about a third of a
     * second after its answer was written, with a core busy, for code nothing would run. Both
     * options are needed: without tier-up alone V8 still tiers up dynamically, and without
     * dynamic tiering alone it optimizes everything. A request that runs past about three
     * quarters of a second misses the optimized code and is slower for it (Softn's own PHP host,
     * which starts its runner the same way, measured up to a quarter).
     * @return list<string>
     */
    public static function runnerCommand(string $node, string $runtime): array
    {
        return [$node, '--max-old-space-size=128', '--disable-proto=throw', '--no-wasm-tier-up', '--no-wasm-dynamic-tiering', $runtime . '/runner.mjs'];
    }

    private function nodeBinary(): string
    {
        return $this->nodeBinary ?? ($_ENV['FORMLOGIC_NODE_BIN'] ?? getenv('FORMLOGIC_NODE_BIN') ?: 'node');
    }

    /**
     * The softn-runner binary that runs the runtime on this server, or null when Node runs it: the
     * runtime carries none for this server (an older release, or not Linux/Windows on x86-64), or
     * Node was asked for. Zip extraction and the release fetch drop the execute bit; it is put back
     * here, as install.php does for the sandbox launcher, and preflight says when it cannot be.
     */
    private function runnerBinary(): ?string
    {
        $choice = $this->runner ?? ($_ENV['FORMLOGIC_NATIVE_RUNNER'] ?? getenv('FORMLOGIC_NATIVE_RUNNER') ?: 'auto');
        if (strtolower(trim((string) $choice)) === 'node') return null;
        $name = self::RUNNER_BINARIES[PHP_OS_FAMILY] ?? null;
        if ($name === null || !in_array(strtolower(php_uname('m')), ['x86_64', 'amd64'], true)) return null;
        $path = $this->runtime() . '/bin/' . $name;
        if (!is_file($path)) return null;
        if (PHP_OS_FAMILY !== 'Windows' && !is_executable($path)) @chmod($path, 0755);
        return $path;
    }

    private function preflightKey(): string
    {
        $runner = $this->runnerBinary();
        $parts = [$this->runtime(), $this->storageRoot(), $runner ?? $this->nodeBinary()];
        foreach (['host-protocol.json', 'runner.mjs', 'request-worker.mjs', 'provenance.json', 'wasm/zipp_wasm_bg.wasm', ...($runner !== null ? ['bin/' . basename($runner)] : [])] as $file) {
            $path = $this->runtime() . '/' . $file;
            $parts[] = is_file($path) ? $file . ':' . filemtime($path) . ':' . filesize($path) : $file . ':missing';
        }
        return hash('sha256', implode('|', $parts));
    }

    private function runPreflight(): array
    {
        $checks = [];
        $warnings = [];
        $runtime = [];
        $fail = static function (string $id, string $message) use (&$checks): void { $checks[] = ['id' => $id, 'ok' => false, 'message' => $message]; };
        $pass = static function (string $id, string $message) use (&$checks): void { $checks[] = ['id' => $id, 'ok' => true, 'message' => $message]; };
        // A check that is not met but does not stop the runtime: listed with the others (not ok, marked
        // as a warning), its message repeated in `warnings`, and left out of the verdict.
        $warn = static function (string $id, string $message) use (&$checks, &$warnings): void { $checks[] = ['id' => $id, 'ok' => false, 'warning' => true, 'message' => $message]; $warnings[] = $message; };
        $failed = static fn (array $check): bool => !$check['ok'] && empty($check['warning']);

        function_exists('proc_open') ? $pass('php.proc_open', 'PHP can start worker processes') : $fail('php.proc_open', 'PHP proc_open() is disabled; the native runtime cannot start');
        extension_loaded('pdo_sqlite') ? $pass('php.pdo_sqlite', 'PDO SQLite is available') : $fail('php.pdo_sqlite', 'The pdo_sqlite PHP extension is not loaded');
        extension_loaded('sqlite3') ? $pass('php.sqlite3', 'SQLite online restore is available') : $warn('php.sqlite3', 'The sqlite3 PHP extension is not loaded. Apps can be installed for the first time and served without it, but updating an app that already has a database needs it to restore that database if the update fails. Enable it (the php-sqlite3 package, or extension=sqlite3 in php.ini).');

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
        $runner = $this->runnerBinary();
        $version = $runner !== null ? null : $this->runBounded([$node, '--version'], 8);
        if ($runner !== null) {
            // softn-runner needs no Node: whether it can start is the worker probe below.
            $runtime['runner'] = basename($runner);
            if (PHP_OS_FAMILY === 'Windows' || is_executable($runner)) $pass('runner.executable', 'The native runtime runs on softn-runner, without Node.js');
            else $fail('runner.executable', 'Zip extraction drops the execute bit and it could not be restored: run chmod +x on resources/softn-native/bin/' . basename($runner) . ' in the API folder');
        } elseif ($version === null || $version['exit'] !== 0 || !preg_match('/^v?(\d+\.\d+\.\d+)/', trim($version['stdout']), $m)) {
            $fail('node.executable', 'The configured Node.js binary could not be executed (set FORMLOGIC_NODE_BIN to a working Node.js install)');
        } else {
            $runtime['node'] = $m[1];
            $pass('node.executable', 'The configured Node.js binary runs');
            $minimum = is_array($protocol) && is_string($protocol['minimumNode'] ?? null) ? $protocol['minimumNode'] : null;
            if ($minimum !== null && version_compare($m[1], $minimum, '<')) $fail('node.version', 'Node.js ' . $m[1] . ' is older than the runtime minimum ' . $minimum);
            else $pass('node.version', 'Node.js ' . $m[1] . ($minimum !== null ? ' meets the runtime minimum ' . $minimum : ''));
            // The options a worker is started with (runnerCommand): a Node that refuses one would
            // refuse to start for every request, and say so only in a file nobody reads.
            $options = array_slice(self::runnerCommand($node, $this->runtime()), 1, -1);
            $accepted = $this->runBounded([$node, ...$options, '-e', '0'], 8);
            if ($accepted === null || $accepted['exit'] !== 0) $fail('node.options', 'Node.js refused an option the native runtime is started with (' . implode(' ', $options) . '): update Node.js');
            else $pass('node.options', 'Node.js accepts the options the native runtime is started with');
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
                if (!array_filter($checks, $failed)) {
                    $started = $this->probeWorker($probeRoot);
                    $started === null ? $pass('worker.startup', 'A minimal native app started and answered /api/meta') : $fail('worker.startup', $started);
                }
            } finally {
                $this->removeProbeRoot($probeRoot);
            }
        } catch (\Throwable $e) {
            if (!$storageOk) $fail('storage.writable', 'Private app storage is not writable: ' . $e->getMessage());
        }

        $ok = !array_filter($checks, $failed);
        return ['ok' => $ok, 'checkedAt' => gmdate('c'), 'checks' => $checks, 'warnings' => $warnings, 'runtime' => $runtime];
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

    /**
     * The files the runner is given: the project's own, except that a manifest declaring no id
     * names the identity the installation runs under, which the runner holds its configuration
     * to. The project as stored (and as its owner downloads it) is left exactly as uploaded.
     *
     * @param array<string, string> $files
     * @return array<string, string>
     */
    private static function runnerFiles(array $files, array $manifest, string $identity): array
    {
        // A manifest that names its id is given as it is, byte for byte.
        if (is_string($manifest['id'] ?? null)) return $files;
        try {
            // Decoded again as objects, so an empty object stays one in the runner's copy.
            $object = json_decode($files['manifest.json'], false, 64, JSON_THROW_ON_ERROR);
            if (!$object instanceof \stdClass) return $files;
            $object->id = $identity;
            $files['manifest.json'] = json_encode($object, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        } catch (\JsonException) {
            // A key PHP cannot keep as a property, or a number too large to write back.
            throw new InvalidArgumentException('manifest.json declares no id and cannot be read back to name one: give it an id, such as "id": "com.example.notes"');
        }
        return $files;
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

    /** file_get_contents() with false as the failure; a seam so a test can make a read fail. */
    protected function readChecked(string $path): string|false
    {
        return @file_get_contents($path);
    }

    private function readJournal(string $root): ?array
    {
        $path = $root . self::JOURNAL;
        if (!is_file($path)) return null;
        $raw = $this->readChecked($path);
        if ($raw === false) {
            // A read that failed says nothing about the journal's content. Gone since the check (an
            // update retired it while describe(), which holds no lock, was reading): no journal.
            // Still there: busy, try again — never recovery for what may be a passing error.
            clearstatcache(true, $path);
            if (!is_file($path)) return null;
            throw new RuntimeException('The app is being updated. Try again shortly.', 409);
        }
        $journal = json_decode($raw, true);
        // A journal that reads but does not decode is still an unfinished update: nothing may run until an operator looks.
        if (!is_array($journal) || !is_string($journal['phase'] ?? null) || !is_string($journal['operation'] ?? null)) return ['operation' => 'unreadable', 'phase' => 'recovery', 'problems' => ['the install journal could not be read'], 'reason' => 'an unfinished update left an unreadable journal', 'staging' => '', 'previous' => null, 'snapshot' => null, 'configBackup' => null, 'projectBackup' => null, 'hadConfig' => true, 'hadDatabase' => true, 'firstInstall' => false];
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
     * A seam for termination tests: called inside a phase once one of its steps has changed the
     * disk and before the next phase is durable — `config-created` (a first install's
     * config.json, phase staged), `backups-written` (the configuration and project backups, phase
     * staged), `snapshot-taken` (VACUUM INTO, before its health check, phase config-changed),
     * `project-written` (the new project.json, phase migrated).
     */
    protected function afterStep(string $root, string $step): void {}

    /**
     * Settle whatever a terminated update left behind. Caller holds the exclusive lock.
     * A journal that reached metadata-promoted describes a complete new generation and is rolled
     * forward; any earlier phase is rolled back to the previous generation. A journal in phase
     * recovery — left so, undecodable, or because this rollback could not complete — IS recovery
     * required: the marker is written again if an operator removed it without finishing (or it
     * could not be written), and this throws either way. Nothing runs, overwrites the journal or
     * retires the inputs it names until the journal itself is gone.
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
        $marker = $root . '/private/recovery-required';
        if ($journal['phase'] === 'recovery' && !is_file($marker)) {
            try { $this->writeExact($marker, $this->recoveryMessage($journal), 0600); } catch (\Throwable $e) { error_log('Native recovery marker: ' . $e->getMessage()); }
        }
        if ($journal['phase'] === 'recovery' || is_file($marker)) throw new RuntimeException('The app needs operator recovery: ' . $this->withoutPaths($root, is_file($marker) ? trim((string) file_get_contents($marker)) : $this->recoveryMessage($journal)));
    }

    /**
     * $text with this installation's absolute location (and app storage's) replaced by a relative
     * label. The recovery refusal reaches the app's owner, and the reason it carries can be a live
     * install's exception naming a file by its full path (SQLite's VACUUM INTO does); a marker
     * written before this may hold one too. The journal, the marker and the log keep the full text
     * for the operator.
     */
    private function withoutPaths(string $root, string $text): string
    {
        $labels = [];
        foreach ([[$root, 'the installation'], [$this->storageRoot(), 'app storage']] as [$path, $label]) {
            foreach (array_filter([$path, realpath($path)]) as $location) {
                foreach ([$location, str_replace('\\', '/', $location), str_replace('/', '\\', $location)] as $spelling) {
                    $labels[$spelling . '/'] = $labels[$spelling . '\\'] = $label . '\'s ';
                    $labels[$spelling] = $label;
                }
            }
        }
        return str_ireplace(array_keys($labels), array_values($labels), $text);
    }

    /** What the recovery marker says about a journal in phase recovery. */
    private function recoveryMessage(array $journal): string
    {
        return 'An update could not be rolled back (' . (string) ($journal['reason'] ?? 'no reason was recorded') . '). Unfinished: ' . implode('; ', array_map('strval', (array) ($journal['problems'] ?? []))) . '. Inputs are kept under the installation\'s private/ folder and its staging/previous directories; see private/install.json.';
    }

    /** Delete each file the journal names that exists: the snapshot and the configuration and project backups. */
    private function retireBackups(string $root, array $journal): void
    {
        foreach (['snapshot', 'configBackup', 'projectBackup'] as $artifact) {
            if (is_string($journal[$artifact] ?? null) && is_file($root . '/private/' . $journal[$artifact])) unlink($root . '/private/' . $journal[$artifact]);
        }
    }

    /** The new generation is complete: retire what the rollback would have needed. Never throws. */
    private function rollForward(string $root, array $journal): void
    {
        try {
            $this->retireBackups($root, $journal);
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
     * Put the previous generation back: source, database, configuration, project metadata, in that
     * order, each step checked. What the filesystem says happened decides what to undo, so this
     * serves both an exception in a live install and a journal left by a terminated one. When any
     * step cannot be completed $journal moves to phase `recovery` — on disk and in the recovery
     * marker (naming the problems) when those writes succeed, in the caller's $journal regardless —
     * and every input the operator needs (staging, previous source, snapshot, configuration and
     * project backups) is retained. Never throws.
     */
    private function rollBack(string $root, array &$journal, string $reason): void
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
                        $this->restoreDatabaseWithRetry($snapshot, $database);
                    } catch (\Throwable $error) { $problems[] = 'restore the database: ' . $error->getMessage(); }
                }
            } else {
                foreach (['', '-wal', '-shm'] as $suffix) if (is_file($database . $suffix) && !unlink($database . $suffix)) $problems[] = 'remove the first install\'s database';
            }
        }
        $configPath = $root . '/private/config.json';
        if (empty($journal['hadConfig'])) {
            // A first install creates config.json while still staged: it goes in every phase.
            if (is_file($configPath) && !unlink($configPath)) $problems[] = 'remove the first install\'s configuration';
        } elseif ($phase !== 'staged') {
            $backup = is_string($journal['configBackup'] ?? null) ? $root . '/private/' . $journal['configBackup'] : null;
            if ($backup === null || !is_file($backup)) $problems[] = 'the configuration backup is missing';
            else {
                try { $this->writeHostConfig($configPath, (string) file_get_contents($backup)); }
                catch (\Throwable $error) { $problems[] = 'restore the configuration: ' . $error->getMessage(); }
            }
        }
        if ($phase === 'migrated') {
            // project.json is replaced in this phase. It is written whole or not at all, so it names
            // either the old version (nothing to undo — also how a journal from before project
            // backups existed settles) or the new one, which goes: removed for a first install,
            // otherwise replaced by the exact bytes kept before the update changed anything.
            $projectPath = $root . '/project.json';
            $installed = empty($journal['firstInstall']) && is_file($projectPath) ? json_decode((string) file_get_contents($projectPath), true) : null;
            if (!empty($journal['firstInstall'])) {
                if (is_file($projectPath) && !unlink($projectPath)) $problems[] = 'remove the first install\'s project metadata';
            } elseif ((int) ($installed['version'] ?? -1) !== (int) ($journal['oldVersion'] ?? 0)) {
                $backup = is_string($journal['projectBackup'] ?? null) ? $root . '/private/' . $journal['projectBackup'] : null;
                if ($backup === null || !is_file($backup)) $problems[] = 'the project metadata backup is missing';
                else {
                    try { $this->writeExact($projectPath, (string) file_get_contents($backup), 0600); }
                    catch (\Throwable $error) { $problems[] = 'restore the project metadata: ' . $error->getMessage(); }
                }
            }
        }
        if ($problems) {
            $journal['phase'] = 'recovery';
            $journal['problems'] = $problems;
            $journal['reason'] = $reason;
            $message = $this->recoveryMessage($journal);
            try { $this->writeJournal($root, $journal); } catch (\Throwable $e) { error_log('Native install journal: ' . $e->getMessage()); }
            try { $this->writeExact($root . '/private/recovery-required', $message, 0600); } catch (\Throwable $e) { error_log('Native recovery marker: ' . $e->getMessage()); }
            error_log('Native app recovery required: ' . $message);
            return;
        }
        // Everything is back: retire the update's inputs and the journal.
        try {
            if (is_dir($staging)) $this->removeStagedSource($root, $staging);
            $this->retireBackups($root, $journal);
            $this->clearJournal($root);
        } catch (\Throwable $error) {
            error_log('Native install rollback cleanup: ' . $error->getMessage());
        }
    }

    /**
     * Restore the database for a rollback, waiting out another connection's lock. SQLite reports
     * BUSY (5) or LOCKED (6) while an editor, a backup tool or a worker holds the live file, and
     * that usually passes, so it is retried: at most RESTORE_ATTEMPTS attempts inside
     * RESTORE_BUDGET_MS in all, each on fresh handles with a busy timeout that fits what is left of
     * the budget. Every other failure (a damaged or empty snapshot, a read-only or missing
     * database, a failed health check) ends at once, since another attempt cannot change it. A
     * lock that outlasts the budget is thrown with the SQLite code, for the caller to record as a
     * problem: the journal goes to recovery and the snapshot stays.
     */
    protected function restoreDatabaseWithRetry(string $snapshot, string $database): void
    {
        $started = hrtime(true);
        for ($attempt = 1; ; $attempt++) {
            $left = self::RESTORE_BUDGET_MS - (int) ((hrtime(true) - $started) / 1_000_000);
            try {
                $this->restoreDatabaseSnapshot($snapshot, $database, max(100, min(self::RESTORE_BUSY_MS, $left)));
                return;
            } catch (\Throwable $error) {
                if (!self::isTransientSqliteError((int) $error->getCode())) throw $error;
                $elapsed = (int) ((hrtime(true) - $started) / 1_000_000);
                if ($attempt >= self::RESTORE_ATTEMPTS || $elapsed + self::RESTORE_PAUSE_MS + 250 > self::RESTORE_BUDGET_MS) {
                    throw new RuntimeException($error->getMessage() . '. It stayed locked for ' . number_format($elapsed / 1000, 1) . ' s over ' . $attempt . ' attempt' . ($attempt === 1 ? '' : 's') . '. The snapshot is kept: stop whatever has the app database open, then restore the snapshot as docs/NATIVE_ROLLBACK_SAFETY.md describes', (int) $error->getCode(), $error);
                }
                usleep(self::RESTORE_PAUSE_MS * 1000);
            }
        }
    }

    /**
     * One attempt to restore into the existing SQLite file under SQLite's own write transaction.
     * The caller holds the exclusive management lock. Retained WAL readers may finish their old
     * snapshot; competing writers (and rollback-journal readers) make it fail, within $busyMs of
     * lock waiting. Never checkpoint/unlink sidecars or overwrite/rename the live file outside
     * SQLite: a checkpoint is not an exclusion lock, and even an idle connection may retain its
     * handles. The recovery snapshot remains untouched until the entire rollback has succeeded.
     * Any failure is a RuntimeException that says which file it concerns (the snapshot or the live
     * database, whether it could not be opened or the restore failed) and, once the backup has
     * started, carries SQLite's code.
     */
    protected function restoreDatabaseSnapshot(string $snapshot, string $database, int $busyMs = self::RESTORE_BUSY_MS): void
    {
        if (!class_exists(\SQLite3::class)) throw new RuntimeException('The sqlite3 PHP extension is required to restore the database from its snapshot');
        $this->assertSnapshotHealthy($snapshot, $busyMs);
        try { $source = new \SQLite3($snapshot, SQLITE3_OPEN_READONLY); }
        catch (\Throwable $e) { throw new RuntimeException('The snapshot could not be opened: ' . $e->getMessage(), 0, $e); }
        try {
            $source->enableExceptions(true);
            $source->busyTimeout($busyMs);
            // Do not CREATE a new file beside orphan sidecars or an unlinked retained handle.
            try { $destination = new \SQLite3($database, SQLITE3_OPEN_READWRITE); }
            catch (\Throwable $e) { throw new RuntimeException('The live database could not be opened: ' . $e->getMessage(), 0, $e); }
            try {
                try {
                    $destination->enableExceptions(true);
                    $destination->busyTimeout($busyMs);
                    $destination->exec('PRAGMA synchronous=FULL');
                    $restored = $this->backupDatabaseChecked($source, $destination);
                    // PHP can report true when backup_init failed: it reads the source error even
                    // though SQLite records initialization failures on the destination. Read both
                    // errors immediately, before any health query can reset them.
                    $sourceError = $source->lastErrorCode();
                    $destinationError = $destination->lastErrorCode();
                    if (!$restored || $sourceError !== 0 || $destinationError !== 0) {
                        throw new RuntimeException('SQLite did not report the restore as complete');
                    }
                    if ($destination->querySingle('PRAGMA quick_check') !== 'ok') throw new RuntimeException('The restored database failed its health check');
                } catch (\Throwable $failure) {
                    throw $this->databaseRestoreFailure($failure, $source, $destination);
                }
            } finally { $destination->close(); }
        } finally { $source->close(); }
    }

    /**
     * The failure of a restore attempt, as the live database's: SQLite records a failed backup on
     * the destination handle (PHP's message says "source database is busy" for a busy
     * destination, and "not an error" for a read-only one), so its code and its own message are
     * what is read. Called before the handles are closed, which discards both.
     */
    private function databaseRestoreFailure(\Throwable $cause, \SQLite3 $source, \SQLite3 $destination): RuntimeException
    {
        $code = $destination->lastErrorCode();
        $message = $destination->lastErrorMsg();
        if ($code === 0) { $code = $source->lastErrorCode(); $message = $source->lastErrorMsg(); }
        $detail = $code !== 0 ? $message . ' (SQLite error ' . $code . ')' : $cause->getMessage();
        return new RuntimeException('The live database could not be restored: ' . $detail, $code, $cause);
    }

    /** SQLite's atomic copy, with a seam for rollback fault injection. */
    protected function backupDatabaseChecked(\SQLite3 $source, \SQLite3 $destination): bool
    {
        return $source->backup($destination);
    }

    /**
     * The files a member's frame receives: never the private server tree, never schema. Defined
     * here, beside the project, because two things must agree about it — the runtime GET's response
     * and the languages the engine decision is clamped on. A `.py` under `server/` is not the app's
     * client logic and must not make a member's frame look like a Python app.
     *
     * @return array<string, string>
     */
    public static function clientFiles(array $project): array
    {
        $files = is_array($project['files'] ?? null) ? $project['files'] : [];
        return array_filter($files, static fn($path) => !preg_match('~^(server|backend|private)/~i', $path) && !str_ends_with($path, '.sql'), ARRAY_FILTER_USE_KEY);
    }

    /**
     * What the installed project's client logic is written in, by the one rule
     * ({@see RuntimeEngineService::languagesOf}) applied to those same names. Read without the
     * management lock, like entry(): every caller is deciding an engine, not serving source, and
     * the locked read that serves a request answers for itself. Never throws — an absent or
     * unreadable project is not a Python app.
     *
     * @return list<string>
     */
    public function clientLanguages(string $appId): array
    {
        try { $project = $this->summary($appId); }
        catch (\Throwable) { $project = null; }
        return RuntimeEngineService::languagesOf(self::clientFiles($project ?? []));
    }

    /** Source inspection requires owner authorization at the controller. Keys and database contents are never included. */
    public function get(string $appId): ?array
    {
        $file = $this->root($appId) . '/project.json';
        if (!is_file($file)) return null;
        // The whole project, media and all, and usually sent on or copied after: room for it first.
        self::raiseMemoryFor((int) @filesize($file));
        return json_decode(file_get_contents($file), true, 64, JSON_THROW_ON_ERROR);
    }

    /**
     * The installed project, read the way every other entry point reads it (FL-S04): under the
     * shared management lock, after an update a terminated process left unfinished is settled.
     * get() alone can serve a project.json the journal is about to roll back. Null when nothing
     * is installed; busy (409) and recovery required throw as they do for a request.
     */
    public function project(string $appId): ?array
    {
        try { [, $lock, $project] = $this->openShared($appId); }
        catch (RuntimeException $missing) { if ($missing->getCode() === 404) return null; throw $missing; }
        flock($lock, LOCK_UN); fclose($lock);
        return $project;
    }

    /**
     * What a page needs to run the installed app, read as project() reads (FL-S04), without its
     * media: the project's source, version, access and home, and its media pack (the file, its
     * SHA-256, size and file count). Both are made from project.json the first time it is opened
     * and read from then on, so an opening does not decode every picture and sound in the project:
     * a game's runs to tens of megabytes, and PHP held several copies of it per request.
     *
     * With `$openMedia`, the media pack is also opened for reading (`media.stream`), for the caller to send and close.
     *
     * @return array{project: array<string, mixed>, media: array{file: string, sha256: string, size: int, count: int, stream?: resource}}|null
     */
    public function runtimeProject(string $appId, bool $openMedia = false): ?array
    {
        try { [$root, $lock] = $this->openShared($appId, null, false); }
        catch (RuntimeException $missing) { if ($missing->getCode() === 404) return null; throw $missing; }
        if ($lock === null) return null;
        try {
            $runtime = $this->runtimeCache($root);
            // Opened while the lock is held: an update cannot replace or remove this pack before it is
            // being read, and what is read is the pack the project it was admitted for names.
            if ($openMedia) {
                $stream = @fopen($runtime['media']['file'], 'rb');
                if ($stream === false) throw new RuntimeException('The app\'s media could not be read');
                $runtime['media']['stream'] = $stream;
            }
            return $runtime;
        }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * The installed project without its media, for what reads only its source or settings on the
     * way to a page (entry, the engine's choice): the runtime cache when there is one for the
     * project as it is, otherwise project.json itself. Unlocked, like get().
     */
    public function summary(string $appId): ?array
    {
        $root = $this->root($appId);
        $key = $this->runtimeKey($root);
        if ($key === null) return null;
        $file = $root . self::RUNTIME_CACHE . '/client-' . $key . '.json';
        if (is_file($file)) {
            $cached = json_decode((string) @file_get_contents($file), true);
            if (is_array($cached['project'] ?? null)) return $cached['project'];
        }
        return $this->get($appId);
    }

    /**
     * Asks PHP for room to handle a project whose JSON is `$bytes` long, where the host allows it:
     * the request, its decoded copy and the project as written each hold about that much. True when
     * there is room (or no limit), false when the host would not give it.
     */
    public static function raiseMemoryFor(int $bytes): bool
    {
        $need = 96 * 1024 * 1024 + 4 * max(0, $bytes);
        $limit = self::memoryBytes((string) ini_get('memory_limit'));
        if ($limit < 0 || $limit >= $need) return true;
        // Up to 1.5 GB, and never below what the host already gives.
        $target = min($need, 1536 * 1024 * 1024);
        if ($target > $limit) @ini_set('memory_limit', (string) $target);
        $now = self::memoryBytes((string) ini_get('memory_limit'));
        return $now < 0 || $now >= $need;
    }

    /** php.ini's shorthand (128M, 1G, -1) in bytes; -1 for no limit. */
    public static function memoryBytes(string $value): int
    {
        $value = trim($value);
        if ($value === '' || $value === '-1') return -1;
        $number = (int) $value;
        return match (strtolower(substr($value, -1))) { 'g' => $number * 1024 ** 3, 'm' => $number * 1024 ** 2, 'k' => $number * 1024, default => $number };
    }

    /** The runtime cache's name for the project as installed: a hash of project.json, quick enough for every opening. */
    private function runtimeKey(string $root): ?string
    {
        $file = $root . '/project.json';
        return is_file($file) ? (hash_file('xxh128', $file) ?: null) : null;
    }

    /** The installed project's key (runtimeKey), for a caller that asks derivedState() several things at once. */
    public function projectKey(string $appId): ?string
    {
        return $this->runtimeKey($this->root($appId));
    }

    /** @return array{project: array<string, mixed>, media: array{file: string, sha256: string, size: int, count: int}} */
    private function runtimeCache(string $root): array
    {
        $key = $this->runtimeKey($root) ?? throw new RuntimeException('Native app not found', 404);
        $dir = $root . self::RUNTIME_CACHE;
        $clientFile = $dir . '/client-' . $key . '.json';
        $packFile = $dir . '/media-' . $key . '.pack';
        if (!is_file($clientFile) || !is_file($packFile)) {
            // One build at a time: right after an update every visitor's request found no cache, and
            // each decoded the whole project (raising PHP's memory for it) to write the same files.
            // A request that waited finds them written.
            if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Could not prepare the app\'s media');
            $building = @fopen($dir . '/build.lock', 'c');
            if ($building !== false) flock($building, LOCK_EX);
            try {
                if (!is_file($clientFile) || !is_file($packFile)) $this->buildRuntimeCache($root, $dir, $key);
            } finally {
                if ($building !== false) { flock($building, LOCK_UN); fclose($building); }
            }
        }
        $client = json_decode((string) file_get_contents($clientFile), true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($client['project'] ?? null) || !is_array($client['media'] ?? null)) throw new RuntimeException('The app\'s media could not be read');
        return ['project' => $client['project'], 'media' => $client['media'] + ['file' => $packFile]];
    }

    /**
     * Writes the runtime cache for project.json as it is: the client summary and the media pack
     * (MEDIA_PACK_MAGIC), each by way of a pending file renamed into place, so a reader sees a whole
     * file or none. Any other project's cache in the folder goes. Sizes come from the base64's length
     * (validateProject admits strict base64 only), so the header is written before a byte is decoded,
     * and one file at a time is held decoded.
     */
    private function buildRuntimeCache(string $root, string $dir, string $key): void
    {
        $source = $root . '/project.json';
        self::raiseMemoryFor((int) @filesize($source));
        $project = json_decode((string) file_get_contents($source), true, 64, JSON_THROW_ON_ERROR);
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('Could not prepare the app\'s media');
        $assets = is_array($project['assets'] ?? null) ? $project['assets'] : [];
        $index = [];
        $offset = 0;
        foreach ($assets as $path => $encoded) {
            if (!is_string($path) || !is_string($encoded)) continue;
            // A built site's files are served one by one from their own address (siteFile): they
            // are not media the frame is handed, and a page would otherwise download the whole
            // site a second time as a pack it never opens.
            if (str_starts_with($path, 'site/')) continue;
            $size = self::decodedLength($encoded);
            if ($size === null) throw new RuntimeException('The app\'s media could not be read: ' . $path);
            $index[] = ['path' => $path, 'offset' => $offset, 'size' => $size];
            $offset += $size;
        }
        $header = json_encode(['files' => $index], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $packFile = $dir . '/media-' . $key . '.pack';
        $pending = $packFile . '.pending-' . bin2hex(random_bytes(6));
        try {
            $stream = @fopen($pending, 'xb');
            if ($stream === false) throw new RuntimeException('Could not write the app\'s media');
            try {
                $write = function (string $bytes) use ($stream, $pending): void {
                    if ($this->writeStream($pending, $stream, $bytes) !== strlen($bytes)) throw new RuntimeException('Short write to the app\'s media');
                };
                $write(self::MEDIA_PACK_MAGIC . pack('N', strlen($header)) . $header);
                foreach ($index as $file) {
                    $bytes = base64_decode($assets[$file['path']], true);
                    if ($bytes === false || strlen($bytes) !== $file['size']) throw new RuntimeException('The app\'s media could not be read: ' . $file['path']);
                    $write($bytes);
                }
                if (!fflush($stream)) throw new RuntimeException('Could not flush the app\'s media');
            } finally { fclose($stream); }
            @chmod($pending, 0600);
            // Two first openings can build at once (each under the shared lock) and make the same bytes;
            // where the other's is in place and cannot be replaced (Windows, while it is being sent), it stands.
            if (!@rename($pending, $packFile) && !(is_file($packFile) && filesize($packFile) === filesize($pending))) throw new RuntimeException('Could not place the app\'s media');
        } finally { if (is_file($pending)) @unlink($pending); }
        unset($assets);
        $summary = ['files' => is_array($project['files'] ?? null) ? $project['files'] : []];
        foreach (['version', 'home', 'access', 'updatedAt'] as $field) if (array_key_exists($field, $project)) $summary[$field] = $project[$field];
        $media = ['sha256' => (string) hash_file('sha256', $packFile), 'size' => (int) filesize($packFile), 'count' => count($index)];
        $this->writeExact($dir . '/client-' . $key . '.json', json_encode(['project' => $summary, 'media' => $media], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), 0600);
        // Another project's cache is of no use now: what this folder holds is for project.json as it is.
        foreach (scandir($dir) ?: [] as $name) {
            // What was drawn from it (derived(): look-<key>-...) goes with it.
            if (preg_match('/^(?:(?:client|media)-([a-f0-9]+)\.(?:json|pack)|look-([a-f0-9]+)-[a-f0-9]+\.bin)(?:\.pending-[a-f0-9]+)?$/D', $name, $match) && (($match[1] ?? '') !== '' ? $match[1] : ($match[2] ?? '')) !== $key) @unlink($dir . '/' . $name);
        }
    }

    /**
     * The index of an open media pack ({path => [offset, size]}, offsets from the end of the
     * index), read from its head, or null where it is not one.
     *
     * @param resource $stream at the start of the pack
     * @return array{base: int, files: array<string, array{0: int, 1: int}>}|null
     */
    private static function packIndex($stream): ?array
    {
        $head = fread($stream, 12);
        if (!is_string($head) || strlen($head) !== 12 || substr($head, 0, 8) !== self::MEDIA_PACK_MAGIC) return null;
        $length = (int) unpack('N', substr($head, 8, 4))[1];
        if ($length < 2 || $length > 8 * 1024 * 1024) return null;
        $index = json_decode((string) stream_get_contents($stream, $length), true);
        if (!is_array($index['files'] ?? null)) return null;
        $files = [];
        foreach ($index['files'] as $file) {
            if (is_array($file) && is_string($file['path'] ?? null) && is_int($file['offset'] ?? null) && is_int($file['size'] ?? null)) {
                $files[$file['path']] = [$file['offset'], $file['size']];
            }
        }
        return ['base' => 12 + $length, 'files' => $files];
    }

    /** The paths of the app's media files, as its media pack lists them; [] when it has none. */
    public function mediaPaths(string $appId): array
    {
        $stream = $this->runtimeProject($appId, true)['media']['stream'] ?? null;
        if (!is_resource($stream)) return [];
        try { return array_keys(self::packIndex($stream)['files'] ?? []); }
        finally { fclose($stream); }
    }

    /**
     * The app's media files and how large each is, as its media pack lists them; [] when it has
     * none. For what names an app's media without sending them (an AI reading the project).
     *
     * @return array<string, int> path to size in bytes
     */
    public function mediaSizes(string $appId): array
    {
        $stream = $this->runtimeProject($appId, true)['media']['stream'] ?? null;
        if (!is_resource($stream)) return [];
        try { return array_map(static fn (array $at): int => $at[1], self::packIndex($stream)['files'] ?? []); }
        finally { fclose($stream); }
    }

    /**
     * One of the app's media files, byte for byte as it was installed, read from its media pack
     * under the app's lock; null when it has no such file. For what is drawn from it, such as the
     * icon a page and a home screen show (AppLookService).
     */
    public function mediaFile(string $appId, string $path): ?string
    {
        $stream = $this->runtimeProject($appId, true)['media']['stream'] ?? null;
        if (!is_resource($stream)) return null;
        try {
            $index = self::packIndex($stream);
            [$offset, $size] = $index['files'][$path] ?? [-1, -1];
            if ($offset < 0 || $size < 0 || $size > self::MAX_MEDIA_FILE_BYTES) return null;
            if ($size === 0) return '';
            if (fseek($stream, $index['base'] + $offset) !== 0) return null;
            $bytes = stream_get_contents($stream, $size);
            return is_string($bytes) && strlen($bytes) === $size ? $bytes : null;
        } finally { fclose($stream); }
    }

    /**
     * Something drawn from the project as installed (an icon at a size, a share image), kept beside
     * its media pack and removed with it when the project changes: $make draws it the first time,
     * and it is read from then on. $name says what it is, its inputs included. Null when nothing is
     * installed or $make draws nothing.
     *
     * @param callable(): ?string $make
     */
    public function derived(string $appId, string $name, callable $make): ?string
    {
        $root = $this->root($appId);
        $key = $this->runtimeKey($root);
        if ($key === null) return null;
        $dir = $root . self::RUNTIME_CACHE;
        $file = $dir . '/look-' . $key . '-' . hash('xxh128', $name) . '.bin';
        // What could not be drawn is kept too, as one byte that no image is: a broken image is not
        // decoded again for every request that names it.
        $kept = static function () use ($file): array {
            if (!is_file($file)) return [false, null];
            $bytes = @file_get_contents($file);
            if (!is_string($bytes) || $bytes === '') return [false, null];
            // A failure is tried again after a day: the server may have changed (memory, GD's formats).
            if ($bytes === "\0") return @filemtime($file) > time() - 86400 ? [true, null] : [false, null];
            return [true, $bytes];
        };
        [$found, $bytes] = $kept();
        if ($found) return $bytes;
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) { $made = $make(); return is_string($made) && $made !== '' ? $made : null; }
        // One drawing at a time for each thing: the others wait, then read what it drew.
        $lock = @fopen($dir . '/look.lock', 'c');
        if ($lock !== false) flock($lock, LOCK_EX);
        try {
            [$found, $bytes] = $kept();
            if ($found) return $bytes;
            $made = $make();
            $bytes = is_string($made) && $made !== '' ? $made : null;
            // Filed under the project it was drawn from: one installed meanwhile gets its own.
            if ($this->runtimeKey($root) === $key) {
                try { $this->writeExact($file, $bytes ?? "\0", 0600); } catch (\Throwable) { /* Drawn again next time. */ }
            }
            return $bytes;
        } finally {
            if ($lock !== false) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }
    /**
     * Whether derived() has $name for the project as installed: true where it was drawn, false where
     * it could not be, null where nobody has asked yet. Read without the drawing itself.
     */
    public function derivedState(string $appId, string $name, ?string $key = null): ?bool
    {
        $root = $this->root($appId);
        $key ??= $this->runtimeKey($root);
        if ($key === null) return null;
        $file = $root . self::RUNTIME_CACHE . '/look-' . $key . '-' . hash('xxh128', $name) . '.bin';
        clearstatcache(true, $file);
        $size = @filesize($file);
        if ($size === false || $size === 0) return null;
        if ($size > 1 || @file_get_contents($file) !== "\0") return true;
        return @filemtime($file) > time() - 86400 ? false : null;
    }
    /**
     * How many bytes a file's base64 decodes to: from its length where it is canonical (no line breaks,
     * its padding in place), otherwise by decoding it, as validateProject() accepts both (PHP's strict
     * base64 skips whitespace and needs no padding). Null where it is not base64 at all.
     */
    private static function decodedLength(string $encoded): ?int
    {
        $length = strlen($encoded);
        $body = strspn($encoded, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
        $tail = substr($encoded, $body);
        if ($length % 4 === 0 && ($tail === '' || $tail === '=' || $tail === '==')) return intdiv($length, 4) * 3 - strlen($tail);
        $bytes = base64_decode($encoded, true);
        return $bytes === false ? null : strlen($bytes);
    }

    /**
     * Whether a project has a backend: a `server` block in its manifest. A SoftN app without one is
     * all client (its pages, logic, local data and media) and runs in the member's frame alone:
     * nothing starts a runner for it, and it has no database.
     */
    public static function hasBackend(array $project): bool
    {
        $manifest = json_decode((string) ($project['files']['manifest.json'] ?? ''), true);
        return is_array($manifest) && array_key_exists('server', $manifest);
    }

    /**
     * The identity an installation runs under: its manifest's id. SoftN makes the id optional and
     * most apps declare none; such an app keeps the one its installation already has ($configured,
     * from its host configuration, which a restore under a new app id carries over), and a new
     * installation takes one named after this app, as the starter's is. The runner is told it
     * through its copy of the manifest (runnerFiles).
     */
    private static function identity(array $manifest, string $appId, ?string $configured = null): string
    {
        if (is_string($manifest['id'] ?? null)) return $manifest['id'];
        return $configured ?? 'formlogic.app.' . preg_replace('/[^a-zA-Z0-9._-]/', '', $appId);
    }

    /** The identity the installation's host configuration names, or null before it has one. */
    private static function configuredIdentity(string $configPath): ?string
    {
        if (!is_file($configPath)) return null;
        $config = json_decode((string) file_get_contents($configPath), true);
        return is_array($config) && is_string($config['appId'] ?? null) ? $config['appId'] : null;
    }

    /**
     * Source/schema validation only; never starts a VM, applies migrations or writes storage.
     * A manifest with no `server` block is a client-only app (capabilities: none); one with a
     * `server` block is held to every rule a backend must meet.
     */
    public static function validateProject(array $project): array
    {
        $files = $project['files'] ?? null;
        if (!is_array($files) || count($files) > self::MAX_SOURCE_FILES || !is_string($files['manifest.json'] ?? null)) throw new InvalidArgumentException('Include the app manifest and at most ' . self::MAX_SOURCE_FILES . ' source files');
        $bytes = 0;
        foreach ($files as $path => $source) {
            // `.xdb` is an app's seed data (its local collections), JSON text the app is shipped with.
            // `.html`, `.js` and `.css` are a SoftN app's pages, page logic and stylesheets as SoftN has
            // written them since its HTML pages (`.ui` and `.logic` before): text the app's frame is
            // handed with the rest and reads as SoftN, never a document or a script this site serves.
            if (!is_string($path) || !preg_match(self::SOURCE_PATH, $path) || str_contains($path, '..') || !is_string($source)) throw new InvalidArgumentException(is_string($path) && preg_match('~^[\w./-]{1,200}$~', $path) ? "Invalid app source file: {$path}. " . (str_contains($path, '..') ? 'A name may not have two dots together.' : (preg_match(self::SOURCE_PATH, $path) ? 'Its content must be text.' : self::SOURCE_KINDS . ' A name is letters, digits, \'-\', \'_\' and \'.\', in folders.')) : 'Invalid app source file. ' . self::SOURCE_KINDS);
            // Said as the app page's import says it (nativeHosting.ts), which reads the same limit first.
            if (strlen($source) > self::MAX_SOURCE_FILE_BYTES) throw new InvalidArgumentException(preg_match('~^[\w./-]{1,200}$~', $path) ? "{$path} is larger than this host keeps (1.5 MB per source file)." : 'A source file is larger than this host keeps (1.5 MB per source file).');
            // `.py` is CLIENT logic written in Python, which runs in the member's frame on the ZIPP
            // web-python engine. The private tree is the native backend: it is executed by the Node
            // runner as JavaScript, which would read a Python file as a syntax error at best, and
            // nothing derives a language from it — so a `.py` there is refused rather than installed
            // as a file no runtime can run. Lower case only, like every other extension here.
            if (str_ends_with($path, '.py') && preg_match('~^(?:server|backend|private)/~i', $path)) throw new InvalidArgumentException('Python is a client logic language; the app backend stays JavaScript');
            // The runner takes a migration of at most this size, and would refuse a larger one as
            // the app is installed, with nothing to say which file it was.
            if (str_starts_with($path, 'server/migrations/') && str_ends_with($path, '.sql') && strlen($source) > self::MAX_MIGRATION_BYTES) throw new InvalidArgumentException("{$path} is larger than a migration may be (1 MB). Split it into two migrations.");
            $bytes += strlen($source);
        }
        $assets = $project['assets'] ?? [];
        if (!is_array($assets) || count($assets) > self::MAX_MEDIA_FILES) throw new InvalidArgumentException('Include at most ' . self::MAX_MEDIA_FILES . ' media files');
        $decoded = [];
        foreach ($assets as $path => $encoded) {
            // The media the SoftN frame serves an app's page (from Softn v0.0.28): pictures, sound,
            // video, fonts, 3D models, and WGSL, text and Markdown files. Nothing that runs.
            // A built site's files (SITE_PATH) are kept beside the media and are never the frame's:
            // SiteAppController serves them, each under a sandbox.
            $media = is_string($path) && preg_match(self::MEDIA_PATH, $path) && !str_contains($path, '..');
            // A site file whose name is right and whose content is not text: said as that, not as a bad name.
            if (!$media && is_string($path) && self::isSitePath($path) && !is_string($encoded)) throw new InvalidArgumentException("The content of {$path} is not base64 text.");
            if ((!$media && !self::isSitePath($path)) || !is_string($encoded)) {
                // A built site's file is named in the refusal whatever its name holds (a space, a
                // bracket): that is the file its owner has to rename. What is shown of it is cut
                // and held to plain printable characters.
                if (is_string($path) && str_starts_with($path, 'site/')) {
                    $shown = substr((string) preg_replace('/[^\x20-\x7E]/', '?', $path), 0, 160);
                    throw new InvalidArgumentException("Invalid site file: {$shown}. A built site keeps web files (pages, scripts, styles, pictures, fonts, sound, video, data) named with letters, digits and - _ . @ + ~, in folders, with no name that starts with a dot.");
                }
                throw new InvalidArgumentException(is_string($path) && preg_match('~^[\w./@+\~-]{1,240}$~', $path) ? "Invalid media file: {$path}" : 'Invalid media file');
            }
            $value = base64_decode($encoded, true);
            if ($value === false || strlen($value) > self::MAX_MEDIA_FILE_BYTES) throw new InvalidArgumentException('Invalid media data');
            $bytes += strlen($value);
            $decoded[$path] = $value;
        }
        if ($bytes > self::MAX_PROJECT_BYTES) throw new InvalidArgumentException('Native project exceeds ' . intdiv(self::MAX_PROJECT_BYTES, 1024 * 1024) . ' MB');
        // Each refusal says which part of the manifest it is about: whoever wrote it, a person or an AI, has only this to go on.
        try { $manifest = json_decode($files['manifest.json'], true, 64, JSON_THROW_ON_ERROR); }
        catch (\JsonException $unreadable) { throw new InvalidArgumentException('manifest.json is not valid JSON (' . $unreadable->getMessage() . ').'); }
        if (!is_array($manifest) || array_is_list($manifest)) throw new InvalidArgumentException('manifest.json must be a JSON object.');
        if (isset($manifest['id']) && (!is_string($manifest['id']) || !preg_match('/^[a-zA-Z0-9._-]{1,120}$/D', $manifest['id']))) throw new InvalidArgumentException('manifest.json\'s id can only be letters, digits, \'.\', \'_\' and \'-\' (up to 120 of them).');
        // A JavaScript app: its pages are a built site under site/, named by the manifest's `site`
        // block, and it has no SoftN page for "main" to name. The two are told apart here, once:
        // site files with no block to name their first page are files nothing would ever show.
        $siteFiles = array_filter(array_keys($decoded), static fn ($path): bool => str_starts_with((string) $path, 'site/'));
        $site = $manifest['site'] ?? null;
        if ($site !== null) {
            if (!is_array($site) || array_is_list($site) || !is_string($site['entry'] ?? null)) throw new InvalidArgumentException('manifest.json\'s site must be an object that names the first page: {"entry": "index.html"}.');
            $entry = 'site/' . $site['entry'];
            if (!self::isSitePath($entry) || !preg_match('/\.html?$/Di', $entry)) throw new InvalidArgumentException('manifest.json\'s site.entry must be a page of the built site (a .html file, such as "index.html").');
            if (!isset($decoded[$entry])) throw new InvalidArgumentException('manifest.json\'s site.entry names ' . $site['entry'] . ', which is not among the site\'s files (they are kept under site/).');
            // Other sites the app may reach (an API it calls, a font service): each one address
            // of a site, as the policy its pages are sent under takes them. One that is not is
            // named, so whoever wrote it can put it right, and is never quietly left out.
            if (array_key_exists('outside', $site)) {
                $outside = $site['outside'];
                if (!is_array($outside) || !array_is_list($outside)) throw new InvalidArgumentException('manifest.json\'s site.outside must be a list of sites the app may reach, such as ["https://api.example.com"].');
                if (count($outside) > \FormLogic\Middleware\SecurityHeadersMiddleware::SITE_OUTSIDE_MOST) throw new InvalidArgumentException('manifest.json\'s site.outside names more than ' . \FormLogic\Middleware\SecurityHeadersMiddleware::SITE_OUTSIDE_MOST . ' sites.');
                foreach ($outside as $one) {
                    if (!is_string($one) || \FormLogic\Middleware\SecurityHeadersMiddleware::siteOutside([$one]) === []) {
                        $shown = is_string($one) ? substr((string) preg_replace('/[^\x20-\x7E]/', '?', $one), 0, 120) : '(not text)';
                        throw new InvalidArgumentException("manifest.json's site.outside has \"{$shown}\", which is not a site's address. Write each as https://name (or wss://name for a live connection), with no path: https://api.example.com");
                    }
                    // One of this installation's own names, as far as it knows them here (the
                    // one a visitor comes in on is known only then, and is left out of the
                    // policy there): refused in words, where it would otherwise sit on the
                    // list as though allowed.
                    if (\FormLogic\Middleware\SecurityHeadersMiddleware::siteOutsideIsOwn(strtolower(trim($one)), \FormLogic\Middleware\SecurityHeadersMiddleware::ownNames())) {
                        $shown = substr((string) preg_replace('/[^\x20-\x7E]/', '?', $one), 0, 120);
                        throw new InvalidArgumentException("manifest.json's site.outside has \"{$shown}\", which is this site's own address. An app is never given it: it reaches its own backend at /api/… and nothing else here.");
                    }
                }
            }
        } elseif ($siteFiles) {
            throw new InvalidArgumentException('The project has built site files (site/…) but manifest.json has no site block to name their first page. Add "site": {"entry": "index.html"}.');
        }
        $main = $manifest['main'] ?? null;
        // A site needs no SoftN page; one that names a page all the same is held to the usual rules.
        if ($site === null || $main !== null) {
        if (!is_string($main) || $main === '') throw new InvalidArgumentException('manifest.json names no first page: give it "main", the path of a page in the app (such as "index.html" or "ui/main.ui").');
        if (!preg_match('/\.(?:ui|html)$/D', $main)) throw new InvalidArgumentException('manifest.json\'s main must be a page (a .html or .ui file): it names ' . (preg_match('~^[\w./-]{1,200}$~', $main) ? $main : 'something else') . '.');
        if (!isset($files[$main])) throw new InvalidArgumentException('manifest.json\'s main names ' . (preg_match('~^[\w./-]{1,200}$~', $main) ? $main : 'a page') . ', which is not among the app\'s files.');
        }
        // What the app asks of FormLogic itself (App AI, payments): FormLogic's sections, held to
        // their rules here so a malformed one is refused at install with the reason.
        AppFormlogicManifest::validate($manifest);
        if (!array_key_exists('server', $manifest)) {
            // Client only. A private tree with no server block to run it would be source no runtime
            // ever starts, kept as if it were a backend: refused, so the owner adds the block.
            foreach (array_keys($files) as $path) {
                if (preg_match('~^(?:server|backend|private)/~i', $path)) throw new InvalidArgumentException("{$path} is backend code, but manifest.json has no server block to run it. Add one, or remove the file.");
            }
            return [$files, $decoded, $manifest, []];
        }
        $server =is_array($manifest['server']) ? $manifest['server'] : [];
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

    /**
     * The starter project (resources/native-app-starter.json) as a new SoftN app named $appName
     * begins: an interface, a private backend and one migration that work as they are, named
     * after the app and given a manifest id of its own. Open at the app's address (home), for
     * members only until the owner says otherwise.
     *
     * @return array{home: bool, version: int, files: array<string, string>, assets: array<string, string>, access: string}
     */
    public static function starterProject(string $appName, string $appId): array
    {
        $starter = json_decode((string) file_get_contents(dirname(__DIR__, 2) . '/resources/native-app-starter.json'), true, 64, JSON_THROW_ON_ERROR);
        $name = trim(preg_replace('/\s+/u', ' ', $appName) ?? '');
        $name = $name === '' ? 'My app' : mb_substr($name, 0, 120);
        $manifest = json_decode($starter['files']['manifest.json'], true, 64, JSON_THROW_ON_ERROR);
        $manifest['name'] = $name;
        $manifest['id'] = 'formlogic.app.' . preg_replace('/[^a-zA-Z0-9._-]/', '', $appId);
        $starter['files']['manifest.json'] = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        // The heading is markup text: characters the .ui language reads as markup or an
        // expression are left out rather than escaped, so the name can never become code.
        $heading = trim(str_replace(['<', '>', '{', '}', '&', '"', '`'], '', $name));
        if ($heading !== '') $starter['files']['ui/main.ui'] = str_replace('<Text>My app</Text>', '<Text>' . $heading . '</Text>', $starter['files']['ui/main.ui']);
        return ['home' => true, 'version' => 0, 'files' => $starter['files'], 'assets' => $starter['assets'] ?? [], 'access' => $starter['access'] ?? 'members'];
    }

    /**
     * What an app's author can do about the startup stage its host stopped at, as the owner reads
     * it where the version was refused. The stage is kept at the end for whoever supports them.
     */
    public static function startupFailure(string $stage): string
    {
        $message = match ($stage) {
            'application_source' => "The app's backend could not start: its code (server/main.logic) has an error, or a route names a function it does not define. Fix it in the source editor, or ask AI Studio to.",
            'route_configuration' => "A route in manifest.json is not one the app host serves: paths are under /api/ and matched exactly, methods are GET, POST, PUT or DELETE, and each route names a function in the backend.",
            'database_migrations' => "A database migration could not run: check its SQL. Migrations may create and alter tables and indexes and insert rows; triggers, views and PRAGMAs are not supported.",
            'migration_stopped' => "A database migration did not finish within the app host's time limit and is no longer retried. Split it into smaller migrations (one large INSERT or index build to a file) and publish again.",
            'application_capabilities' => "The backend asks for a capability this server does not offer. Remove it from manifest.json's server.requires.capabilities, or ask your administrator.",
            'manifest_read', 'application_identity' => "manifest.json's server block could not be read: check its entry, requires, database and routes.",
            '' => 'The app host did not start and gave no reason. Ask your administrator to check the native app runtime.',
            default => 'The app host could not start this version. Ask your administrator to check the native app runtime.',
        };
        return $stage === '' ? $message : "{$message} ({$stage})";
    }

    /**
     * The migrations the installed version ran on this app's database: each must stay listed and
     * unchanged in an update, or the host refuses to start (its ledger holds their checksums).
     * Said here, by name and with the way forward, instead of as the host's startup stage.
     *
     * @param array<string, string> $oldFiles
     * @param array<string, string> $newFiles
     */
    private static function assertMigrationsKept(array $oldFiles, array $newFiles): void
    {
        $applied = json_decode($oldFiles['manifest.json'] ?? '{}', true)['server']['database']['migrations'] ?? [];
        if (!is_array($applied) || $applied === []) return;
        $listed = json_decode($newFiles['manifest.json'] ?? '{}', true)['server']['database']['migrations'] ?? [];
        $listed = is_array($listed) ? $listed : [];
        $highest = 0;
        foreach (array_merge($applied, $listed) as $path) {
            if (is_string($path) && preg_match('~(\d+)[^/]*\.sql$~', $path, $number)) $highest = max($highest, (int) $number[1]);
        }
        $next = 'server/migrations/' . str_pad((string) ($highest + 1), 3, '0', STR_PAD_LEFT) . '.sql';
        foreach ($applied as $path) {
            if (!is_string($path) || !isset($oldFiles[$path])) continue;
            if (!isset($newFiles[$path]) || !in_array($path, $listed, true)) {
                throw new InvalidArgumentException("{$path} has already run on this app's database, so the new version must keep it, listed in manifest.json. Put it back and add changes as a new migration, such as {$next}.");
            }
            if ($newFiles[$path] !== $oldFiles[$path]) {
                throw new InvalidArgumentException("{$path} has already run on this app's database, so it cannot change. Put it back as it was and add the change as a new migration, such as {$next} (for a new column: ALTER TABLE … ADD COLUMN …).");
            }
        }
    }

    /**
     * Bring an app's data from where it ran before: its SQLite database (application.sqlite), and
     * with it, optionally, the key its host kept it under (importedKey()), so what that host sealed
     * or keyed still reads. It is installed as an update of the version in place, through install()'s
     * journal: the database and configuration are snapshotted first and put back if the app does not
     * start on what came, and the version number goes up, so a page open on the old data reloads.
     *
     * @param array{appId: ?string, keyHex: string, cryptoDomains: array{hmac: string, seal: string}}|null $key
     */
    public function importData(string $appId, string $databasePath, ?array $key): array
    {
        $project = $this->get($appId);
        if ($project === null) throw new RuntimeException('Install the app before bringing its data', 409);
        $manifest = json_decode((string) ($project['files']['manifest.json'] ?? ''), true);
        if (!is_array($manifest) || !array_key_exists('server', $manifest)) throw new InvalidArgumentException('This app has no backend, so it keeps no database to bring.');
        $identity = self::configuredIdentity($this->root($appId) . '/private/config.json') ?? self::identity($manifest, $appId, null);
        if ($key !== null && $key['appId'] !== null && $key['appId'] !== $identity) throw new InvalidArgumentException("That key belongs to {$key['appId']}, and this app runs as {$identity}.");
        self::assertImportableDatabase($databasePath, $manifest, is_array($project['files'] ?? null) ? $project['files'] : []);
        return $this->install($appId, $project, (int) ($project['version'] ?? 0), ['database' => $databasePath, 'key' => $key]);
    }

    /**
     * What an earlier host's private configuration (its private/config.json) gives an import: the
     * key and its two domains, and Twilio Verify details where it kept them. Nothing else of it is
     * taken: an operator's hooks and flags are that host's.
     *
     * @return array{key: array{appId: ?string, keyHex: string, cryptoDomains: array{hmac: string, seal: string}}, verification: ?array{accountSid: string, serviceSid: string, authToken: string}}
     */
    public static function importedKey(string $json): array
    {
        $config = json_decode($json, true);
        if (!is_array($config)) throw new InvalidArgumentException('That key file is not the JSON configuration a SoftN host keeps (private/config.json).');
        $keyHex = is_string($config['keyHex'] ?? null) ? strtolower($config['keyHex']) : '';
        if (!preg_match('/^[0-9a-f]{64}$/D', $keyHex)) throw new InvalidArgumentException('That configuration holds no key (keyHex, 64 hexadecimal characters).');
        $domains = $config['cryptoDomains'] ?? null;
        $domain = static fn(mixed $value): bool => is_string($value) && preg_match('/^[\x21-\x7e]{1,120}$/D', $value) === 1;
        if (!is_array($domains) || !$domain($domains['hmac'] ?? null) || !$domain($domains['seal'] ?? null)) throw new InvalidArgumentException('That configuration names no crypto domains (cryptoDomains.hmac and .seal), which its key is used with.');
        $appId = is_string($config['appId'] ?? null) && preg_match('/^[a-zA-Z0-9._-]{1,120}$/D', $config['appId']) ? $config['appId'] : null;
        $sms = is_array($config['sms'] ?? null) ? $config['sms'] : [];
        $verification = null;
        if (is_string($sms['TWILIO_SID'] ?? null) && preg_match('/^AC[0-9a-fA-F]{32}$/D', $sms['TWILIO_SID'])
            && is_string($sms['TWILIO_VERIFY_SERVICE_SID'] ?? null) && preg_match('/^VA[0-9a-fA-F]{32}$/D', $sms['TWILIO_VERIFY_SERVICE_SID'])
            && is_string($sms['TWILIO_TOKEN'] ?? null) && $sms['TWILIO_TOKEN'] !== '') {
            $verification = ['accountSid' => $sms['TWILIO_SID'], 'serviceSid' => $sms['TWILIO_VERIFY_SERVICE_SID'], 'authToken' => $sms['TWILIO_TOKEN']];
        }
        return ['key' => ['appId' => $appId, 'keyHex' => $keyHex, 'cryptoDomains' => ['hmac' => $domains['hmac'], 'seal' => $domains['seal']]], 'verification' => $verification];
    }

    /** Where an uploaded database waits for importData(), in the app's private folder; the caller removes it. */
    public function importDropPath(string $appId): string
    {
        $private = $this->root($appId) . '/private';
        if (!is_dir($private)) throw new RuntimeException('Install the app before bringing its data', 409);
        // What an import that never finished left (its process ended mid-way): an hour old is no one's now.
        foreach ([...(glob($private . '/import-*.sqlite*') ?: []), ...(glob($private . '/data/importing-*.sqlite*') ?: [])] as $left) {
            if (is_file($left) && !is_link($left) && filemtime($left) < time() - 3600) @unlink($left);
        }
        return $private . '/import-' . bin2hex(random_bytes(8)) . '.sqlite';
    }

    /**
     * A database an app may be given: SQLite's own file, sound, holding only what migrations make
     * (tables and indexes: a trigger or a view would run, or answer, on the app's behalf, and no
     * migration may make one), with no host table but the runner's, and having run only migrations
     * this version of the app lists, each the same file. The runner checks the last again as it starts.
     */
    private static function assertImportableDatabase(string $path, array $manifest, array $files): void
    {
        $head = @file_get_contents($path, false, null, 0, 100);
        if (!is_string($head) || strlen($head) < 100 || substr($head, 0, 16) !== "SQLite format 3\0") throw new InvalidArgumentException('That file is not a SQLite database.');
        // Judged from SQLite's own list of what is in the file before anything in it is read, so no
        // view (one named _migrations, say) runs; read-only, trusting nothing the schema names.
        // Read, then closed, then judged: a connection an exception still referred to kept the
        // file open, and on Windows the upload could then not be removed.
        $check = $objects = $ledger = [];
        $failure = $problem = null;
        $tables = [];
        try {
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::SQLITE_ATTR_OPEN_FLAGS => PDO::SQLITE_OPEN_READONLY]);
            $db->exec('PRAGMA busy_timeout=1500');
            $db->exec('PRAGMA trusted_schema=OFF');
            $objects = $db->query('SELECT type, name, rootpage, sql FROM sqlite_master')->fetchAll();
            foreach ($objects as $object) {
                $name = (string) $object['name'];
                if ($object['type'] === 'trigger' || $object['type'] === 'view') { $problem = "That database has a {$object['type']} ({$name}), which no app migration makes: it would run on the app's behalf. Bring the database the app's own host kept."; break; }
                if ($object['type'] !== 'table') continue;
                // A virtual table has no pages of its own, whatever its CREATE statement says (and
                // a real table may say "virtual" in a comment or a value).
                if ((int) $object['rootpage'] <= 0) { $problem = "That database has a virtual table ({$name}), which a SoftN app may not have."; break; }
                if (str_starts_with(strtolower($name), 'sqlite_')) {
                    if (!in_array(strtolower($name), self::SQLITE_OWN, true)) { $problem = "That database has a table named as SQLite's own ({$name}), which SQLite never makes."; break; }
                    continue;
                }
                if (str_starts_with($name, '_') && !in_array($name, ['_migrations', '_request_limits', self::RECORD_OUTBOX], true)) { $problem = "That database has a table the host keeps for itself ({$name}), which is not a SoftN host's."; break; }
                $tables[$name] = true;
            }
            if ($problem === null) {
                $check = $db->query('PRAGMA quick_check')->fetchAll(PDO::FETCH_COLUMN);
                // A table now, if it is there at all: the list above refused every other kind.
                if (isset($tables['_migrations'])) $ledger = $db->query('SELECT name, sha256 FROM _migrations')->fetchAll();
            }
        } catch (\PDOException $error) {
            $failure = $error->getMessage();
        } finally {
            $db = null;
        }
        if ($problem !== null) throw new InvalidArgumentException($problem);
        if ($failure !== null || $check !== ['ok']) throw new InvalidArgumentException('That database could not be read, or is damaged (SQLite\'s check failed). Copy it again from the old site, with the old site stopped.');
        $wanted = [];
        foreach (is_array($manifest['server']['database']['migrations'] ?? null) ? $manifest['server']['database']['migrations'] : [] as $migration) {
            if (is_string($migration) && is_string($files[$migration] ?? null)) $wanted[$migration] = hash('sha256', $files[$migration]);
        }
        if ($ledger === [] && array_diff(array_keys($tables), ['_migrations', '_request_limits', self::RECORD_OUTBOX]) !== []) {
            throw new InvalidArgumentException('That database has tables but no record of the migrations that made them (_migrations), so it was not kept by a SoftN host.');
        }
        foreach ($ledger as $row) {
            $name = (string) $row['name'];
            if (!isset($wanted[$name])) throw new InvalidArgumentException("That database has run a migration this version of the app does not list ({$name}). Upload the version of the app it came from, or a later one.");
            if ($wanted[$name] !== (string) $row['sha256']) throw new InvalidArgumentException("The migration {$name} that made that database is not this version's file of that name.");
        }
    }


    /**
     * Inside install(), once the new source is active and before the app starts: the imported
     * key into the configuration, and the imported database in place of the app's. The journal's
     * backups of both are put back if the start that follows fails.
     */
    private function placeImport(string $root, array $import, string $configPath): void
    {
        if (is_array($import['key'] ?? null)) {
            $config = json_decode((string) file_get_contents($configPath), true, 64, JSON_THROW_ON_ERROR);
            $config['keyHex'] = $import['key']['keyHex'];
            $config['cryptoDomains'] = $import['key']['cryptoDomains'];
            $this->writeHostConfig($configPath, json_encode($config, JSON_THROW_ON_ERROR));
        }
        $source = (string) $import['database'];
        $target = $root . '/private/data/application.sqlite';
        self::assertOwnDatabase($target);
        // The app's own page size: a failed start puts the app's database back through SQLite's
        // backup API, which cannot write into a database of another page size once the runner has
        // made it WAL, and the app would be left needing recovery.
        $pageSize = null;
        if (is_file($target)) {
            try { $live = new PDO('sqlite:' . $target, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]); $pageSize = (int) $live->query('PRAGMA page_size')->fetchColumn(); }
            finally { $live = null; }
        }
        $placing = $root . '/private/data/importing-' . bin2hex(random_bytes(6)) . '.sqlite';
        try {
            if (!copy($source, $placing) || !$this->sameSize($placing, $source)) throw new RuntimeException('Could not place the imported database');
            try {
                $db = new PDO('sqlite:' . $placing, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                // Its earlier host's queued automation events, if it was a FormLogic: not this site's to deliver.
                if ($db->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=" . $db->quote(self::RECORD_OUTBOX))->fetchColumn()) $db->exec('DELETE FROM ' . self::RECORD_OUTBOX);
                $db->exec('PRAGMA journal_mode=DELETE');
                if ($pageSize !== null && $pageSize > 0 && (int) $db->query('PRAGMA page_size')->fetchColumn() !== $pageSize) {
                    $db->exec('PRAGMA page_size=' . $pageSize);
                    $db->exec('VACUUM');
                }
            } finally {
                $db = null;
            }
            foreach (['-wal', '-shm', '-journal'] as $suffix) if (is_file($target . $suffix)) @unlink($target . $suffix);
            if (!@rename($placing, $target)) throw new RuntimeException('Could not place the imported database');
        } finally {
            foreach (['', '-journal', '-wal', '-shm'] as $suffix) if (is_file($placing . $suffix)) @unlink($placing . $suffix);
        }
    }

    public function install(string $appId, array $project, int $expectedVersion, ?array $import = null): array
    {
        [$files, $decoded, $manifest, $capabilities] = self::validateProject($project);
        // An app with no backend runs nothing on this server, so a server that cannot start the
        // runner (no proc_open, say) still hosts it.
        if (array_key_exists('server', $manifest) && !$this->available()) throw new RuntimeException('Prepare the native app runtime before importing this project');
        $assets = $project['assets'] ?? [];
        $root = $this->root($appId);
        $database = $root . '/private/data/application.sqlite';
        $this->assertCanRestoreDatabase($database);
        $this->directory($root);
        $this->directory($root . '/private');
        $this->directory($root . '/private/data');
        $this->beforeLock($root, 'install');
        $lock = $this->exclusiveLock($root, 'The app is busy. Try again shortly.', true);
        $operation = bin2hex(random_bytes(8));
        $staging = $root . '/staging-' . $operation;
        $configPath = $root . '/private/config.json';
        $journal = null;
        try {
            // Decided under the lock (FL-S04): an update a terminated process left behind is
            // settled first, then the marker, the version and the identity are checked.
            $this->resolveJournal($root);
            $this->assertNotRecoveryRequired($root, 'Restore the app database before installing another update');
            $this->assertCanRestoreDatabase($database);
            $old = $this->get($appId);
            if (($old['version'] ?? 0) !== $expectedVersion) throw new RuntimeException('The project changed. Reload before importing.', 409);
            // An app that had a backend or a database keeps its identity: its data and keys are
            // held to it. One that had neither kept nothing under it, so it may take a new one.
            $configured = self::configuredIdentity($configPath);
            $identity = self::identity($manifest, $appId, $configured);
            $identityFree = $old !== null && !self::hasBackend($old) && !is_file($database);
            $kept = $old ? self::identity(json_decode($old['files']['manifest.json'], true) ?: [], $appId, $configured) : null;
            // Named, because a manifest with no id does not show the one the app runs under.
            if ($old && $kept !== $identity && !$identityFree) throw new InvalidArgumentException("This app runs as {$kept}, and its data and keys are kept under that identity: give manifest.json that id, or none.");
            // A database whose migrations have run keeps its backend: the runner holds every later
            // version to those migrations, and only a server block can list them.
            if ($old && self::hasBackend($old) && !array_key_exists('server', $manifest) && (json_decode($old['files']['manifest.json'], true)['server']['database']['migrations'] ?? []) !== [] && is_file($database)) {
                throw new InvalidArgumentException('This app has a backend whose database migrations have already run, so a version without its server block cannot replace it. Keep the server block (its migrations listed), or create a new app for a version with no backend.');
            }
            if ($old) self::assertMigrationsKept($old['files'], $files);
            $this->stageProject($staging, array_merge(self::runnerFiles($files, $manifest, $identity), $decoded));
            // The journal is the durable intent (FL-S03): written before anything active changes,
            // advanced before each phase, so a process that dies leaves a record of how far it got.
            // It names every file the update may create before that file exists, so whichever way
            // the journal is settled retires them all; a backup is only restored from in a phase
            // that follows its completion (the snapshot's, after its health check).
            $hadConfig = is_file($configPath);
            $hadDatabase = is_file($database);
            $journal = ['operation' => $operation, 'startedAt' => gmdate('c'), 'phase' => 'staged', 'firstInstall' => $old === null, 'oldVersion' => (int) ($old['version'] ?? 0), 'newVersion' => $expectedVersion + 1, 'staging' => basename($staging), 'previous' => null, 'snapshot' => $hadDatabase ? 'pre-install-' . $operation . '.sqlite' : null, 'configBackup' => $hadConfig ? 'config.previous-' . $operation . '.json' : null, 'projectBackup' => $old !== null ? 'project.previous-' . $operation . '.json' : null, 'hadConfig' => $hadConfig, 'hadDatabase' => $hadDatabase];
            $this->writeJournal($root, $journal);
            $this->afterPhase($root, 'staged');
            if (!$hadConfig) {
                $config = ['appId' => $identity, 'development' => false, 'keyHex' => bin2hex(random_bytes(32)), 'capabilities' => $capabilities, 'cryptoDomains' => ['hmac' => $identity . ':hmac:v1', 'seal' => $identity . ':seal:v1']];
                $this->writeHostConfig($configPath, json_encode($config, JSON_THROW_ON_ERROR));
                $this->afterStep($root, 'config-created');
            }
            $originalConfig = file_get_contents($configPath);
            if ($originalConfig === false) throw new RuntimeException('Could not read host configuration');
            if ($hadConfig) $this->writeExact($root . '/private/' . $journal['configBackup'], $originalConfig, 0600);
            if ($old !== null) {
                // The exact bytes a rollback of phase migrated puts back if project.json was replaced.
                $installed = file_get_contents($root . '/project.json');
                if ($installed === false) throw new RuntimeException('Could not read the installed project');
                $this->writeExact($root . '/private/' . $journal['projectBackup'], $installed, 0600);
                unset($installed);
            }
            $this->afterStep($root, 'backups-written');
            $this->advance($root, $journal, 'config-changed');
            $config = json_decode($originalConfig, true, 64, JSON_THROW_ON_ERROR);
            // Owner-authorized updates use the same validated capabilities as a new install.
            // Retain the app identity and cryptographic keys across source updates. The check above
            // lets the identity change only where nothing is held to it (no backend, no database):
            // then the configuration takes the new one, which the runner requires to match.
            $config['capabilities'] = $capabilities;
            $config['enableHostContext'] = true;
            if ($identityFree && ($config['appId'] ?? null) !== $identity) {
                $config['appId'] = $identity;
                $config['cryptoDomains'] = ['hmac' => $identity . ':hmac:v1', 'seal' => $identity . ':seal:v1'];
            }
            $this->writeHostConfig($configPath, json_encode($config, JSON_THROW_ON_ERROR));
            if ($hadDatabase) {
                $snapshot = $root . '/private/' . $journal['snapshot'];
                self::assertOwnDatabase($database);
                $db = new PDO('sqlite:' . $database, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
                $db->exec('PRAGMA busy_timeout=1500');
                $db->exec('VACUUM INTO ' . $db->quote($snapshot));
                $db = null;
                $this->afterStep($root, 'snapshot-taken');
                // Checked before the journal leaves this phase: only source-activated and migrated,
                // which follow the check, restore the database from it.
                $this->assertSnapshotHealthy($snapshot);
            }
            $journal['previous'] = is_dir($root . '/app') ? 'previous-' . $journal['oldVersion'] . '-' . $operation : null;
            $this->advance($root, $journal, 'activating');
            if ($journal['previous'] !== null && !rename($root . '/app', $root . '/' . $journal['previous'])) throw new RuntimeException('Could not stage the update');
            if (!rename($staging, $root . '/app')) throw new RuntimeException('Could not activate app source');
            $this->advance($root, $journal, 'source-activated');
            if ($import !== null) $this->placeImport($root, $import, $configPath);
            // This runs the native host's manifest and migration validation, using its real SQLite
            // database. A client-only app has no backend to start, so nothing runs for it.

            if (array_key_exists('server', $manifest)) {
                $health = $this->invoke($root, ['method' => 'GET', 'path' => '/api/meta', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
                if (($health['status'] ?? 500) !== 200) throw new RuntimeException(self::startupFailure((string) ($health['body']['diagnostic'] ?? '')), 422);
            }
            $this->advance($root, $journal, 'migrated');
            // Saying nothing about who may enter keeps what the app has: a publish that omits
            // it must not open a members-only app to everyone. A new app defaults to members.
            $access = $project['access'] ?? $old['access'] ?? 'members';
            $saved = ['home' => ($project['home'] ?? false) === true, 'version' => $expectedVersion + 1, 'updatedAt' => gmdate('c'), 'files' => $files, 'assets' => $assets, 'access' => $access === 'members' ? 'members' : 'application'];
            $this->writeExact($root . '/project.json', json_encode($saved, JSON_THROW_ON_ERROR), 0600);
            $this->afterStep($root, 'project-written');
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
     * $bodyAsWritten: the answer's body keeps the backend's objects as objects, for a caller that
     * sends it on as JSON (the app's page); otherwise it is read as arrays.
     */
    /**
     * $from: 'app' for a request from the app's own page (visitorRequest), 'plugin' for one from a
     * plugin's page (held to the 2 MB its route always had), null for this site's own calls.
     */
    public function request(string $appId, array $request, array $identity = [], array $subscriptions = [], ?int $generation = null, bool $bodyAsWritten = false, ?string $from = null): array
    {
        // The project without its media (runtimeCache), read under the same lock: this call needs its
        // version and its manifest's server block, and decoding every picture and sound for them on
        // each call kept a PHP worker busy with a game's tens of megabytes, where it had no backend.
        [$root, $lock] = $this->openShared($appId, null, false);
        if ($lock === null) throw new RuntimeException('Native app not found', 404);
        try {
            $project = $this->runtimeCache($root)['project'];
            if ($generation !== null && (int) ($project['version'] ?? 0) !== $generation) throw new RuntimeException('The app was updated while this request was in flight. Reload and try again.', 409);
            if (!self::hasBackend($project)) throw new RuntimeException('This app has no backend', 404);
            if ($from === 'app') $request = self::visitorRequest($project, $request);
            elseif ($from === 'plugin' && strlen(json_encode($request['body'] ?? (object) [], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)) > 2 * 1024 * 1024) throw new RuntimeException('This request is larger than the app accepts.', 413);
            return $this->invoke($root, $request, $identity, $subscriptions, $bodyAsWritten);
        }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * A request from the app's own page, as SoftN's hosts give it: held to its route's body limit,
     * told whether this server can take photos, and on a photo upload route (`upload: "photo"`)
     * carrying the photo this server redrew (PhotoSanitizer) instead of the person's file, or saying
     * that it was refused, which the backend counts and answers. The image itself goes no further.
     */
    private static function visitorRequest(array $project, array $request): array
    {
        $manifest = json_decode((string) ($project['files']['manifest.json'] ?? ''), true);
        $manifest = is_array($manifest) ? $manifest : [];
        $route = null;
        foreach (is_array($manifest['server']['routes'] ?? null) ? $manifest['server']['routes'] : [] as $candidate) {
            if (is_array($candidate) && ($candidate['path'] ?? null) === ($request['path'] ?? null) && ($candidate['method'] ?? null) === ($request['method'] ?? null)) { $route = $candidate; break; }
        }
        $upload = $route !== null && ($route['upload'] ?? null) === 'photo' && ($request['method'] ?? '') === 'POST';
        // Every other route as before: the 2 MB this site has always taken. A photo route takes what
        // it and the app declare, up to SoftN's 5.6 MB.
        $limit = $upload ? self::uploadLimit($route['maxBodySize'] ?? null, $manifest['config']['server']['maxBodySize'] ?? null) : 2 * 1024 * 1024;
        $size = strlen(json_encode($request['body'] ?? (object) [], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        if ($limit === null || $size > $limit) throw new RuntimeException('This request is larger than the app accepts.', 413);
        $request['photos'] = \FormLogic\Support\PhotoSanitizer::available();
        unset($request['upload'], $request['refused'], $request[self::PHOTO_PENDING]);
        if (!$upload) return $request;
        if (!$request['photos']) throw new RuntimeException('Photo uploads need PHP\'s GD extension with JPEG, PNG and WebP support on this server.', 501);
        $body = $request['body'] ?? null;
        $dataUrl = is_object($body) ? ($body->data_url ?? null) : (is_array($body) ? ($body['data_url'] ?? null) : null);
        // Redrawn once the request holds its worker slots (invoke): no more photos are decoded at
        // once than requests run, however many arrive.
        $request[self::PHOTO_PENDING] = $dataUrl;
        $request['body'] = (object) [];
        return $request;
    }

    /** A photo route's body limit (SoftN's softn_body_limit): the smaller of the two declared, at most 5,600,100 bytes; null for a value that is not a size. */
    private static function uploadLimit(mixed $route, mixed $global): ?int
    {
        $declared = [];
        foreach ([$route, $global] as $value) {
            if ($value === null) continue;
            if (is_string($value) && preg_match('/^[0-9]{1,15}$/D', $value)) $value = (int) $value;
            if (!is_int($value) && !(is_float($value) && floor($value) === $value)) return null;
            if ($value < 0) return null;
            $declared[] = (int) $value;
        }
        return $declared === [] ? 5600100 : min(5600100, ...$declared);
    }

    /**
     * Run $use with a connection to the app's database, under the shared management lock, as the
     * runner works on it: for the host's own steps around a request (NativePhoneVerification).
     *
     * @template T
     * @param callable(PDO): T $use
     * @return T
     */
    public function withDatabase(string $appId, callable $use): mixed
    {
        [$root, $lock] = $this->openShared($appId, null, false);
        if ($lock === null) throw new RuntimeException('Native app not found', 404);
        try {
            $path = $root . '/private/data/application.sqlite';
            if (!is_file($path)) throw new RuntimeException('This app has no database yet', 409);
            self::assertOwnDatabase($path);
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $db->exec('PRAGMA busy_timeout=5000');
            try { return $use($db); } finally { $db = null; }
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /** The installed app's manifest, as its source holds it now. */
    public function installedManifest(string $appId): array
    {
        $text = @file_get_contents($this->root($appId) . '/app/manifest.json');
        $manifest = is_string($text) ? json_decode($text, true) : null;
        return is_array($manifest) ? $manifest : [];
    }

    /**
     * FormLogic's own small settings for an installed app, kept in its private folder beside its keys
     * (never the app's configuration, which the runner reads): a name such as `verify.json`.
     */
    public function readPrivateFile(string $appId, string $name): ?string
    {
        $path = $this->privateFile($appId, $name);
        if (!is_file($path) || is_link($path)) return null;
        $text = @file_get_contents($path);
        return is_string($text) ? $text : null;
    }

    public function writePrivateFile(string $appId, string $name, string $text): void
    {
        $path = $this->privateFile($appId, $name);
        if (!is_dir(dirname($path)) || !is_file($this->root($appId) . '/project.json')) throw new RuntimeException('Install the app before changing its settings', 409);
        $this->writeExact($path, $text, 0600);
    }

    public function removePrivateFile(string $appId, string $name): void
    {
        $path = $this->privateFile($appId, $name);
        if (is_file($path) && !@unlink($path)) throw new RuntimeException('Could not remove the setting');
    }

    private function privateFile(string $appId, string $name): string
    {
        if (!preg_match('/^[a-z][a-z0-9-]{0,30}\.json$/D', $name) || $name === 'config.json') throw new InvalidArgumentException('Invalid private setting name');
        return $this->root($appId) . '/private/' . $name;
    }


    /**
     * Deliver committed events only. Failed delivery leaves the event available for retry.
     * $deliver(id, event, data, bindings, readRow) is called for each, in order, and the event is
     * acknowledged when it returns. readRow(table, column, value) reads the whole current row from
     * the app's database on this dispatcher's own connection (an event carries only a preview: 40
     * columns, text cut at 400 characters), or null when there is none.
     */
    public function dispatchRecordEvents(string $appId, callable $deliver, int $limit = 100): int
    {
        $path = $this->root($appId) . '/private/data/application.sqlite';
        if (!is_file($path)) return 0;
        try { [$root, $manage] = $this->openShared($appId, null, false); }
        catch (RuntimeException $busy) { if ($busy->getCode() === 409) return 0; throw $busy; }
        if ($manage === null) return 0;
        $dispatch = fopen($root . '/private/events.lock', 'c');
        try {
            // The database is checked again under the lock: settling an unfinished first install
            // removes it, and opening it here would create an empty one in its place.
            if (!$dispatch || !flock($dispatch, LOCK_EX | LOCK_NB) || !is_file($path) || self::linkedDatabase($path)) return 0;
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            $db->exec('PRAGMA busy_timeout=1500');
            if (!$db->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_formlogic_record_events'")->fetchColumn()) return 0;
            $events = $db->query('SELECT * FROM _formlogic_record_events ORDER BY created_at, rowid LIMIT ' . max(1, min(500, $limit)))->fetchAll();
            $ack = $db->prepare('DELETE FROM _formlogic_record_events WHERE id=?');
            $readRow = static function (string $table, string $column, mixed $value) use ($db): ?array {
                if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,62}$/D', $table) || !preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $column) || (!is_string($value) && !is_int($value))) return null;
                try {
                    $statement = $db->prepare('SELECT * FROM "' . $table . '" WHERE "' . $column . '" = ? LIMIT 1');
                    $statement->execute([$value]);
                    $row = $statement->fetch();
                    return is_array($row) ? $row : null;
                } catch (\PDOException) {
                    return null;
                }
            };
            foreach ($events as $event) {
                $deliver($event['id'], $event['event_name'], json_decode($event['data_json'], true, 64, JSON_THROW_ON_ERROR), json_decode($event['bindings_json'], true, 64, JSON_THROW_ON_ERROR), $readRow);
                $ack->execute([$event['id']]);
            }
            return count($events);
        } finally {
            foreach ([$dispatch, $manage] as $lock) if (is_resource($lock)) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    /** The app root whose worker slots withSlots() holds now: invoke() takes none of its own for it. */
    private ?string $heldRoot = null;

    /** Whether the runtime itself ended the last run uncommitted (lastRunRolledBack()). */
    private bool $lastRolledBack = false;

    /**
     * Whether the last request this service ran was ended by the runtime itself, so committed
     * nothing: its handler threw or failed a host call and was rolled back, or it never got as far
     * as its handler. Read from the runner's error channel (saysRolledBack()), which the app's code
     * cannot write to; never from the app's answer, which the app writes (NativeAppCharges gives a
     * charge back on it).
     */
    public function lastRunRolledBack(): bool
    {
        return $this->lastRolledBack;
    }

    /**
     * The startup stages a runner names that end before a handler can run, in the order both bundled
     * runners pass them (SoftN v0.0.38: request-worker.mjs, and softn-runner's worker.rs): a run
     * that stopped in one of them committed nothing of the app's. `request_integration`, the stage
     * after them, is left out: under Node it lasts through the handler and what follows its COMMIT
     * (the engine's dispose, the answer being written), so it says nothing about what was committed.
     * A stage a later SoftN adds is not here either, until it is read and found to end before the
     * handler.
     */
    public const STAGES_BEFORE_HANDLER = [
        'configuration_read', 'configuration_values', 'bundle_directory', 'manifest_read', 'application_identity',
        'application_capabilities', 'crypto_domains', 'route_configuration', 'application_source', 'data_directory',
        'request_input', 'database_open', 'database_lock', 'database_migrations', 'migration_stopped', 'request_limits',
        'record_events', 'wasm_initialization',
    ];

    /**
     * Whether a runner's error output carries the runtime's own word that the run committed nothing:
     * its `softn: handler <name>: …` line, written as it rolls back a handler that threw or failed a
     * host call, or a `softn: startup stage <stage>: …` line naming a stage that ends before the
     * handler (STAGES_BEFORE_HANDLER). Any other line, `softn: startup stage request_integration`
     * among them, is not that word: the run may have committed, and a paid charge is kept (a retry
     * is told it is paid already).
     */
    public static function saysRolledBack(string $errors): bool
    {
        return preg_match('/^softn: (?:handler |startup stage (?:' . implode('|', self::STAGES_BEFORE_HANDLER) . '): )/m', $errors) === 1;
    }

    /**
     * Run $work with one of the app's worker slots, and one of the site's, held from start to end:
     * every request $work makes runs in them (NativeAppCharges: both runs of a charge, so a debit is
     * never followed by a second run turned away busy). Waits up to three seconds for them, as a
     * request does, and throws 429 when none frees.
     *
     * @template T
     * @param callable(): T $work
     * @return T
     */
    public function withSlots(string $appId, callable $work): mixed
    {
        $root = $this->root($appId);
        if ($this->heldRoot === $root) return $work();
        $slots = $this->takeSlots($root);
        $this->heldRoot = $root;
        try {
            return $work();
        } finally {
            $this->heldRoot = null;
            $this->releaseSlots($slots);
        }
    }

    /**
     * One of the app's worker slots and one of the site's, waiting up to three seconds for them: most
     * requests run in well under a second, so a burst (a screen loading four lists at once) is served,
     * not answered busy.
     *
     * @return list<resource>
     */
    private function takeSlots(string $root): array
    {
        $slots = dirname($root) . '/.runtime-slots';
        $this->directory($slots);
        $take = static function (string $prefix, int $count) use ($slots) {
            for ($index = 0; $index < $count; $index++) {
                $candidate = fopen($slots . '/' . $prefix . $index . '.lock', 'c');
                if ($candidate && flock($candidate, LOCK_EX | LOCK_NB)) return $candidate;
                if ($candidate) fclose($candidate);
            }
            return null;
        };
        $appSlot = null;
        $slot = null;
        $perApp = filter_var(Environment::nonEmpty('NATIVE_WORKERS_PER_APP'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $perApp = min(self::WORKERS, $perApp === false ? self::WORKERS_PER_APP : $perApp);
        $waitUntil = microtime(true) + 3;
        while (true) {
            $appSlot ??= $take(basename($root) . '-', $perApp);
            if ($appSlot) $slot = $take('', self::WORKERS);
            if ($slot || microtime(true) >= $waitUntil) break;
            usleep(50000);
        }
        if (!$slot) {
            if ($appSlot) { flock($appSlot, LOCK_UN); fclose($appSlot); }
            throw new RuntimeException('The native host is busy. Try again shortly.', 429);
        }
        return [$slot, $appSlot];
    }

    /** @param list<resource> $slots */
    private function releaseSlots(array $slots): void
    {
        foreach ($slots as $lock) {
            if (is_resource($lock)) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    private function invoke(string $root, array $request, array $identity = [], array $subscriptions = [], bool $bodyAsWritten = false): array
    {
        $protocol = json_decode((string) file_get_contents($this->runtime() . '/host-protocol.json'), true);
        if ($subscriptions && (!is_file($this->runtime() . '/record-events.mjs') || ($protocol['recordEvents'] ?? null) !== self::RECORD_EVENTS_PROTOCOL)) throw new RuntimeException('Update the native runtime to enable record automations', 503);
        $runner = $this->runnerBinary();
        if ($runner === null) $this->assertNodeMeetsMinimum(is_array($protocol) ? $protocol : null);
        $base = $root . '/private/request-' . bin2hex(random_bytes(12));
        $input = json_encode($request, JSON_THROW_ON_ERROR);
        if (strlen($input) > 6000000) throw new InvalidArgumentException('Request exceeds the native host limit');
        $process = null;
        // Bound concurrent native workers across every app in this storage root: a request takes a
        // slot of its own, unless withSlots() holds one for this app already.
        $slots = $this->heldRoot === $root ? [] : $this->takeSlots($root);
        $this->lastRolledBack = false;
        $answered = false;
        try {
            // A photo is redrawn here, with the slots held (visitorRequest): what is not taken is a
            // refusal the backend counts and answers.
            if (array_key_exists(self::PHOTO_PENDING, $request)) {
                $dataUrl = $request[self::PHOTO_PENDING];
                unset($request[self::PHOTO_PENDING]);
                try { $request['upload'] = \FormLogic\Support\PhotoSanitizer::sanitize($dataUrl); }
                catch (\RuntimeException) { $request['refused'] = 'photo'; }
                unset($dataUrl);
                $input = json_encode($request, JSON_THROW_ON_ERROR);
            }
            file_put_contents($base . '.in', $input);
            unset($input);
            $node = $this->nodeBinary();
            // Only the allowlisted variables reach the runtime (see NODE_ENV_ALLOWLIST); the
            // three SOFTN_* values are the whole host context the worker reads.
            // An operator's cap on what one worker may use; the runner's own limit otherwise.
            $memory = Environment::nonEmpty('SOFTN_RUNNER_MEMORY_MB');
            $env = self::nodeEnvironment(getenv(), ['SOFTN_BACKEND_ROOT' => $root, 'SOFTN_HOST_CONTEXT' => json_encode($identity, JSON_THROW_ON_ERROR), 'SOFTN_RECORD_EVENTS' => json_encode($subscriptions, JSON_THROW_ON_ERROR)] + ($memory !== null ? ['SOFTN_RUNNER_MEMORY_MB' => $memory] : []));
            $command = $runner !== null ? [$runner] : self::runnerCommand($node, $this->runtime());
            $process = proc_open($command, [0 => ['file', $base . '.in', 'r'], 1 => ['file', $base . '.out', 'w'], 2 => ['file', $base . '.err', 'w']], $pipes, $root, $env, ['bypass_shell' => true]);
            // Coded: it never ran, so it committed nothing (NativeAppCharges gives a charge back for it).
            if (!is_resource($process)) throw new RuntimeException('Native runtime could not start', 503);
            $deadline = microtime(true) + 25;
            do {
                $status = proc_get_status($process);
                if (!$status['running']) break;
                if (microtime(true) >= $deadline) { proc_terminate($process); throw new RuntimeException('Native request timed out'); }
                usleep(20000);
            } while (true);
            // The runtime's own word, out of the app's reach, that it rolled this run back (lastRunRolledBack).
            $errors = is_file($base . '.err') ? (string) file_get_contents($base . '.err', false, null, 0, 16384) : '';
            $this->lastRolledBack = self::saysRolledBack($errors);
            $output = is_file($base . '.out') ? file_get_contents($base . '.out', false, null, 0, 3200000) : '';
            $result = json_decode($output, true);
            if (!is_array($result) || !is_int($result['status'] ?? null) || !array_key_exists('body', $result)) throw new RuntimeException('Native runtime returned no response');
            // For the app's own page, the body as the backend wrote it: read as arrays, `{}` and
            // `[]` are one, and an empty object reached the page as a list.
            if ($bodyAsWritten) $result['body'] = json_decode($output, false, 512, JSON_THROW_ON_ERROR)->body;
            $answered = true;
            return $result;
        } finally {
            if (is_resource($process)) proc_close($process);
            $this->releaseSlots($slots);
            // A visitor gets a general error, so this is all anyone will have to go on.
            if (!$answered && is_file($base . '.err') && filesize($base . '.err') > 0) {
                error_log('Native runner failed in ' . basename($root) . ': ' . file_get_contents($base . '.err', false, null, 0, 4096));
            }
            foreach (['.in', '.out', '.err'] as $suffix) if (is_file($base . $suffix)) unlink($base . $suffix);
        }
    }

    /**
     * Browse the same database used by ZIPP; host metadata and auth secrets are excluded from the table view.
     *
     * $options is what the data manager asks beyond a table and an offset. With no table,
     * `summary` adds each table's row count, the database's size and how many tables are not
     * listed. With one, `view` => 'structure' answers how the table is made, and `limit`, `sort`,
     * `dir`, `q` and `filter` are NativeRecordStore::browse()'s. Null is the answer as it was
     * before the data manager, for a caller that reads rows and nothing else (the AI's tool:
     * a page of stamps is some 1,500 tokens no model has a use for).
     */
    public function records(string $appId, ?string $table = null, int $offset = 0, ?int $generation = null, ?array $options = null): array
    {
        [$root, $lock, $project] = $this->openShared($appId, $generation);
        try {
            // A client-only app keeps its data in its members' browsers: there is no database here
            // (unless an earlier version with a backend left one, which is still shown).
            if (!self::hasBackend($project ?? []) && !is_file($root . '/private/data/application.sqlite')) {
                if ($table !== null) throw new RuntimeException('This app has no database', 404);
                return ['installed' => true, 'tables' => [], 'backend' => false];
            }
            $answer = $this->readRecords($root, $table, $offset, $options ?? []);
            return $options === null ? array_diff_key($answer, ['total' => 0, 'matching' => 0, 'stamps' => 0, 'cut' => 0, 'sort' => 0, 'hiddenColumns' => 0]) : $answer;
        }
        finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * A table as a file (`csv` or `json`), or every shown table as JSON with no table named, built
     * under the shared lock into a temporary stream the caller sends and closes: whether a limit
     * cut it short is only known at its end, and the answer's headers must say so. $options are a
     * list's search, filters and sort (NativeRecordStore::export()).
     *
     * @return array{stream: resource, truncated: bool}
     */
    public function exportRecords(string $appId, ?string $table, string $format, array $options = [], ?int $generation = null): array
    {
        [$root, $lock, $project] = $this->openShared($appId, $generation);
        try {
            $path = $root . '/private/data/application.sqlite';
            if (!is_file($path)) throw new RuntimeException(self::hasBackend($project ?? []) ? 'App database not found' : 'This app has no database', 404);
            self::assertOwnDatabase($path);
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            $stream = null;
            try {
                $db->exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN');
                // In memory up to PHP's two megabytes, then a temporary file that goes when the stream is closed.
                $stream = fopen('php://temp', 'w+b');
                if ($stream === false) throw new RuntimeException('The export could not be started');
                $truncated = (new NativeRecordStore($db))->export($stream, $table, $format, $options);
                rewind($stream);
                return ['stream' => $stream, 'truncated' => $truncated];
            } catch (\Throwable $error) {
                if (is_resource($stream)) fclose($stream);
                throw $error;
            } finally {
                // Closed before the lock is given up: an installer that takes it next may replace the file.
                $db = null;
            }
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * What a list of apps shows of an installation, kept cheap, because the apps list asks it of
     * every app an owner has: the project without its media (summary(), as an app's entry reads
     * it), and of its database the file's size and how many tables it lists, read under the shared
     * management lock as every read of it is. No row is counted and no runtime started. Null when
     * nothing is installed. `tables` and `bytes` are null without a database, and when the
     * installation is being updated or its database cannot be read just now: a list is not failed
     * for one app.
     *
     * @return array{version: int|null, access: string|null, backend: bool, tables: int|null, bytes: int|null}|null
     */
    public function glance(string $appId): ?array
    {
        $project = $this->summary($appId);
        if ($project === null) return null;
        $glance = ['version' => is_int($project['version'] ?? null) ? $project['version'] : null, 'access' => is_string($project['access'] ?? null) ? $project['access'] : null,
            'backend' => self::hasBackend($project), 'tables' => null, 'bytes' => null];
        try { [$root, $lock] = $this->openShared($appId, null, false); }
        catch (RuntimeException) { return $glance; }
        if ($lock === null) return $glance;
        try {
            $path = $root . '/private/data/application.sqlite';
            if (!is_file($path) || self::linkedDatabase($path)) return $glance;
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            try {
                $db->exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250');
                $tables = count((new NativeRecordStore($db))->tables());
            } finally { $db = null; }
            clearstatcache(true, $path);
            return ['tables' => $tables, 'bytes' => (int) filesize($path)] + $glance;
        } catch (\PDOException) {
            return $glance;
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * What a record's revision is keyed with (NativeRecordStore): a key of its own, derived from the
     * installation's key, which only this server holds and which stays the same from version to
     * version, so a revision read before an update of the app still names the record after it. Null
     * where the installation has no key to read: the revision is then unkeyed, as it was.
     */
    private static function revisionKey(string $configPath): ?string
    {
        if (!is_file($configPath)) return null;
        $config = json_decode((string) @file_get_contents($configPath), true);
        $key = is_array($config) && is_string($config['keyHex'] ?? null) && preg_match('/^[a-f0-9]{64}$/Di', $config['keyHex']) ? hex2bin($config['keyHex']) : false;
        return $key === false ? null : hash_hmac('sha256', 'formlogic:record-revision:v1', $key, true);
    }

    // ── A JavaScript app's built site ─────────────────────────────────────────────────────────

    /** The key one app's built site has its addresses signed with: made from this installation's own secret and the app's identity. */
    public function siteKey(string $appId): ?string
    {
        $secret = $this->siteSecret();
        return $secret === null ? null : hash_hmac('sha256', 'formlogic:site-address:v1|' . $appId, $secret, true);
    }

    /**
     * This installation's own secret for signing built sites' addresses: made once, on first
     * need, and kept beside the apps' folders, in none of them. An app's own key will not do:
     * its owner can bring one in with an import, and could then write addresses for the app
     * that never run out, and the proof that goes with them. Null where the apps' folder is not
     * there yet (no app has been installed) or the secret cannot be read.
     */
    private function siteSecret(): ?string
    {
        $file = ($this->storagePath ?? dirname(__DIR__, 2) . '/storage/native-apps') . '/site-addresses.key';
        $read = static function () use ($file): ?string {
            $hex = trim((string) @file_get_contents($file));
            return preg_match('/^[a-f0-9]{64}$/D', $hex) === 1 ? (string) hex2bin($hex) : null;
        };
        $there = is_file($file);
        if ($there && ($kept = $read()) !== null) return $kept;
        if (!is_dir(dirname($file))) return null;
        // Written whole under another name first, so nobody ever reads half of it and a write
        // that fails (a full disk) leaves nothing behind. Then given its name: by a link when
        // there is none yet, which only the first of two requests gets, so both end up reading
        // the same one; in place of a file that is there and is no secret (cut short, damaged).
        $writing = $file . '.' . bin2hex(random_bytes(6));
        if (@file_put_contents($writing, bin2hex(random_bytes(32))) !== 64) { @unlink($writing); return null; }
        @chmod($writing, 0600);
        if ($there || (!@link($writing, $file) && !is_file($file))) @rename($writing, $file);
        if (is_file($writing)) @unlink($writing);
        return $read();
    }

    /**
     * What is needed to answer for an installed project's built site, read from the small runtime
     * summary and never from the whole project (which holds every file): the version, the site's
     * first page, and the key its addresses are signed with. Null when the app has no project, no
     * built site, or no key to sign with.
     *
     * @return array{version: int, entry: string, key: string, outside: list<string>}|null
     */
    public function site(string $appId): ?array
    {
        $root = $this->root($appId);
        // This is asked with every file of a page, hundreds of times for one opening, and working
        // it out names the runtime cache by a hash of the whole project. So the answer is kept
        // beside that cache under the project file's size and time, and read from there. Only
        // once the project file is a few seconds old: before that a second install in the same
        // second could leave the same size and time, and the kept answer would be the old one's.
        clearstatcache(true, $root . '/project.json');
        $stat = @stat($root . '/project.json');
        $settled = $stat !== false && time() - (int) $stat['mtime'] > 2;
        $note = $root . self::RUNTIME_CACHE . '/site.json';
        if ($settled && is_file($note)) {
            $kept = json_decode((string) @file_get_contents($note), true);
            if (is_array($kept) && ($kept['size'] ?? null) === $stat['size'] && ($kept['mtime'] ?? null) === $stat['mtime'] && array_key_exists('entry', $kept) && array_key_exists('outside', $kept)) {
                if (!is_string($kept['entry']) || !self::isSitePath('site/' . $kept['entry'])) return null;
                $key = $this->siteKey($appId);
                return $key === null ? null : ['version' => (int) ($kept['version'] ?? 0), 'entry' => $kept['entry'], 'key' => $key, 'outside' => \FormLogic\Middleware\SecurityHeadersMiddleware::siteOutside(is_array($kept['outside']) ? $kept['outside'] : [])];
            }
        }
        try { [$root, $lock] = $this->openShared($appId, null, false); }
        catch (RuntimeException $missing) { if ($missing->getCode() === 404) return null; throw $missing; }
        if ($lock === null) return null;
        try {
            try { $runtime = $this->runtimeCache($root); }
            catch (RuntimeException $missing) { if ($missing->getCode() === 404) return null; throw $missing; }
            $manifest = json_decode((string) ($runtime['project']['files']['manifest.json'] ?? ''), true);
            $entry = is_array($manifest) && is_array($manifest['site'] ?? null) && is_string($manifest['site']['entry'] ?? null) ? $manifest['site']['entry'] : null;
            if ($entry !== null && (!self::isSitePath('site/' . $entry) || !is_file($root . '/app/site/' . $entry))) $entry = null;
            $version = (int) ($runtime['project']['version'] ?? 0);
            // The other sites its owner lets it reach (manifest site.outside), as the policy takes them.
            $outside = \FormLogic\Middleware\SecurityHeadersMiddleware::siteOutside(is_array($manifest) && is_array($manifest['site']['outside'] ?? null) ? $manifest['site']['outside'] : []);
            // Kept for the next file asked for, when the project file is still the one read above.
            clearstatcache(true, $root . '/project.json');
            $now = @stat($root . '/project.json');
            if ($settled && $now !== false && $now['size'] === $stat['size'] && $now['mtime'] === $stat['mtime'] && is_dir(dirname($note))) {
                $writing = $note . '.' . bin2hex(random_bytes(6));
                if (@file_put_contents($writing, json_encode(['size' => $stat['size'], 'mtime' => $stat['mtime'], 'version' => $version, 'entry' => $entry, 'outside' => $outside])) === false || !@rename($writing, $note)) @unlink($writing);
            }
            if ($entry === null) return null;
            $key = $this->siteKey($appId);
            return $key === null ? null : ['version' => $version, 'entry' => $entry, 'key' => $key, 'outside' => $outside];
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * One file of the installed project's built site, opened for reading while the project cannot
     * be replaced under it (the caller sends it and closes it). `$path` is inside the site: it is
     * held to the rule every site file's name was held to when it was installed, so nothing
     * outside the site's own folder can be named. Null when there is no such file.
     *
     * @return array{stream: resource, size: int}|null
     */
    public function siteFile(string $appId, string $path): ?array
    {
        if (!self::isSitePath('site/' . $path)) return null;
        try { [$root, $lock] = $this->openShared($appId, null, false); }
        catch (RuntimeException $missing) { if ($missing->getCode() === 404) return null; throw $missing; }
        if ($lock === null) return null;
        try {
            $file = $root . '/app/site/' . $path;
            if (!is_file($file) || is_link($file)) return null;
            $stream = @fopen($file, 'rb');
            if ($stream === false) return null;
            return ['stream' => $stream, 'size' => (int) filesize($file)];
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * The part of a built site's address that admits a request for it. The site's page runs with
     * no origin, so its requests carry no session: the address itself says they may be answered.
     * It names the version it is for and the last UTC day it works (tomorrow, so an address is
     * good for one to two days), under a signature only this installation can make. It is given
     * out with the runtime descriptor, to whoever may open the app.
     *
     * Its last part is the frame it was made for (`$frame`): a value the browser that opens the
     * app chose and keeps for that app, or one made here when it sent none. Every address under
     * the ticket carries it, so two people who open the same app have different addresses, and
     * what one of them can read from their own (the proof below) is of no use against the other.
     * A browser that keeps its value keeps its address for the day, and the files it has fetched.
     */
    public static function siteTicket(string $key, string $appId, int $version, ?int $now = null, ?string $frame = null): string
    {
        $until = intdiv($now ?? time(), 86400) + 1;
        if ($frame === null || preg_match(self::SITE_FRAME_VALUE, $frame) !== 1) $frame = bin2hex(random_bytes(16));
        return 'v' . $version . '-' . $until . '-' . substr(hash_hmac('sha256', "site|{$appId}|{$version}|{$until}|{$frame}", $key), 0, 40) . '-' . $frame;
    }

    /** What a frame's value is made of: 32 characters, as the page that opens an app makes one. */
    public const SITE_FRAME_VALUE = '/^[a-f0-9]{32}$/D';

    /**
     * The version a ticket is for, when the ticket is this app's, signed here, and in its days:
     * today or tomorrow, never further off (nobody is handed one that is). Null for any other.
     * Read from the ticket alone, before anything of the app is opened.
     */
    public static function siteTicketVersion(string $ticket, string $key, string $appId, ?int $now = null): ?int
    {
        if (preg_match('/^v(\d{1,9})-(\d{1,7})-([a-f0-9]{40})-([a-f0-9]{32})$/D', $ticket, $part) !== 1) return null;
        $today = intdiv($now ?? time(), 86400);
        if ((int) $part[2] < $today || (int) $part[2] > $today + 1) return null;
        return hash_equals(substr(hash_hmac('sha256', "site|{$appId}|{$part[1]}|{$part[2]}|{$part[4]}", $key), 0, 40), $part[3]) ? (int) $part[1] : null;
    }

    /** Whether a ticket is this app's, for this version, signed here and in its days. */
    public static function siteTicketAnswers(string $ticket, string $key, string $appId, int $version, ?int $now = null): bool
    {
        return self::siteTicketVersion($ticket, $key, $appId, $now) === $version;
    }

    /**
     * What a page served under a ticket shows the page that frames it, to be given the app's line
     * to its backend. A page the visitor navigated to inside the frame was not served from here
     * and cannot know it, and neither can anyone who opens the app in a browser of their own:
     * their ticket is another (see `$frame` above), and so is their proof.
     */
    public static function siteProof(string $key, string $ticket): string
    {
        return substr(hash_hmac('sha256', 'site-proof|' . $ticket, $key), 0, 32);
    }

    public function manageRecord(string $appId, array $input, array $subscriptions = [], ?int $generation = null): array
    {
        [$root, $lock] = $this->openShared($appId, $generation);
        try {
            $path = $root . '/private/data/application.sqlite';
            if (!is_file($path)) throw new RuntimeException('App database not found', 404);
            self::assertOwnDatabase($path);
            $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
            return (new NativeRecordStore($db, self::revisionKey($root . '/private/config.json')))->operate($input, $subscriptions);
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    /**
     * Caller holds the shared lock from openShared(), which has already required the project.
     * Read-only, in one transaction, so a page's rows, counts and keys are of one moment.
     */
    private function readRecords(string $root, ?string $table, int $offset, array $options): array
    {
        $path = $root . '/private/data/application.sqlite';
        if (!is_file($path)) throw new RuntimeException('App database not found', 404);
        self::assertOwnDatabase($path);
        $db = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $db->exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN');
        $store = new NativeRecordStore($db);
        if ($table === null) {
            $answer = ['installed' => true, 'tables' => $store->tables()];
            if (!empty($options['summary'])) {
                $overview = $store->overview();
                clearstatcache(true, $path);
                // The database's file, as glance() measures it for the apps list.
                $answer['summary'] = ['tables' => $overview['tables'], 'bytes' => (int) filesize($path), 'hiddenTables' => $overview['hiddenTables']];
            }
            return $answer;
        }
        return ($options['view'] ?? null) === 'structure' ? $store->structure($table) : $store->browse($table, $offset, $options);
    }
}
