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
    /**
     * How long a read (the categories softn_get_started lists) may take: a slow directory leaves them
     * out rather than holding an agent's first call, and its PHP worker, for the upload's 120 s.
     */
    public const READ_TIMEOUT_SECONDS = 5;
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
        $this->stagingDir ??= self::stagingRoot();
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
                'softn_publish_version {appId, slug, listing?:{notes}} packs the app’s current files as a new version of an app this account published and asks for it; the person approves it the same way.',
                'A draft is the files as they were when it was made. Change the app afterwards and that draft can no longer be published: make a new one, so what the person tries is what goes out.',
            ],
            'rules' => [
                'Everything in the bundle is public: the directory shows every app’s source. Never put keys, passwords or private data in an app’s files.',
                'What browsers are never served here stays here: server/, backend/, private/, .sql files and the manifest’s server settings. The directory’s copy runs in the browser alone.',
                'Declare only the permissions the app needs in permission.json; the directory and the person see them before it runs.',
                'Pages are SoftN’s UI language or HTML with SoftN in it; scripts and stylesheets from other sites are not loaded (see the HTML and SoftN guide).',
            ],
            'guides' => ['https://softn.com/docs/html-and-softn/', 'https://softn.com/docs/softn-app-format/', 'https://softn.com/docs/permissions/', 'https://softn.com/docs/publishing/'],
        ];
    }

    /**
     * The category $given names, as the directory resolves it (Categories::resolve in SoftN's softn-api): by its id,
     * which is a name as its slug writes it ("Games " is games), or by its name in any case ("Learning" is education).
     * One it does not have it would file as "other", which the page would not have said: refused, while there is an agent
     * to fix it. When the directory's list cannot be read, an id as the directory writes them is taken as given.
     *
     * @return array{id: string, name: ?string}
     */
    private function category(string $directory, string $given): array
    {
        $categories = $this->categories($directory);
        $slug = self::slugOf($given);
        $lower = mb_strtolower(trim($given));
        foreach ($categories as $c) {
            if (($slug !== '' && $c['id'] === $slug) || mb_strtolower($c['name']) === $lower) {
                // The directory reads 40 characters of what it is given (Apps::create): an id longer than that (a
                // suggested category's, made from a name that grew as it was spelt in ASCII) goes as its name.
                if (strlen($c['id']) <= 40) return $c;
                if (mb_strlen($c['name']) <= 40) return ['id' => $c['name'], 'name' => $c['name']];
                throw new \InvalidArgumentException('The directory’s category "' . $c['name'] . '" cannot be named in 40 characters, which is all it reads: choose another.');
            }
        }
        if ($categories === []) {
            // (a name is not guessed at: "Learning" as an id, `learning`, is a category the directory may not have)
            if ($slug !== '' && $slug === trim($given) && strlen($slug) <= 40) return ['id' => $slug, 'name' => null];
            throw new \InvalidArgumentException('The directory’s categories could not be read just now, so "' . $given . '" could not be looked up: try again in a moment, or give a category id of up to 40 characters, as softn_get_started lists them.');
        }
        $known = array_map(fn (array $c) => $c['id'] . ' (' . $c['name'] . ')', $categories);
        throw new \InvalidArgumentException('The directory has no category "' . $given . '": use one of ' . implode(', ', $known) . '.');
    }

    /** A name as the directory's slugs write it (Apps::slugOf in SoftN's softn-api), or '' when it spells none. */
    private static function slugOf(string $name): string
    {
        $s = strtolower(trim($name));
        if (function_exists('iconv')) {
            $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
            if (is_string($t) && $t !== '') $s = $t;
        }
        $s = preg_replace('/[^a-z0-9]+/', '-', $s) ?? '';
        return substr(trim($s, '-'), 0, 48);
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
        if ($targetSlug !== null) {
            // A new version sends its notes alone (the directory keeps the app's name, description and the rest), so the
            // approval page is given nothing else to show.
            $clean = array_intersect_key($clean, ['notes' => true]);
        } else {
            // Sent as its id, and shown by the name the directory lists it under.
            $category = $this->category($directory, $clean['category']);
            $clean['category'] = $category['id'];
            if ($category['name'] !== null) $clean['categoryName'] = $category['name'];
        }
        $project = ($this->projectOf)($appId);
        if (!is_array($project) || !is_array($project['files'] ?? null) || $project['files'] === []) {
            throw new \InvalidArgumentException('The app has no project yet: write its files first.');
        }
        $this->sweep($ownerId);
        $id = bin2hex(random_bytes(16));
        $path = $this->stagingPath($id);
        [$warnings, $permissions, $fromManifest] = $this->pack($project, $path);
        if ($targetSlug === null) {
            // Left out of the listing, the directory takes these from the manifest: they are shown, and sent, as such.
            $clean += self::listing(array_filter($fromManifest, fn ($value) => $value !== null), false);
        }
        $bytes = (int) filesize($path);
        if ($bytes > self::MAX_BUNDLE_BYTES) {
            @unlink($path);
            throw new \InvalidArgumentException('The bundle is ' . round($bytes / 1048576, 1) . ' MB; a directory takes 32 MB at most. Make the assets smaller.');
        }
        $now = gmdate('Y-m-d H:i:s');
        try {
            $kept = self::keptPermissions($permissions);
            $this->pdo->prepare('INSERT INTO softn_directory_drafts (id, owner_user_id, app_id, directory_url, target_slug, sha256, bytes, listing, permissions, warnings, status, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([
                $id, $ownerId, $appId, $directory, $targetSlug, hash_file('sha256', $path), $bytes,
                json_encode($clean, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), $kept, json_encode($warnings, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
                'draft', $now, gmdate('Y-m-d H:i:s', time() + self::DRAFT_HOURS * 3600),
            ]);
        } catch (\Throwable $e) {
            // (no row, so nothing would ever sweep the bundle written for it)
            @unlink($path);
            throw $e;
        }
        return $this->draft($ownerId, $id);
    }

    /**
     * What the approval page reads of the app's permissions, as it is kept with the draft: each capability's `enabled`
     * (true or false) and its list of hosts. Kept whole, a value JSON cannot hold (`1e999` is INF in PHP) made the block
     * unwritable, it was kept as nothing, and the page said the app uses nothing beyond the page while the directory
     * listed, and SoftN granted, what the file asks for; and a block padded to the file's 64 KB could outgrow its column.
     */
    private static function keptPermissions(array $permissions): string
    {
        $kept = [];
        foreach ($permissions as $name => $entry) {
            if (!is_array($entry)) continue;
            $one = [];
            if (array_key_exists('enabled', $entry)) $one['enabled'] = $entry['enabled'] === true;
            if (is_array($entry['allowed_hosts'] ?? null)) $one['allowed_hosts'] = array_values(array_filter($entry['allowed_hosts'], 'is_string'));
            $kept[(string) $name] = $one;
        }
        try {
            $text = json_encode($kept, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \InvalidArgumentException('permission.json holds a host the approval page cannot show (not valid text): correct it.');
        }
        if (strlen($text) > 60000) {
            throw new \InvalidArgumentException('permission.json lists more hosts than the approval page can show: list fewer.');
        }
        return $text;
    }

    /**
     * A draft's listing as the directory takes it now: one made before the listing was held to the directory's rules
     * (a day at most) is shown, and sent, as it will be listed (a name of 64, tags as written there), in its own order.
     */
    private static function storedListing(mixed $stored): array
    {
        if (!is_array($stored)) return [];
        $clean = self::listing($stored, false);
        $out = [];
        foreach ($stored as $key => $value) {
            if (array_key_exists($key, $clean)) $out[$key] = $clean[$key];
            elseif ($key === 'categoryName' && is_string($value)) $out[$key] = $value;
        }
        return $out;
    }

    /** A draft as its owner (and their agent) see it: never the edit key. */
    public function draft(string $ownerId, string $draftId): array
    {
        $row = $this->row($ownerId, $draftId);
        $publication = $row['publication_id'] ? $this->publicationRow((string) $row['publication_id']) : null;
        $expired = strtotime((string) $row['expires_at'] . ' UTC') < time() && $row['status'] !== 'published';
        $target = null;
        if ($row['target_slug'] !== null) {
            // The app it updates, by the name it is listed under there.
            $named = $this->pdo->prepare('SELECT name FROM softn_directory_publications WHERE owner_user_id = ? AND directory_url = ? AND slug = ?');
            $named->execute([$ownerId, $row['directory_url'], $row['target_slug']]);
            $name = $named->fetchColumn();
            $target = ['slug' => $row['target_slug'], 'name' => is_string($name) && $name !== '' ? $name : null];
        }
        $files = $this->bundleFiles((string) $row['id']);
        return [
            'draftId' => $row['id'],
            'appId' => $row['app_id'],
            'status' => $expired ? 'expired' : $row['status'],
            'destination' => $row['directory_url'],
            'target' => $target,
            'sha256' => $row['sha256'],
            'bytes' => (int) $row['bytes'],
            'listing' => self::storedListing(json_decode((string) $row['listing'], true)),
            'permissions' => self::shownPermissions(json_decode((string) $row['permissions'], true), in_array('permission.json', $files, true)),
            'warnings' => json_decode((string) $row['warnings'], true),
            'previewUrl' => '/apps/' . rawurlencode((string) $row['app_id']) . '/softn',
            'approvalUrl' => '/softn-directory/approve/' . $row['id'],
            'expiresAt' => $row['expires_at'],
            'error' => $row['error'],
            'publication' => $publication ? self::publicView($publication) : null,
            'appChanged' => !$expired && $this->appChanged($row),
            'files' => $files,
        ];
    }

    /**
     * Ask for a draft to be published: it waits for its owner's approval on its page. Asking again, or asking for
     * one already published, changes nothing.
     */
    public function requestPublish(string $ownerId, string $draftId): array
    {
        $row = $this->row($ownerId, $draftId);
        if ($row['status'] === 'published') {
            return $this->draft($ownerId, $draftId);
        }
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
        // Without it the directory would take the app and its edit key could not be kept.
        $this->requireDirectory();
        // An app deleted (or in the bin) is one its owner withdrew: its draft does not go out after it.
        $app = $this->apps->getApp((string) $row['app_id']);
        if (!$app || ($app['ownerId'] ?? null) !== $ownerId) {
            throw new \DomainException('This draft’s app has been deleted, so it is not published.');
        }
        if ($this->appChanged($row)) {
            throw new \DomainException('The app has changed since this draft was made, so what you can try is not what this would publish. Ask for a new draft.');
        }
        // What the person was shown it may use, read back as kept: a draft whose block cannot be read showed nothing.
        if (!is_array(json_decode((string) $row['permissions'], true))) {
            throw new \DomainException('What this draft may use could not be read back, so it was not shown to you as it is: ask for a new draft.');
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
            $listing = self::storedListing(json_decode((string) $row['listing'], true));
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
                    'author' => $listing['author'] ?? null, 'notes' => $listing['notes'] ?? null, 'tags' => isset($listing['tags']) ? implode(',', $listing['tags']) : null], fn ($v) => is_string($v) && $v !== '');
                $sent = true;
                $answer = ($this->transport)('POST', $row['directory_url'] . '/api/apps', [], $fields, $file);
            }
            $data = json_decode($answer['body'] ?? '', true);
            if (($answer['status'] ?? 0) >= 200 && ($answer['status'] ?? 0) < 300 && is_array($data) && is_array($data['app'] ?? null)) {
                try {
                    $publicationId = $this->record($ownerId, $row, $data, $publication);
                } catch (\Throwable $e) {
                    // The directory answered: the app is there. Saying "no clear answer" here would invite a second one.
                    $where = is_string($data['app']['slug'] ?? null) ? ' It is at ' . $row['directory_url'] . '/app/' . rawurlencode($data['app']['slug']) . '.' : '';
                    $this->fail($draftId, 'uncertain', 'The directory took the app, but this site could not keep its record, so it cannot be updated from here.' . $where . ' Do not publish it again.');
                    return $this->draft($ownerId, $draftId);
                }
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
        // A slug the directory gives out again names a new app (the old one was removed there): this key is its key.
        $this->pdo->prepare('DELETE FROM softn_directory_publications WHERE directory_url = ? AND slug = ?')->execute([$base, $slug]);
        $id = bin2hex(random_bytes(16));
        $this->pdo->prepare('INSERT INTO softn_directory_publications (id, owner_user_id, directory_url, slug, name, edit_key, page_url, play_url, version, app_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute([
            $id, $ownerId, $base, $slug, mb_substr((string) ($app['name'] ?? $slug), 0, 120),
            $this->encryption()->seal($key, self::editKeyContext($id)),
            $absolute($page), $base . '/play/' . rawurlencode($slug), max(1, $version), $draft['app_id'], $now, $now,
        ]);
        return $id;
    }

    /**
     * The listing as the directory takes it, held to what it keeps (Apps::create and addVersion in SoftN's softn-api:
     * a name of 64 characters, a description of 600 and notes of 400 with their line breaks, an author of 40, tags as
     * Text::tags writes them), so the approval page shows no more and nothing other than is listed. The category as it
     * was given: createDraft finds it among the directory's. $create: a new app needs a name and a category.
     */
    public static function listing(array $listing, bool $create): array
    {
        $text = static function (mixed $value, int $max): ?string {
            if (!is_string($value)) return null;
            $value = trim((string) preg_replace('/\s+/u', ' ', (string) preg_replace('/\p{C}/u', ' ', $value)));
            // (cut, then trimmed again: what the directory lists, as it trims what it is sent)
            return $value === '' ? null : rtrim(mb_substr($value, 0, $max));
        };
        // As Text::clean(…, multiline) keeps it: line breaks and tabs kept, other control characters dropped.
        $lines = static function (mixed $value, int $max): ?string {
            if (!is_string($value)) return null;
            $value = trim((string) preg_replace('/[^\P{C}\n\t]/u', '', str_replace(["\r\n", "\r"], "\n", $value)));
            // (cut, then trimmed again: what the directory lists, as it trims what it is sent)
            return $value === '' ? null : rtrim(mb_substr($value, 0, $max));
        };
        $out = array_filter([
            'name' => $text($listing['name'] ?? null, 64),
            'description' => $lines($listing['description'] ?? null, 600),
            // (48: a suggested category's id may be as long as the directory's slugs, though it reads 40 of what is sent)
            'category' => $text($listing['category'] ?? null, 48),
            'author' => $text($listing['author'] ?? null, 40),
            'notes' => $lines($listing['notes'] ?? null, 400),
        ], fn ($v) => $v !== null);
        $tags = [];
        foreach (is_array($listing['tags'] ?? null) ? $listing['tags'] : [] as $tag) {
            // Lower case, each run of other characters one hyphen, 24 characters, no repeats, 8 at most: as listed.
            $tag = trim((string) preg_replace('/[^a-z0-9][^a-z0-9-]*/', '-', strtolower((string) $text($tag, 24))), '-');
            if ($tag !== '' && !in_array($tag, $tags, true)) $tags[] = $tag;
            if (count($tags) >= 8) break;
        }
        if ($tags !== []) $out['tags'] = $tags;
        if ($create && (!isset($out['name']) || !isset($out['category']))) {
            throw new \InvalidArgumentException('A new app needs listing.name and listing.category (softn_get_started lists the directory’s categories).');
        }
        return $out;
    }

    /**
     * Write the project as a .softn bundle at $path: every file and asset but the app's server/ files, whose backend
     * runs here. Returns [warnings, permissions, the manifest's description and author].
     *
     * @return array{0: list<string>, 1: array<string,mixed>, 2: array{description: ?string, author: ?string}}
     */
    private function pack(array $project, string $path): array
    {
        $warnings = [];
        [$entries, $left] = self::entries($project);
        if ($left > 0) {
            $warnings[] = 'The app’s backend (' . $left . ' file' . ($left === 1 ? '' : 's') . ' in server/, backend/, private/ or .sql) is left out: the directory’s copy runs in the browser alone, and what needs the backend will not work there.';
        }
        // The manifest held to what the directory takes (Bundle::inspect in SoftN's softn-api): refused at publish, after
        // the person approved, it is refused here while the agent can fix it.
        $manifestText = (string) ($entries['manifest.json'] ?? '');
        if (strlen($manifestText) > 256 * 1024) throw new \InvalidArgumentException('manifest.json is larger than 256 KB, which the directory refuses.');
        $manifest = json_decode(str_starts_with($manifestText, "\xEF\xBB\xBF") ? substr($manifestText, 3) : $manifestText, true, 32);
        if (!is_array($manifest)) throw new \InvalidArgumentException('The project has no manifest.json the directory can read.');
        $plain = static fn (mixed $value): string => is_string($value) ? trim((string) preg_replace('/\p{C}/u', '', $value)) : '';
        if ($plain($manifest['name'] ?? null) === '') throw new \InvalidArgumentException('manifest.json has no name, which the directory needs.');
        if ($plain($manifest['version'] ?? null) === '') throw new \InvalidArgumentException('manifest.json has no version, which the directory needs.');
        if (!is_string($manifest['main'] ?? null) || $manifest['main'] === '' || !isset($entries[$manifest['main']])) {
            throw new \InvalidArgumentException('manifest.json’s main does not name a file in the bundle, which the directory refuses.');
        }
        if (array_key_exists('permission.json', $entries)) self::checkDeclaration((string) $entries['permission.json']);
        $permissions = self::declaredPermissions($entries, $manifest);
        $zip = new \ZipArchive();
        @mkdir(dirname($path), 0775, true);
        if ($zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) throw new \RuntimeException('The draft could not be written.');
        ksort($entries);
        foreach ($entries as $name => $bytes) {
            $zip->addFromString($name, $bytes);
            if (method_exists($zip, 'setMtimeName')) $zip->setMtimeName($name, 0);
        }
        $zip->close();
        // What the directory lists for a new app whose listing leaves them out: its manifest's description and author
        // (Apps::create in SoftN's softn-api), so the approval page shows them before they are public.
        $author = $manifest['author'] ?? null;
        $fromManifest = [
            'description' => is_string($manifest['description'] ?? null) ? $manifest['description'] : null,
            'author' => is_string($author) ? $author : (is_array($author) && is_string($author['name'] ?? null) ? $author['name'] : null),
        ];
        return [$warnings, $permissions, $fromManifest];
    }

    /**
     * A draft's permissions as SoftN reads them. A draft made before declaredPermissions kept an older manifest's block
     * as it stood (`network`, `filesystem`), which the page, reading only `enabled: true`, would show as nothing. Not
     * when the bundle has a permission.json ($declared): the block is that file's, read as it stands.
     *
     * @return array<string, mixed>
     */
    private static function shownPermissions(mixed $stored, bool $declared): array
    {
        if (!is_array($stored)) {
            return [];
        }
        if ($declared) {
            return $stored;
        }
        $older = array_key_exists('network', $stored) || array_key_exists('filesystem', $stored);
        if ($older && !array_key_exists('net', $stored) && !array_key_exists('files', $stored)) {
            return self::declaredPermissions([], ['permissions' => $stored]);
        }
        return $stored;
    }

    /**
     * What the bundle may use, as SoftN reads it (extractPermissions in @softn/core's bundle/manifest.ts, and the
     * directory's Bundle::inspect): permission.json's block when the bundle has the file (one it cannot read, or
     * without a block, grants nothing); else the manifest's older `permissions` block, where `network` and
     * `filesystem` turn on the network and files whenever JavaScript reads them as true ("0", [] and {} too: only
     * null, false, 0 and "" are not), and nothing else in it counts.
     *
     * @return array<string, mixed>
     */
    public static function declaredPermissions(array $entries, array $manifest): array
    {
        $text = (string) ($entries['permission.json'] ?? '');
        if ($text !== '') {
            $declared = self::json($text);
            return is_array($declared) && is_array($declared['permissions'] ?? null) ? $declared['permissions'] : [];
        }
        $legacy = $manifest['permissions'] ?? null;
        if (!is_array($legacy)) {
            return [];
        }
        $on = static fn (mixed $value): bool => $value !== null && $value !== false && $value !== 0 && $value !== 0.0 && $value !== '';
        return array_filter([
            'net' => $on($legacy['network'] ?? null) ? ['enabled' => true] : null,
            'files' => $on($legacy['filesystem'] ?? null) ? ['enabled' => true] : null,
        ], fn ($granted) => $granted !== null);
    }

    /**
     * What SoftN's runtime can grant, as the directory lists them (Bundle::CAPABILITIES in SoftN's softn-api, its copy of
     * @softn/core's runtime/capabilities.ts).
     */
    private const CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage', 'accel'];

    /** The storage policies a collection may have there (Storage::POLICIES in SoftN's softn-api). */
    private const STORAGE_POLICIES = ['public', 'append-only', 'owner-write', 'private', 'publisher'];

    /** The largest permission.json the directory reads (Bundle::MAX_PERMISSION_BYTES). */
    private const MAX_PERMISSION_BYTES = 64 * 1024;

    /**
     * A bundle's permission.json held to what the directory takes (Bundle::readDeclaration in SoftN's softn-api): one it
     * would refuse is refused now, while the agent can fix it. Taken, it was refused only at publish, after the person
     * had approved a page that showed `network` as the network, which the runtime never grants (it reads `net`).
     */
    private static function checkDeclaration(string $text): void
    {
        if (strlen($text) > self::MAX_PERMISSION_BYTES) {
            throw new \InvalidArgumentException('permission.json is larger than ' . intdiv(self::MAX_PERMISSION_BYTES, 1024) . ' KB, which the directory refuses.');
        }
        $text = str_starts_with($text, "\xEF\xBB\xBF") ? substr($text, 3) : $text;
        $perm = json_decode($text, true, 16);
        if (!is_array($perm) || (array_is_list($perm) && $perm !== [])) {
            throw new \InvalidArgumentException('permission.json is not a JSON object, and the directory refuses a bundle with such a file: write it as {"permissions": {…}}, or leave it out.');
        }
        $declared = $perm['permissions'] ?? null;
        if ($declared === null) return;
        if (!is_array($declared) || (array_is_list($declared) && $declared !== [])) {
            throw new \InvalidArgumentException('permission.json: "permissions" must be an object, as the directory reads it.');
        }
        $unknown = array_values(array_diff(array_map('strval', array_keys($declared)), self::CAPABILITIES));
        if ($unknown !== []) {
            throw new \InvalidArgumentException('permission.json names capabilities SoftN does not have: ' . implode(', ', $unknown) . '. They are ' . implode(', ', self::CAPABILITIES) . ' (the network is "net", files the visitor picks are "files").');
        }
        $malformed = array_keys(array_filter($declared, fn (mixed $entry) => !is_array($entry) || (array_is_list($entry) && $entry !== [])
            || (array_key_exists('enabled', $entry) && !is_bool($entry['enabled']))));
        if ($malformed !== []) {
            throw new \InvalidArgumentException('permission.json: a capability is an object with a boolean "enabled". Not so for: ' . implode(', ', $malformed) . '.');
        }
        // sync.roomCollections, as readRoomCollections reads it (with objects kept as objects: `{}` is not a list).
        $sync = json_decode($text, false, 16)->permissions->sync ?? null;
        if ($sync instanceof \stdClass && property_exists($sync, 'roomCollections')) {
            $list = $sync->roomCollections;
            $ok = is_array($list) && array_is_list($list);
            foreach ($ok ? $list : [] as $name) {
                if (!is_string($name) || $name === '' || str_contains($name, ':') || str_starts_with($name, '_')) $ok = false;
            }
            if (!$ok) {
                throw new \InvalidArgumentException('permission.json: sync.roomCollections must be a list of collection names, none empty, none with ":" and none starting with "_".');
            }
        }
        // storage.collections, as readStoragePolicies reads it.
        $storage = $declared['storage'] ?? null;
        if (is_array($storage) && array_key_exists('collections', $storage)) {
            $collections = $storage['collections'];
            if (!is_array($collections) || (array_is_list($collections) && $collections !== [])) {
                throw new \InvalidArgumentException('permission.json: storage.collections must be an object of collection name to policy.');
            }
            if (count($collections) > 64) throw new \InvalidArgumentException('permission.json: storage.collections names more than 64 collections.');
            $bad = [];
            foreach ($collections as $name => $policy) {
                if (!preg_match('/^(?:\*|[a-z][a-z0-9_]{0,31})$/D', (string) $name) || !is_string($policy) || !in_array($policy, self::STORAGE_POLICIES, true)) {
                    $bad[] = $name . '=' . (is_string($policy) ? $policy : gettype($policy));
                }
            }
            if ($bad !== []) {
                throw new \InvalidArgumentException('permission.json: storage.collections names a collection or a policy the directory does not accept: ' . implode(', ', $bad)
                    . '. A collection is lowercase letters, digits and underscores (or * for the rest); the policies are ' . implode(', ', self::STORAGE_POLICIES) . '.');
            }
        }
    }

    /** A JSON file as the runtime and the directory read it: a byte order mark does not stop it being read. */
    private static function json(string $text): mixed
    {
        return json_decode(str_starts_with($text, "\xEF\xBB\xBF") ? substr($text, 3) : $text, true);
    }

    /**
     * What a bundle of this project holds: its files and assets, name to bytes, and how many files were left out.
     * Exactly what a browser is served here and no more (NativeAppService::clientFiles, and the manifest as
     * NativeAppController serves it, without its server and engine settings): the bundle is public, so nothing the
     * host keeps from browsers goes in it.
     *
     * @return array{0: array<string,string>, 1: int}
     */
    private static function entries(array $project): array
    {
        $entries = [];
        $client = NativeAppService::clientFiles($project);
        foreach ($client as $name => $source) {
            $entries[(string) $name] = (string) $source;
        }
        if (isset($entries['manifest.json'])) {
            // As objects, so an empty {} in it stays one.
            $text = $entries['manifest.json'];
            $manifest = json_decode(str_starts_with($text, "\xEF\xBB\xBF") ? substr($text, 3) : $text);
            if ($manifest instanceof \stdClass) {
                unset($manifest->server, $manifest->engine, $manifest->logicEngine);
                if (($manifest->config ?? null) instanceof \stdClass) {
                    unset($manifest->config->server, $manifest->config->engine);
                }
                $entries['manifest.json'] = (string) json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            }
        }
        foreach (is_array($project['assets'] ?? null) ? $project['assets'] : [] as $name => $data) {
            $raw = is_string($data) ? base64_decode((string) preg_replace('#^data:[^,]*,#', '', $data), true) : false;
            if ($raw === false) throw new \InvalidArgumentException('The asset ' . $name . ' could not be read.');
            $entries[(string) $name] = $raw;
        }
        if (count($entries) > self::MAX_FILES) throw new \InvalidArgumentException('The project has more than ' . self::MAX_FILES . ' files.');
        foreach (array_keys($entries) as $name) {
            if ($name === '' || str_contains($name, '\\') || str_starts_with($name, '/') || preg_match('#(^|/)\.\.?(/|$)#', $name) || preg_match('/[\x00-\x1f]/', $name)) {
                throw new \InvalidArgumentException('The project has a file named ' . json_encode($name) . ', which a bundle cannot hold.');
            }
        }
        return [$entries, count(is_array($project['files'] ?? null) ? $project['files'] : []) - count($client)];
    }

    /** @return list<string> The names in a draft's bundle, for its page, or [] once it is gone. */
    private function bundleFiles(string $draftId): array
    {
        $zip = new \ZipArchive();
        $path = $this->stagingPath($draftId);
        if (!is_file($path) || $zip->open($path, \ZipArchive::RDONLY) !== true) {
            return [];
        }
        $names = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $names[] = (string) $zip->getNameIndex($i);
        }
        $zip->close();
        sort($names);
        return $names;
    }

    /**
     * Whether the app no longer holds what the draft froze. The person tries the app itself, in its workspace, so a
     * draft is only what they tried while the two match: an agent could otherwise draft one thing, change the app to
     * another, and have that approved in its place. A draft already out, or one whose bundle is gone, has nothing to
     * compare (approve says so about the bundle).
     */
    private function appChanged(array $row): bool
    {
        if (!in_array($row['status'], ['draft', 'awaiting_approval', 'failed', 'uncertain'], true)) {
            return false;
        }
        $zip = new \ZipArchive();
        $path = $this->stagingPath((string) $row['id']);
        if (!is_file($path) || $zip->open($path, \ZipArchive::RDONLY) !== true) {
            return false;
        }
        try {
            $project = ($this->projectOf)((string) $row['app_id']);
            if (!is_array($project) || !is_array($project['files'] ?? null)) {
                return true;
            }
            [$entries] = self::entries($project);
            if ($zip->numFiles !== count($entries)) {
                return true;
            }
            foreach ($entries as $name => $bytes) {
                if ($zip->getFromName($name) !== $bytes) {
                    return true;
                }
            }
            return false;
        } catch (\InvalidArgumentException) {
            return true;
        } finally {
            $zip->close();
        }
    }

    private function stagingPath(string $draftId): string
    {
        return $this->stagingDir . '/' . $draftId . '.softn';
    }

    private static function stagingRoot(): string
    {
        return dirname(__DIR__, 2) . '/storage/softn-drafts';
    }

    /**
     * Expired drafts' bundles go, and a draft a week past its expiry goes altogether. On every new draft, and from
     * bin/artifact-sweep.php so a site where nobody drafts again keeps nothing past its time.
     *
     * @return int the bundles removed
     */
    public static function sweepExpired(PDO $pdo, ?string $stagingDir = null): int
    {
        $stagingDir ??= self::stagingRoot();
        $stale = $pdo->prepare("SELECT id FROM softn_directory_drafts WHERE expires_at < ? AND status <> 'published'");
        $stale->execute([gmdate('Y-m-d H:i:s')]);
        $removed = 0;
        foreach ($stale->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $file = $stagingDir . '/' . $id . '.softn';
            if (is_file($file) && @unlink($file)) $removed++;
        }
        $pdo->prepare("DELETE FROM softn_directory_drafts WHERE expires_at < ? AND status <> 'published'")->execute([gmdate('Y-m-d H:i:s', time() - 7 * 86400)]);
        return $removed;
    }

    /** An account's staged bundles, when it is erased: its rows go with it, and nothing could find these after. */
    public static function eraseStaged(PDO $pdo, string $ownerId, ?string $stagingDir = null): void
    {
        $stagingDir ??= self::stagingRoot();
        $mine = $pdo->prepare('SELECT id FROM softn_directory_drafts WHERE owner_user_id = ?');
        $mine->execute([$ownerId]);
        foreach ($mine->fetchAll(PDO::FETCH_COLUMN) as $id) {
            @unlink($stagingDir . '/' . $id . '.softn');
        }
    }

    /** Expired drafts go, and an account keeps MAX_DRAFTS - 1 before a new one. */
    private function sweep(string $ownerId): void
    {
        $now = gmdate('Y-m-d H:i:s');
        self::sweepExpired($this->pdo, $this->stagingDir);
        $mine = $this->pdo->prepare("SELECT id FROM softn_directory_drafts WHERE owner_user_id = ? AND status NOT IN ('published', 'publishing') AND expires_at >= ? ORDER BY created_at DESC");
        $mine->execute([$ownerId, $now]);
        foreach (array_slice($mine->fetchAll(PDO::FETCH_COLUMN), self::MAX_DRAFTS - 1) as $id) {
            @unlink($this->stagingPath((string) $id));
            $this->pdo->prepare("UPDATE softn_directory_drafts SET expires_at = ? WHERE id = ?")->execute([$now, $id]);
        }
    }

    /**
     * The real transport: curl, a multipart body when a file goes. `sent` false: nothing of the request's body left
     * this server (no connection, a certificate refused), so trying again cannot make a second app.
     */
    private static function curl(string $method, string $url, array $headers, array $fields, ?string $file): array
    {
        $ch = curl_init($url);
        $head = ['Accept: application/json'];
        foreach ($headers as $k => $v) $head[] = $k . ': ' . $v;
        $read = $method === 'GET';
        $options = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $read ? self::READ_TIMEOUT_SECONDS : 120, CURLOPT_CONNECTTIMEOUT => $read ? self::READ_TIMEOUT_SECONDS : 10, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP, CURLOPT_HTTPHEADER => $head, CURLOPT_CUSTOMREQUEST => $method];
        // The bundled roots, where PHP has none of its own (Windows and WAMP): as WebhookService and the others do.
        $caBundle = dirname(__DIR__, 2) . '/resources/cacert.pem';
        if (!ini_get('curl.cainfo') && !getenv('CURL_CA_BUNDLE') && is_file($caBundle)) {
            $options[CURLOPT_CAINFO] = $caBundle;
        }
        if ($method !== 'GET') {
            $body = $fields;
            if ($file !== null) $body['bundle'] = new \CURLFile($file, 'application/zip', 'app.softn');
            $options[CURLOPT_POSTFIELDS] = $body;
        }
        curl_setopt_array($ch, $options);
        $body = curl_exec($ch);
        $uploaded = (int) curl_getinfo($ch, CURLINFO_SIZE_UPLOAD_T);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            return ['status' => 0, 'body' => '', 'error' => $error, 'sent' => $uploaded > 0];
        }
        return ['status' => $status, 'body' => (string) $body];
    }
}
