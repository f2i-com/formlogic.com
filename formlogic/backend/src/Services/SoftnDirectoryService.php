<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Support\DataEncryption;
use PDO;

/**
 * Publishing a hosted SoftN app to a public SoftN directory (softn.com's, or one the site's administrator names),
 * for an AI agent over MCP and for the person whose account it is.
 *
 * The agent works on drafts: the app's current project packed as a .softn bundle in a staging folder that expires,
 * owned by one account, checked (paths, size, the manifest, what the app declares) and given a hash. It can ask for a
 * draft to be published; it cannot publish. That takes the account's person, signed in on this site, approving the
 * draft on its own page (POST …/approve, a session and CSRF route an MCP token cannot call), which shows the
 * destination, the listing, the permissions, the size and the hash. Approving publishes once: the draft moves to
 * `publishing` in one conditional update, so a second click or a second tab finds it taken, and a published draft
 * answers with its publication. The directory has no accounts: it answers a publish with an edit key, which is kept
 * here encrypted (DATA_ENCRYPTION_KEY; publishing is refused without it) for the account that published, used for
 * that account's updates, and never returned by anything.
 *
 * Off until the administrator names a directory (storage/softn-directory.json): nothing on a site reaches one before.
 */
final class SoftnDirectoryService
{
    /** The directory's own limit (apps/softn-api: maxBundleBytes). */
    public const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
    public const MAX_FILES = 4000;
    public const DRAFT_HOURS = 24;
    /** Drafts an account keeps at once; the oldest goes when another is made. */
    public const MAX_DRAFTS = 10;
    /** Publications (and new versions) an account may make in an hour. */
    public const PUBLISH_PER_HOUR = 10;
    /** Longer than any publish can take (the transport gives up after 120 s): a draft still `publishing` is unclear. */
    public const PUBLISHING_STALE_SECONDS = 300;
    private const UNCERTAIN = 'No clear answer from the directory: the app may have been published. Look for it there before trying again.';

    private PDO $pdo;
    /** @var \Closure(string, string, array<string,string>, array<string,string>, ?string): array{status:int, body:string, error?:string, sent?:bool} */
    private \Closure $transport;
    /** @var \Closure(string): ?array */
    private \Closure $projectOf;

    public function __construct(
        MySQLConnection $mysql,
        private AppService $apps,
        private ?NativeAppService $native = null,
        private ?string $settingsPath = null,
        private ?string $stagingDir = null,
        ?\Closure $transport = null,
        ?\Closure $projectOf = null,
        private ?DataEncryption $encryption = null,
    ) {
        $this->pdo = $mysql->getConnection();
        $this->settingsPath ??= dirname(__DIR__, 2) . '/storage/softn-directory.json';
        $this->stagingDir ??= dirname(__DIR__, 2) . '/storage/softn-drafts';
        $this->transport = $transport ?? \Closure::fromCallable([self::class, 'curl']);
        $this->projectOf = $projectOf ?? fn (string $appId): ?array => ($this->native ??= new NativeAppService())->get($appId);
    }

    // ── The administrator's setting ─────────────────────────────────────────────

    /** Where an edit key is sealed: its row (DataEncryption's associated data), which DataEncryptionMigrator reseals too. */
    public static function editKeyContext(string $publicationId): string
    {
        return 'softn_directory_publications.edit_key:' . $publicationId;
    }

    /** The directory this site publishes to, or null: off. */
    public function directory(): ?string
    {
        $raw = @file_get_contents($this->settingsPath);
        $data = $raw === false ? null : json_decode($raw, true);
        $url = is_array($data) ? ($data['url'] ?? null) : null;
        return is_string($url) && self::directoryUrl($url) === $url ? $url : null;
    }

    /** {url, keysEncrypted}: what the admin card shows. */
    public function settings(): array
    {
        return ['url' => $this->directory(), 'keysEncrypted' => $this->encryption()->enabled() && $this->encryption()->usable()];
    }

    /** Name the directory (an https address, or http on this machine), or null to turn publishing off. */
    public function setDirectory(?string $url): array
    {
        $clean = $url === null || trim($url) === '' ? null : self::directoryUrl(trim($url));
        if ($url !== null && trim($url) !== '' && $clean === null) {
            throw new \InvalidArgumentException('Give the directory’s address: https://…, or http:// on this machine.');
        }
        @mkdir(dirname((string) $this->settingsPath), 0775, true);
        if (file_put_contents((string) $this->settingsPath, json_encode(['url' => $clean], JSON_UNESCAPED_SLASHES)) === false) {
            throw new \RuntimeException('The setting could not be saved.');
        }
        return $this->settings();
    }

    /** An address as kept: scheme and host (and port, path), no credentials, query or trailing slash. */
    public static function directoryUrl(string $url): ?string
    {
        $parts = parse_url($url);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
            return null;
        }
        $scheme = strtolower($parts['scheme']);
        $host = strtolower($parts['host']);
        $local = in_array($host, ['localhost', '127.0.0.1', '[::1]', '::1'], true);
        if (!($scheme === 'https' || ($scheme === 'http' && $local))) {
            return null;
        }
        $path = rtrim((string) ($parts['path'] ?? ''), '/');
        return $scheme . '://' . $host . (isset($parts['port']) ? ':' . (int) $parts['port'] : '') . $path;
    }

    // ── What an agent reads first ───────────────────────────────────────────────

    public function getStarted(): array
    {
        $directory = $this->directory();
        return [
            'directory' => $directory,
            'enabled' => $directory !== null,
            'categories' => $directory !== null ? $this->categories($directory) : [],
            'limits' => ['bundleBytes' => self::MAX_BUNDLE_BYTES, 'files' => self::MAX_FILES, 'draftHours' => self::DRAFT_HOURS, 'publishesPerHour' => self::PUBLISH_PER_HOUR],
            'workflow' => [
                'Build the app as a hosted SoftN app here first: create_softn_app, then update_native_app_files, and check it in its workspace.',
                'softn_create_draft {appId, listing:{name, description, category, tags?, author?}} packs the app’s current files as a .softn draft and checks it. Nothing is public.',
                'softn_validate_draft and softn_preview_draft {draftId}: the checks, the permissions the app declares, and the link where its owner can try it.',
                'softn_publish_draft {draftId} asks for publication and returns approvalUrl: give it to the person. Only they can publish, by approving on that page. Calling it again changes nothing.',
                'softn_get_app {draftId} tells you when it is published, with the app’s page and play links. softn_list_my_apps lists this account’s apps in the directory.',
                'softn_publish_version {draftId, slug} asks to publish a draft as a new version of an app this account published; the person approves it the same way.',
            ],
            'rules' => [
                'Everything in the bundle is public: the directory shows every app’s source. Never put keys, passwords or private data in an app’s files.',
                'The app’s server/ files (its backend here) are left out of the directory’s copy, which runs in the browser alone.',
                'Declare only the permissions the app needs in permission.json; the directory and the person see them before it runs.',
                'Pages are SoftN’s UI language or HTML with SoftN in it; scripts and stylesheets from other sites are not loaded (see the HTML and SoftN guide).',
            ],
            'guides' => ['https://softn.com/docs/html-and-softn/', 'https://softn.com/docs/softn-app-format/', 'https://softn.com/docs/permissions/', 'https://softn.com/docs/publishing/'],
        ];
    }

    /** The directory's categories, {id, name}, or [] when it does not answer. */
    private function categories(string $directory): array
    {
        try {
            $answer = ($this->transport)('GET', $directory . '/api/categories', [], [], null);
            $data = json_decode($answer['body'], true);
            $out = [];
            foreach (is_array($data['categories'] ?? null) ? $data['categories'] : [] as $c) {
                if (is_array($c) && is_string($c['id'] ?? null) && is_string($c['name'] ?? null)) {
                    $out[] = ['id' => $c['id'], 'name' => $c['name']];
                }
            }
            return $out;
        } catch (\Throwable) {
            return [];
        }
    }

    // ── Drafts ──────────────────────────────────────────────────────────────────

    /**
     * Pack the app's current project as a draft, owned by $ownerId, who must own the app. $targetSlug: a new version
     * of an app this account published there.
     */
    public function createDraft(string $ownerId, string $appId, array $listing, ?string $targetSlug = null): array
    {
        $directory = $this->requireDirectory();
        $app = $this->apps->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $ownerId) {
            throw new \DomainException('No app of yours has that id.');
        }
        if (empty($app['settings']['softnApp'])) {
            throw new \InvalidArgumentException('Only a hosted SoftN app can be published to a SoftN directory.');
        }
        if ($targetSlug !== null) {
            $this->ownPublication($ownerId, $directory, $targetSlug);
        }
        $clean = self::listing($listing, $targetSlug === null);
        $project = ($this->projectOf)($appId);
        if (!is_array($project) || !is_array($project['files'] ?? null) || $project['files'] === []) {
            throw new \InvalidArgumentException('The app has no project yet: write its files first.');
        }
        $this->sweep($ownerId);
        $id = bin2hex(random_bytes(16));
        $path = $this->stagingPath($id);
        [$warnings, $permissions] = $this->pack($project, $path);
        $bytes = (int) filesize($path);
        if ($bytes > self::MAX_BUNDLE_BYTES) {
            @unlink($path);
            throw new \InvalidArgumentException('The bundle is ' . round($bytes / 1048576, 1) . ' MB; a directory takes 32 MB at most. Make the assets smaller.');
        }
        $now = gmdate('Y-m-d H:i:s');
        $this->pdo->prepare('INSERT INTO softn_directory_drafts (id, owner_user_id, app_id, directory_url, target_slug, sha256, bytes, listing, permissions, warnings, status, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([
            $id, $ownerId, $appId, $directory, $targetSlug, hash_file('sha256', $path), $bytes,
            json_encode($clean, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), json_encode($permissions), json_encode($warnings, JSON_UNESCAPED_UNICODE),
            'draft', $now, gmdate('Y-m-d H:i:s', time() + self::DRAFT_HOURS * 3600),
        ]);
        return $this->draft($ownerId, $id);
    }

    /** A draft as its owner (and their agent) see it: never the edit key. */
    public function draft(string $ownerId, string $draftId): array
    {
        $row = $this->row($ownerId, $draftId);
        $publication = $row['publication_id'] ? $this->publicationRow((string) $row['publication_id']) : null;
        $expired = strtotime((string) $row['expires_at'] . ' UTC') < time() && $row['status'] !== 'published';
        return [
            'draftId' => $row['id'],
            'appId' => $row['app_id'],
            'status' => $expired ? 'expired' : $row['status'],
            'destination' => $row['directory_url'],
            'target' => $row['target_slug'] !== null ? ['slug' => $row['target_slug']] : null,
            'sha256' => $row['sha256'],
            'bytes' => (int) $row['bytes'],
            'listing' => json_decode((string) $row['listing'], true),
            'permissions' => json_decode((string) $row['permissions'], true),
            'warnings' => json_decode((string) $row['warnings'], true),
            'previewUrl' => '/apps/' . rawurlencode((string) $row['app_id']) . '/softn',
            'approvalUrl' => '/softn-directory/approve/' . $row['id'],
            'expiresAt' => $row['expires_at'],
            'error' => $row['error'],
            'publication' => $publication ? self::publicView($publication) : null,
        ];
    }

    /**
     * Ask for a draft to be published: it waits for its owner's approval on its page. Asking again, or asking for
     * one already published, changes nothing.
     */
    public function requestPublish(string $ownerId, string $draftId): array
    {
        $row = $this->row($ownerId, $draftId);
        $this->requireLive($row);
        if (in_array($row['status'], ['draft', 'failed'], true)) {
            $this->pdo->prepare("UPDATE softn_directory_drafts SET status = 'awaiting_approval', error = NULL WHERE id = ? AND status = ?")->execute([$draftId, $row['status']]);
        }
        return $this->draft($ownerId, $draftId);
    }

    /**
     * The owner, signed in on this site, approves: the draft is published to its directory (or as a new version of
     * its target), once. $anyway: try again a draft whose earlier attempt may or may not have reached the directory.
     */
    public function approve(string $ownerId, string $draftId, bool $anyway = false): array
    {
        $row = $this->row($ownerId, $draftId);
        if ($row['status'] === 'published') {
            return $this->draft($ownerId, $draftId);
        }
        $this->requireLive($row);
        if ($row['directory_url'] !== $this->directory()) {
            throw new \DomainException('This site no longer publishes to ' . $row['directory_url'] . '.');
        }
        $from = $anyway ? ['awaiting_approval', 'failed', 'uncertain'] : ['awaiting_approval', 'failed'];
        $published = (int) $this->pdo->query("SELECT COUNT(*) FROM softn_directory_drafts WHERE owner_user_id = " . $this->pdo->quote($ownerId)
            . " AND status = 'published' AND updated_at > '" . gmdate('Y-m-d H:i:s', time() - 3600) . "'")->fetchColumn();
        if ($published >= self::PUBLISH_PER_HOUR) {
            throw new \DomainException('That is ' . self::PUBLISH_PER_HOUR . ' publications this hour. Try again later.');
        }
        $take = $this->pdo->prepare('UPDATE softn_directory_drafts SET status = \'publishing\', error = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ? AND status IN (' . implode(',', array_fill(0, count($from), '?')) . ')');
        $take->execute([gmdate('Y-m-d H:i:s'), $draftId, $ownerId, ...$from]);
        if ($take->rowCount() !== 1) {
            $now = $this->row($ownerId, $draftId);
            if ($now['status'] === 'uncertain') {
                throw new \DomainException('The last attempt may have reached the directory. Look for the app there before trying again.');
            }
            if (!in_array($now['status'], ['published', 'publishing'], true)) {
                throw new \DomainException('Ask for this draft to be published first.');
            }
            return $this->draft($ownerId, $draftId);
        }
        // From here the draft is this request's: whatever happens, it leaves `publishing` — `failed` while nothing has
        // gone to the directory, `uncertain` once the bundle may have (the app could be listed), never stuck.
        $sent = false;
        try {
            $listing = json_decode((string) $row['listing'], true) ?: [];
            $file = $this->stagingPath($draftId);
            if (!is_file($file) || hash_file('sha256', $file) !== $row['sha256']) {
                $this->fail($draftId, 'failed', 'The draft’s bundle is gone or changed. Make a new draft.');
                return $this->draft($ownerId, $draftId);
            }
            $publication = null;
            if ($row['target_slug'] !== null) {
                $publication = $this->ownPublication($ownerId, (string) $row['directory_url'], (string) $row['target_slug']);
                $key = $this->encryption()->open((string) $publication['edit_key'], self::editKeyContext((string) $publication['id']));
                $sent = true;
                $answer = ($this->transport)('POST', $row['directory_url'] . '/api/apps/' . rawurlencode((string) $row['target_slug']) . '/versions', ['X-Edit-Key' => $key], ['notes' => (string) ($listing['notes'] ?? '')], $file);
            } else {
                $fields = array_filter(['name' => $listing['name'] ?? null, 'description' => $listing['description'] ?? null, 'category' => $listing['category'] ?? null,
                    'author' => $listing['author'] ?? null, 'tags' => isset($listing['tags']) ? implode(',', $listing['tags']) : null], fn ($v) => is_string($v) && $v !== '');
                $sent = true;
                $answer = ($this->transport)('POST', $row['directory_url'] . '/api/apps', [], $fields, $file);
            }
            $data = json_decode($answer['body'] ?? '', true);
            if (($answer['status'] ?? 0) >= 200 && ($answer['status'] ?? 0) < 300 && is_array($data) && is_array($data['app'] ?? null)) {
                $publicationId = $this->record($ownerId, $row, $data, $publication);
                $this->pdo->prepare("UPDATE softn_directory_drafts SET status = 'published', publication_id = ?, updated_at = ? WHERE id = ?")->execute([$publicationId, gmdate('Y-m-d H:i:s'), $draftId]);
                @unlink($file);
            } elseif (($answer['status'] ?? 0) >= 400 && ($answer['status'] ?? 0) < 500) {
                $this->fail($draftId, 'failed', 'The directory refused it: ' . mb_substr(is_array($data) && is_string($data['error'] ?? null) ? $data['error'] : 'HTTP ' . $answer['status'], 0, 400));
            } elseif (($answer['sent'] ?? true) === false) {
                $this->fail($draftId, 'failed', 'The directory could not be reached: ' . mb_substr((string) ($answer['error'] ?? 'no answer'), 0, 300));
            } else {
                // A 5xx or a timeout after the bundle went: the directory may have listed it. Never retried by itself.
                $this->fail($draftId, 'uncertain', self::UNCERTAIN);
            }
        } catch (\Throwable $e) {
            $this->fail($draftId, $sent ? 'uncertain' : 'failed', $sent
                ? self::UNCERTAIN . ' (' . mb_substr($e->getMessage(), 0, 200) . ')'
                : 'It could not be published: ' . mb_substr($e->getMessage(), 0, 300));
        }
        return $this->draft($ownerId, $draftId);
    }

    /** This account's apps in the directory this site publishes to: never their keys. */
    public function publications(string $ownerId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM softn_directory_publications WHERE owner_user_id = ? ORDER BY updated_at DESC');
        $stmt->execute([$ownerId]);
        return array_map([self::class, 'publicView'], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    public function publication(string $ownerId, string $slug): array
    {
        return self::publicView($this->ownPublication($ownerId, $this->requireDirectory(), $slug));
    }

    // ── Inside ──────────────────────────────────────────────────────────────────

    private function requireDirectory(): string
    {
        $directory = $this->directory();
        if ($directory === null) {
            throw new \DomainException('This site does not publish to a SoftN directory. Its administrator can name one in Admin → Platform.');
        }
        if (!$this->encryption()->enabled() || !$this->encryption()->usable()) {
            throw new \DomainException('Publishing to a SoftN directory needs DATA_ENCRYPTION_KEY set on this server, so the apps’ edit keys are kept encrypted.');
        }
        return $directory;
    }

    private function encryption(): DataEncryption
    {
        return $this->encryption ??= DataEncryption::fromEnvironment();
    }

    private function row(string $ownerId, string $draftId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM softn_directory_drafts WHERE id = ? AND owner_user_id = ?');
        $stmt->execute([$draftId, $ownerId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new \DomainException('No draft of yours has that id.');
        }
        // A publish that never finished (its worker was stopped mid-upload) may or may not have reached the
        // directory: after the longest a publish can take, it reads as unclear, which the person can settle.
        if ($row['status'] === 'publishing' && strtotime((string) ($row['updated_at'] ?? $row['created_at']) . ' UTC') < time() - self::PUBLISHING_STALE_SECONDS) {
            $this->pdo->prepare("UPDATE softn_directory_drafts SET status = 'uncertain', error = ? WHERE id = ? AND status = 'publishing'")->execute([self::UNCERTAIN, $draftId]);
            $row['status'] = 'uncertain';
            $row['error'] = self::UNCERTAIN;
        }
        return $row;
    }

    private function requireLive(array $row): void
    {
        if (strtotime((string) $row['expires_at'] . ' UTC') < time()) {
            throw new \DomainException('This draft has expired. Make a new one.');
        }
    }

    private function fail(string $draftId, string $status, string $message): void
    {
        $this->pdo->prepare('UPDATE softn_directory_drafts SET status = ?, error = ?, updated_at = ? WHERE id = ?')->execute([$status, $message, gmdate('Y-m-d H:i:s'), $draftId]);
    }

    private function publicationRow(string $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM softn_directory_publications WHERE id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    private function ownPublication(string $ownerId, string $directory, string $slug): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM softn_directory_publications WHERE owner_user_id = ? AND directory_url = ? AND slug = ?');
        $stmt->execute([$ownerId, $directory, $slug]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new \DomainException('This account has not published an app called ' . $slug . ' there: only its own apps can be updated.');
        }
        return $row;
    }

    private static function publicView(array $row): array
    {
        return ['slug' => $row['slug'], 'name' => $row['name'], 'directory' => $row['directory_url'], 'page' => $row['page_url'], 'play' => $row['play_url'],
            'version' => (int) $row['version'], 'appId' => $row['app_id'], 'updatedAt' => $row['updated_at']];
    }

    /** Keep what the directory answered: the publication and its edit key, encrypted for this row. */
    private function record(string $ownerId, array $draft, array $answer, ?array $existing): string
    {
        $app = $answer['app'];
        $slug = (string) ($app['slug'] ?? ($existing['slug'] ?? ''));
        $base = (string) $draft['directory_url'];
        $page = is_string($app['urls']['page'] ?? null) ? $app['urls']['page'] : '/app/' . rawurlencode($slug);
        $absolute = fn (string $url) => preg_match('#^https?://#', $url) ? $url : $base . (str_starts_with($url, '/') ? '' : '/') . $url;
        $version = (int) ($app['version'] ?? $app['versionCount'] ?? (is_array($app['versions'] ?? null) ? count($app['versions']) : 1));
        $now = gmdate('Y-m-d H:i:s');
        if ($existing !== null) {
            $this->pdo->prepare('UPDATE softn_directory_publications SET version = ?, name = ?, updated_at = ?, app_id = ? WHERE id = ?')
                ->execute([max($version, (int) $existing['version'] + 1), (string) ($app['name'] ?? $existing['name']), $now, $draft['app_id'], $existing['id']]);
            return (string) $existing['id'];
        }
        $key = $answer['editKey'] ?? null;
        if (!is_string($key) || $key === '') {
            throw new \RuntimeException('The directory published the app without an edit key.');
        }
        $id = bin2hex(random_bytes(16));
        $this->pdo->prepare('INSERT INTO softn_directory_publications (id, owner_user_id, directory_url, slug, name, edit_key, page_url, play_url, version, app_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([
            $id, $ownerId, $base, $slug, mb_substr((string) ($app['name'] ?? $slug), 0, 120),
            $this->encryption()->seal($key, self::editKeyContext($id)),
            $absolute($page), $base . '/play/' . rawurlencode($slug), max(1, $version), $draft['app_id'], $now, $now,
        ]);
        return $id;
    }

    /** The listing as the directory takes it. $create: a new app needs a name and a category. */
    public static function listing(array $listing, bool $create): array
    {
        $text = static function (mixed $value, int $max): ?string {
            if (!is_string($value)) return null;
            $value = trim((string) preg_replace('/\s+/u', ' ', (string) preg_replace('/\p{C}/u', ' ', $value)));
            return $value === '' ? null : mb_substr($value, 0, $max);
        };
        $out = array_filter([
            'name' => $text($listing['name'] ?? null, 80),
            'description' => $text($listing['description'] ?? null, 500),
            'category' => is_string($listing['category'] ?? null) && preg_match('/^[a-z0-9][a-z0-9-]{0,40}$/', $listing['category']) ? $listing['category'] : null,
            'author' => $text($listing['author'] ?? null, 60),
            'notes' => $text($listing['notes'] ?? null, 500),
        ], fn ($v) => $v !== null);
        $tags = array_values(array_filter(array_map(fn ($t) => $text($t, 32), is_array($listing['tags'] ?? null) ? array_slice($listing['tags'], 0, 8) : []), fn ($t) => $t !== null));
        if ($tags !== []) $out['tags'] = $tags;
        if ($create && (!isset($out['name']) || !isset($out['category']))) {
            throw new \InvalidArgumentException('A new app needs listing.name and listing.category (softn_get_started lists the directory’s categories).');
        }
        return $out;
    }

    /**
     * Write the project as a .softn bundle at $path: every file and asset but the app's server/ files, whose backend
     * runs here. Returns [warnings, permissions].
     *
     * @return array{0: list<string>, 1: array<string,mixed>}
     */
    private function pack(array $project, string $path): array
    {
        $warnings = [];
        $entries = [];
        foreach ($project['files'] as $name => $source) {
            $entries[(string) $name] = (string) $source;
        }
        foreach (is_array($project['assets'] ?? null) ? $project['assets'] : [] as $name => $data) {
            $raw = is_string($data) ? base64_decode((string) preg_replace('#^data:[^,]*,#', '', $data), true) : false;
            if ($raw === false) throw new \InvalidArgumentException('The asset ' . $name . ' could not be read.');
            $entries[(string) $name] = $raw;
        }
        if (count($entries) > self::MAX_FILES) throw new \InvalidArgumentException('The project has more than ' . self::MAX_FILES . ' files.');
        $left = [];
        foreach (array_keys($entries) as $name) {
            if ($name === '' || str_contains($name, '\\') || str_starts_with($name, '/') || preg_match('#(^|/)\.\.?(/|$)#', $name) || preg_match('/[\x00-\x1f]/', $name)) {
                throw new \InvalidArgumentException('The project has a file named ' . json_encode($name) . ', which a bundle cannot hold.');
            }
            if (str_starts_with($name, 'server/')) $left[] = $name;
        }
        if ($left !== []) {
            foreach ($left as $name) unset($entries[$name]);
            $warnings[] = 'The app’s backend (' . count($left) . ' file' . (count($left) === 1 ? '' : 's') . ' in server/) is left out: the directory’s copy runs in the browser alone, and what needs the backend will not work there.';
        }
        $manifest = json_decode($entries['manifest.json'] ?? '', true);
        if (!is_array($manifest)) throw new \InvalidArgumentException('The project has no manifest.json the directory can read.');
        if (!is_string($manifest['main'] ?? null) || !isset($entries[$manifest['main']])) $warnings[] = 'manifest.json’s main does not name a file in the bundle.';
        $declared = json_decode($entries['permission.json'] ?? '', true);
        $permissions = is_array($declared['permissions'] ?? null) ? $declared['permissions'] : (is_array($manifest['permissions'] ?? null) ? $manifest['permissions'] : []);
        $zip = new \ZipArchive();
        @mkdir(dirname($path), 0775, true);
        if ($zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) throw new \RuntimeException('The draft could not be written.');
        ksort($entries);
        foreach ($entries as $name => $bytes) {
            $zip->addFromString($name, $bytes);
            if (method_exists($zip, 'setMtimeName')) $zip->setMtimeName($name, 0);
        }
        $zip->close();
        return [$warnings, $permissions];
    }

    private function stagingPath(string $draftId): string
    {
        return $this->stagingDir . '/' . $draftId . '.softn';
    }

    /** Expired drafts' bundles go, and an account keeps MAX_DRAFTS - 1 before a new one. */
    private function sweep(string $ownerId): void
    {
        $now = gmdate('Y-m-d H:i:s');
        $stale = $this->pdo->prepare("SELECT id FROM softn_directory_drafts WHERE expires_at < ? AND status <> 'published'");
        $stale->execute([$now]);
        foreach ($stale->fetchAll(PDO::FETCH_COLUMN) as $id) @unlink($this->stagingPath((string) $id));
        $mine = $this->pdo->prepare("SELECT id FROM softn_directory_drafts WHERE owner_user_id = ? AND status NOT IN ('published', 'publishing') AND expires_at >= ? ORDER BY created_at DESC");
        $mine->execute([$ownerId, $now]);
        foreach (array_slice($mine->fetchAll(PDO::FETCH_COLUMN), self::MAX_DRAFTS - 1) as $id) {
            @unlink($this->stagingPath((string) $id));
            $this->pdo->prepare("UPDATE softn_directory_drafts SET expires_at = ? WHERE id = ?")->execute([$now, $id]);
        }
    }

    /**
     * The real transport: curl, a multipart body when a file goes. `sent` false: the request never reached the
     * directory (it could not connect), so trying again cannot make a second app.
     */
    private static function curl(string $method, string $url, array $headers, array $fields, ?string $file): array
    {
        $ch = curl_init($url);
        $head = ['Accept: application/json'];
        foreach ($headers as $k => $v) $head[] = $k . ': ' . $v;
        $options = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 120, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP, CURLOPT_HTTPHEADER => $head, CURLOPT_CUSTOMREQUEST => $method];
        if ($method !== 'GET') {
            $body = $fields;
            if ($file !== null) $body['bundle'] = new \CURLFile($file, 'application/zip', 'app.softn');
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($ch, $options);
        $body = curl_exec($ch);
        $errno = curl_errno($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            return ['status' => 0, 'body' => '', 'error' => $error, 'sent' => !in_array($errno, [CURLE_COULDNT_CONNECT, CURLE_COULDNT_RESOLVE_HOST], true)];
        }
        return ['status' => $status, 'body' => (string) $body];
    }
}
