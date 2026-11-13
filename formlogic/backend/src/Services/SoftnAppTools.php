<?php

declare(strict_types=1);
namespace FormLogic\Services;

/**
 * What an AI does with a hosted SoftN app beyond creating it: look it over, read and change its
 * source and media, read and change its data, and see to its members. For ChatToolsService, which
 * has already settled who is asking and that the app is theirs (ownership, a token's one app):
 * every method here is handed the owned app.
 *
 * Each goes through the service the owner's own pages use (NativeAppService's install and record
 * store, AppUserService), so the same checks hold and the same automations follow a change.
 */
class SoftnAppTools
{
    /** Source handed back in one answer when no file is named; a larger project is listed, and read file by file. */
    public const INLINE_SOURCE_CHARS = 20000;
    /** Files read in one call, and how much source one answer carries (a chat turn is handed 30,000 characters). */
    public const FILES_PER_READ = 20;
    public const READ_CHARS_CHAT = 22000;
    public const READ_CHARS_FULL = 400000;
    /** Media files listed in one answer (a game has up to a thousand). */
    public const MEDIA_LISTED = 200;
    /** Members listed in one answer. */
    private const MEMBERS_LISTED = 500;

    public function __construct(
        private AppService $apps,
        private NativeAppService $native,
        private ?AppUserService $users = null,
        private ?FlowService $flows = null,
        // Record automations queued by a write are delivered through the one router (App AI's jobs
        // among them). Null: the write is made and its automations wait for the next delivery.
        private ?NativeRecordEventRouter $recordEvents = null,
        private ?RuntimeEngineService $engines = null,
    ) {}

    // ── Where things are ────────────────────────────────────────────────────────────────

    /**
     * Where the app runs and where its owner manages it: whole addresses where the surface knows
     * this site's (MCP), else paths.
     *
     * @return array{appUrl: ?string, workspaceUrl: string}
     */
    public static function addresses(array $app, ?array $project, ChatToolsContext $ctx): array
    {
        $base = rtrim((string) ($ctx->siteUrl ?? ''), '/');
        $slug = (string) ($app['slug'] ?? '');
        // Installed as the app's home it opens at the app's own address; otherwise beside it.
        $home = $project === null || !empty($project['home']);
        return [
            'appUrl' => $slug === '' ? null : $base . '/app/' . rawurlencode($slug) . ($home ? '' : '/native'),
            'workspaceUrl' => $base . '/apps/' . rawurlencode((string) $app['id']) . '/softn',
        ];
    }

    /** What stands between the app and the people it is for, in words an AI can pass on. */
    private static function reach(array $app, ?array $project): string
    {
        if ($project === null) return 'Nothing is installed yet.';
        $published = ($app['status'] ?? 'draft') === 'published';
        $who = ($project['access'] ?? 'members') === 'members' ? 'its active members (its owner invites them on the app\'s Members page; update_native_app_files {access: "application"} opens it to anyone instead)' : 'anyone with the address (the app has its own sign-in, or none)';
        return $published
            ? 'Published: open to ' . $who . '.'
            : 'Not published: only its owner opens it. update_app {status: "published"} opens it to ' . $who . '.';
    }

    // ── Overview ────────────────────────────────────────────────────────────────────────

    /** One SoftN app as its Overview page shows it: what is installed, where it runs, how much it holds, who can use it. */
    public function overview(array $app, ChatToolsContext $ctx, bool $withData): array
    {
        $id = (string) $app['id'];
        $glance = $this->native->glance($id);
        $project = $glance === null ? null : $this->native->summary($id);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $out = [
            'app' => ['id' => $id, 'name' => $app['name'] ?? null, 'slug' => $app['slug'] ?? null, 'status' => $app['status'] ?? 'draft', 'description' => $app['description'] ?? null],
            'softnApp' => !empty($settings['softnApp']),
            'installed' => $glance !== null,
            'version' => $glance['version'] ?? null,
            'access' => $glance['access'] ?? null,
            'home' => $project === null ? null : !empty($project['home']),
            'backend' => $glance['backend'] ?? false,
            'reach' => self::reach($app, $project),
            // What the owner chose about the person's own files (Settings → Files on this device).
            'files' => in_array($settings['softnFiles'] ?? null, ['ask', 'allow'], true) ? $settings['softnFiles'] : 'off',
        ] + self::addresses($app, $project, $ctx);
        if ($project !== null) {
            $files = is_array($project['files'] ?? null) ? $project['files'] : [];
            $out['sourceFiles'] = count($files);
            $manifest = json_decode((string) ($files['manifest.json'] ?? ''), true);
            if (is_array($manifest)) {
                $out['manifest'] = array_filter(['name' => $manifest['name'] ?? null, 'version' => $manifest['version'] ?? null, 'main' => $manifest['main'] ?? null], 'is_string');
                $routes = is_array($manifest['server']['routes'] ?? null) ? $manifest['server']['routes'] : [];
                if ($routes !== []) $out['routes'] = array_values(array_filter(array_map(static fn ($route) => is_array($route) && is_string($route['path'] ?? null) ? strtoupper((string) ($route['method'] ?? 'GET')) . ' ' . $route['path'] : null, array_slice($routes, 0, 100))));
            }
        }
        // Table names and row counts are the database's shape; whoever may not read records is told only that it has some.
        if ($glance !== null && $glance['backend']) {
            $out['database'] = ['tables' => $glance['tables'], 'bytes' => $glance['bytes']];
            if ($withData) {
                try {
                    $summary = $this->native->records($id, null, 0, null, ['summary' => true])['summary'] ?? null;
                    if (is_array($summary)) $out['database']['tableRows'] = array_column($summary['tables'] ?? [], 'rows', 'name');
                } catch (\RuntimeException) { /* being updated just now: the counts above stand */ }
            }
        }
        if ($this->users !== null) {
            $members = $this->users->getAppUsers($id);
            $out['members'] = ['total' => count($members), 'active' => count(array_filter($members, static fn (array $m) => ($m['status'] ?? '') === 'active')), 'pending' => count(array_filter($members, static fn (array $m) => ($m['status'] ?? '') === 'pending'))];
        }
        return $out;
    }

    // ── Source and media ────────────────────────────────────────────────────────────────

    /**
     * The installed project for reading. With no file named: its version, settings and every file
     * and media path with its size, and the source itself when it is small. `file` or `files`
     * read source by name. Media are never sent as data (a game's are tens of megabytes): their
     * names and sizes are.
     */
    public function read(array $app, array $args, ChatToolsContext $ctx): array
    {
        $id = (string) $app['id'];
        // The project without its media, settled under the app's lock (an update a stopped process
        // left unfinished is resolved first), as a page that opens the app reads it.
        $runtime = $this->native->runtimeProject($id);
        $project = is_array($runtime['project'] ?? null) ? $runtime['project'] : null;
        if ($project === null) {
            if (isset($args['file']) || isset($args['files'])) throw new \InvalidArgumentException('Project file not found: nothing is installed in this app yet.');
            return ['appId' => $id, 'installed' => false, 'version' => 0, 'files' => [], 'media' => [], 'note' => 'Nothing is installed in this app yet. Install a first version with publish_native_app_project and expectedVersion 0 (get_native_app_template gives a working one).'] + self::addresses($app, null, $ctx);
        }
        $files = is_array($project['files'] ?? null) ? $project['files'] : [];
        $chat = $ctx->source !== 'mcp';
        $limit = $chat ? self::READ_CHARS_CHAT : self::READ_CHARS_FULL;
        // What an answer costs is its length as it is sent. A chat turn is handed a tool's answer as
        // JSON, where a letter outside ASCII is six characters; an MCP client is sent it as it is.
        $cost = static fn (string $text): int => $chat ? strlen((string) json_encode($text, JSON_UNESCAPED_SLASHES)) : strlen($text);
        $missing = static fn (mixed $path): \InvalidArgumentException => new \InvalidArgumentException('Project file not found: ' . (is_string($path) ? mb_substr($path, 0, 200) : 'a path is text') . '. The files are: ' . implode(', ', array_keys($files)));

        // One file, from where the caller says: the way a file longer than one answer is read whole.
        if (isset($args['file']) && !isset($args['files'])) {
            $path = $args['file'];
            if (!is_string($path) || !isset($files[$path])) throw $missing($path);
            $bytes = strlen($files[$path]);
            $offset = isset($args['offset']) && is_int($args['offset']) ? max(0, min($bytes, $args['offset'])) : 0;
            $part = mb_strcut($files[$path], $offset, $limit, 'UTF-8');
            // Shortened until it is within what the answer carries as sent.
            for ($tries = 0; $tries < 8 && $cost($part) > $limit && $part !== ''; $tries++) {
                $part = mb_strcut($part, 0, max(1, (int) floor(strlen($part) * $limit / $cost($part)) - 32), 'UTF-8');
            }
            $next = $offset + strlen($part);
            $out = ['appId' => $id, 'version' => $project['version'] ?? null, 'file' => $path, 'bytes' => $bytes, 'offset' => $offset, 'source' => $part, 'whole' => $offset === 0 && $next >= $bytes, 'files' => array_keys($files)];
            if ($next < $bytes) {
                $out['nextOffset'] = $next;
                $out['note'] = 'This is PART of ' . $path . ': bytes ' . number_format($offset) . ' to ' . number_format($next) . ' of ' . number_format($bytes) . '. Read on with offset: ' . $next . '. A file is written whole, so do not write it back from a part: read all of it first, or change it another way.';
            } elseif ($offset > 0) {
                $out['note'] = 'This is the last part of ' . $path . ' (from byte ' . number_format($offset) . '). A file is written whole: put the parts together before writing it back.';
            }
            return $out;
        }

        $asked = [];
        if (isset($args['file'])) $asked[] = $args['file'];
        if (isset($args['files'])) {
            if (!is_array($args['files']) || !array_is_list($args['files'])) throw new \InvalidArgumentException('files is a list of paths, for example ["manifest.json", "ui/main.ui"].');
            $asked = array_merge($asked, $args['files']);
        }
        if ($asked !== []) {
            if (count($asked) > self::FILES_PER_READ) throw new \InvalidArgumentException('Read at most ' . self::FILES_PER_READ . ' files in one call.');
            // Each file whole or not at all: a file is written back whole, so a cut one is never handed over as if it were it.
            $sources = [];
            $left = $limit;
            $notSent = [];
            foreach (array_unique($asked, SORT_REGULAR) as $path) {
                if (!is_string($path) || !isset($files[$path])) throw $missing($path);
                $costs = $cost($files[$path]);
                if ($costs > $left) { $notSent[] = ['path' => $path, 'bytes' => strlen($files[$path])]; continue; }
                $sources[$path] = $files[$path];
                $left -= $costs;
            }
            $out = ['appId' => $id, 'version' => $project['version'] ?? null, 'sources' => $sources, 'files' => array_keys($files)];
            if ($notSent !== []) $out['notSent'] = ['files' => $notSent, 'note' => 'These did not fit in this answer and none of their text was sent. Read each in a call of its own with file: "<path>"; one longer than an answer carries comes in parts (offset).'];
            return $out;
        }

        $sizes = array_map('strlen', $files);
        $media = [];
        try { $media = $this->native->mediaSizes($id); } catch (\RuntimeException) { /* being updated just now */ }
        $listed = array_slice($media, 0, self::MEDIA_LISTED, true);
        $out = [
            'appId' => $id,
            'installed' => true,
            'version' => $project['version'] ?? null,
            'access' => $project['access'] ?? null,
            'home' => !empty($project['home']),
            'files' => array_map(static fn (string $path, int $bytes) => ['path' => $path, 'bytes' => $bytes], array_keys($sizes), array_values($sizes)),
            'mediaCount' => count($media),
            'media' => array_map(static fn (string $path, int $bytes) => ['path' => $path, 'bytes' => $bytes], array_keys($listed), array_values($listed)),
        ] + self::addresses($app, $project, $ctx);
        if (count($media) > count($listed)) $out['mediaNote'] = 'The first ' . count($listed) . ' of ' . count($media) . ' media files are listed.';
        $total = array_sum(array_map($cost, $files));
        if ($total <= self::INLINE_SOURCE_CHARS) {
            $out['sources'] = $files;
        } else {
            $out['note'] = 'The source is ' . number_format(array_sum($sizes)) . ' characters, so it is listed here and not sent. Read what you need with files: [paths] (up to ' . self::FILES_PER_READ . ' at a time), starting with manifest.json.';
        }
        return $out;
    }

    /**
     * The project an update installs: the installed one with the named files written whole,
     * `remove` taken out, `media` added or replaced (base64) and `removeMedia` taken out, and
     * `access` or `home` changed where given. Everything not named stays as it is.
     */
    public function changed(array $installed, array $args): array
    {
        $project = $installed;
        $project['files'] = is_array($project['files'] ?? null) ? $project['files'] : [];
        $project['assets'] = is_array($project['assets'] ?? null) ? $project['assets'] : [];
        $touched = false;
        foreach (['files' => 'files', 'media' => 'assets'] as $arg => $kept) {
            if (!array_key_exists($arg, $args)) continue;
            if (!is_array($args[$arg]) || ($args[$arg] !== [] && array_is_list($args[$arg]))) throw new \InvalidArgumentException($arg . ' is an object of path to ' . ($arg === 'files' ? 'the file\'s whole text' : 'the file as base64') . '.');
            foreach ($args[$arg] as $path => $content) {
                if (!is_string($path) || !is_string($content)) throw new \InvalidArgumentException('Each of ' . $arg . ' is a path and its ' . ($arg === 'files' ? 'text' : 'base64') . '. To take a file out, name it in ' . ($arg === 'files' ? 'remove' : 'removeMedia') . '.');
                $project[$kept][$path] = $content;
                $touched = true;
            }
        }
        foreach (['remove' => 'files', 'removeMedia' => 'assets'] as $arg => $kept) {
            if (!array_key_exists($arg, $args)) continue;
            if (!is_array($args[$arg]) || !array_is_list($args[$arg])) throw new \InvalidArgumentException($arg . ' is a list of paths.');
            foreach ($args[$arg] as $path) {
                if (!is_string($path) || !array_key_exists($path, $project[$kept])) throw new \InvalidArgumentException('There is no ' . ($kept === 'files' ? 'file' : 'media file') . ' to remove at ' . (is_string($path) ? mb_substr($path, 0, 200) : 'that path') . '.');
                if ($path === 'manifest.json') throw new \InvalidArgumentException('manifest.json is not removed: every app has one. Write it again to change it.');
                unset($project[$kept][$path]);
                $touched = true;
            }
        }
        if (array_key_exists('access', $args)) {
            if (!in_array($args['access'], ['members', 'application'], true)) throw new \InvalidArgumentException('access is "members" (FormLogic membership) or "application" (the app\'s own sign-in, or open to anyone).');
            if ($args['access'] !== ($project['access'] ?? 'members')) $touched = true;
            $project['access'] = $args['access'];
        }
        if (array_key_exists('home', $args)) {
            if (!is_bool($args['home'])) throw new \InvalidArgumentException('home is true or false.');
            if ($args['home'] !== !empty($project['home'])) $touched = true;
            $project['home'] = $args['home'];
        }
        if (!$touched) throw new \InvalidArgumentException('Nothing to change: give files, remove, media, removeMedia, access or home.');
        return $project;
    }

    /**
     * What an install went through with that will not work as written, in words to act on:
     * links that stop the app. The app's frame shows a link to one of the app's own page files
     * in place (from SoftN v0.0.40; before it, every such link took the frame away, and this
     * warned of each), and a link to a place on the same page (`#top`) is harmless. Any other
     * link without a `target` is the browser's to follow: it takes the frame off the app, and
     * this site stops the app there ("This app tried to navigate away and was stopped"). Each
     * kind named here was followed in a browser: a page file the app does not have, an address
     * that names no page file (`about`, `/`, `docs/`, a stylesheet, one of the app's pictures),
     * and another site or a mail address. With a `target` a link opens nothing (the frame may
     * open no window) and the app stays, and the page's own code going to a page that is not
     * there does nothing: neither stops the app.
     *
     * A link is read from the page that shows it, as SoftN reads one (core's bundlePageAt): a
     * part brought in with `<import>` is shown by the pages that import it, and its links are
     * theirs, not its own folder's. One that opens from any page showing it is left alone.
     * Only an address written as plain text is read: one made in code is not known here.
     *
     * @param array<string, string> $files
     * @return list<string>
     */
    public static function warnings(array $files): array
    {
        // What the frame is sent: a link is held to these, never to the backend's files.
        $client = array_filter(NativeAppService::clientFiles(['files' => $files]), 'is_string');
        $isPage = static fn (string $path): bool => preg_match('/\.(?:html?|ui)$/Di', $path) === 1;
        $folder = static fn (string $path): array => array_slice(explode('/', $path), 0, -1);
        // A path as SoftN resolves one: from the root when it begins with a slash, else from
        // `$from`; null when it climbs above the root, which SoftN refuses.
        $resolve = static function (array $from, string $written): ?string {
            $parts = str_starts_with($written, '/') ? [] : $from;
            foreach (explode('/', $written) as $part) {
                if ($part === '' || $part === '.') continue;
                if ($part === '..') { if ($parts === []) return null; array_pop($parts); continue; }
                $parts[] = $part;
            }
            return implode('/', $parts);
        };
        // Which files bring each file in, so that a part's links are read from the pages showing it.
        $importedBy = [];
        foreach ($client as $file => $source) {
            if (!$isPage((string) $file) || !preg_match_all('~<import\b[^>]{0,1000}?\bfrom\s*=\s*(["\'])([^"\'{}]{1,300})\1~i', $source, $imports)) continue;
            foreach ($imports[2] as $from) {
                $part = $resolve($folder((string) $file), strtr(trim($from), '\\', '/'));
                if ($part !== null && $part !== (string) $file && isset($client[$part])) $importedBy[$part][(string) $file] = true;
            }
        }
        $shownBy = static function (string $file) use ($importedBy): array {
            $pages = [];
            $seen = [$file => true];
            $queue = [$file];
            while ($queue !== []) {
                $at = array_shift($queue);
                $by = array_keys($importedBy[$at] ?? []);
                if ($by === []) { $pages[] = $at; continue; }
                foreach ($by as $importer) {
                    $importer = (string) $importer;
                    if (!isset($seen[$importer])) { $seen[$importer] = true; $queue[] = $importer; }
                }
            }
            // Files that only import one another are shown by nothing else: read from the file itself.
            return $pages === [] ? [$file] : $pages;
        };
        $shown = static fn (string $address): string => substr((string) preg_replace('/[^\x20-\x7E]/', '?', $address), 0, 80);
        // A page without what is commented out and without markup shown as an example (<pre>,
        // <code>). Read once from start to end, whatever the page holds: a pattern that looks for
        // each closing would read to the end of a 1.5 MB page again for every opening left open.
        $strip = static function (string $text): string {
            foreach ([['<!--', '-->'], ['<pre', '</pre'], ['<code', '</code']] as [$open, $close]) {
                $kept = '';
                $at = 0;
                while (($from = stripos($text, $open, $at)) !== false) {
                    $after = $from + strlen($open);
                    // <preview> is not <pre>.
                    if ($open !== '<!--' && !in_array($text[$after] ?? '', [' ', "\t", "\n", "\r", '>', '/'], true)) { $kept .= substr($text, $at, $after - $at); $at = $after; continue; }
                    $to = stripos($text, $close, $after);
                    // A comment left open runs to the end of the page; an example left open is not one.
                    if ($to === false) { if ($open === '<!--') { $kept .= substr($text, $at, $from - $at); $at = strlen($text); } break; }
                    $kept .= substr($text, $at, $from - $at);
                    $at = $to + strlen($close);
                }
                $text = $kept . substr($text, $at);
            }
            return $text;
        };

        $missing = $notPages = $outside = $byCode = [];
        foreach ($client as $file => $source) {
            $file = (string) $file;
            if (!$isPage($file)) continue;
            $pages = $shownBy($file);
            // Whether `$written` names a page of the app from any page that shows this file.
            $opens = static function (string $written) use ($pages, $folder, $resolve, $client, $isPage): bool {
                foreach ($pages as $page) {
                    $target = $resolve($folder($page), $written);
                    if ($target !== null && $isPage($target) && isset($client[$target])) return true;
                }
                return false;
            };
            $named = static fn (string $written): string => $resolve($folder($pages[0]), $written) ?? $written;
            $text = $strip($source);
            // Each <a> and what is written in it, up to its first ">" (a thousand characters of
            // it). Found by reading on from the last, so a page of "<a" with no ">" costs one pass.
            $anchors = [];
            $close = -1;
            for ($at = 0; ($from = stripos($text, '<a', $at)) !== false; $at = $from + 2) {
                if (!in_array($text[$from + 2] ?? '', [' ', "\t", "\n", "\r", '/', '>'], true)) continue;
                if ($close < $from) $close = strpos($text, '>', $from);
                if ($close === false) break;
                if ($close - $from <= 1002) $anchors[] = substr($text, $from + 2, $close - $from - 2);
            }
            foreach ($anchors as $attributes) {
                // With a target the link opens nothing here and the app stays: not this warning's.
                if (preg_match('~(?<![\w:.-])target\s*=\s*(["\']?)(?!_self\b)[^\s"\'>]~i', $attributes)) continue;
                if (!preg_match('~(?<![\w:.-])href\s*=\s*(["\'])(.*?)\1~is', $attributes, $href)) continue;
                $address = trim($href[2]);
                if ($address === '' || $address[0] === '#' || strlen($address) > 300 || preg_match('/[{}]/', $address)) continue;
                if (preg_match('~^(?:https?:|mailto:|//)~i', $address)) { $outside[$file . ': ' . $shown($address)] = true; continue; }
                // Any other scheme (tel:, javascript:, data:, blob:) was not followed in a browser: left alone.
                if (preg_match('~^[a-z][a-z0-9+.-]*:~i', $address)) continue;
                $written = strtr((string) (preg_split('/[?#]/', $address, 2) ?: [''])[0], '\\', '/');
                if ($written !== '' && $opens($written)) continue;
                if ($isPage($written)) $missing[$file . ' → ' . $named($written)] = true;
                else $notPages[$file . ': "' . $shown($address) . '"'] = true;
            }
            // The page's own code going to a page, written as plain text.
            if (preg_match_all('~\blocation(?:\.href)?\s*=\s*(["\'])([^"\'{}]{1,300})\1|\blocation\.(?:assign|replace)\(\s*(["\'])([^"\'{}]{1,300})\3~', $text, $goes, PREG_SET_ORDER)) {
                foreach ($goes as $go) {
                    $address = trim(($go[2] ?? '') !== '' ? $go[2] : ($go[4] ?? ''));
                    if ($address === '' || $address[0] === '#' || preg_match('~^(?:[a-z][a-z0-9+.-]*:|//)~i', $address)) continue;
                    $written = strtr((string) (preg_split('/[?#]/', $address, 2) ?: [''])[0], '\\', '/');
                    if ($written === '' || !$isPage($written) || $opens($written)) continue;
                    $byCode[$file . ' → ' . $named($written)] = true;
                }
            }
        }
        $list = static fn (array $found): string => implode('; ', array_slice(array_keys($found), 0, 8)) . (count($found) > 8 ? '; and ' . (count($found) - 8) . ' more' : '');
        $warnings = [];
        if ($missing !== []) $warnings[] = 'A link names a page file this app does not have, and following it stops the app until it is reopened (' . $list($missing) . '). Add that page to the app, or correct the link to a page it has: a link to one of the app\'s own page files opens it in place, read from the page that shows the link. Change that before telling the person it is done.';
        if ($notPages !== []) $warnings[] = 'A link that names no page file stops the app when it is followed (' . $list($notPages) . '). A link here opens a page file of the app, named in full with its ending and read from the page that shows the link ("about.html", "docs/guide.html": not "about", "/" or a folder, and never above the app\'s own folder), or a place on the same page ("#top"). It opens no stylesheet, picture or other file. Change that before telling the person it is done.';
        if ($outside !== []) $warnings[] = 'A link to another site or to a mail address does not open from an app hosted here: followed, it stops the app until it is reopened (' . $list($outside) . '). Show the address as text the person can copy, not as a link. Change that before telling the person it is done.';
        if ($byCode !== []) $warnings[] = 'The page\'s code goes to a page file this app does not have, which does nothing (' . $list($byCode) . '). Add that page, or correct the name.';
        return $warnings;
    }

    /** What an install answers: the new version, what the project now holds, and where to see it. */
    public function installed(array $app, array $saved, ChatToolsContext $ctx): array
    {
        $id = (string) $app['id'];
        $warnings = self::warnings(is_array($saved['files'] ?? null) ? $saved['files'] : []);
        return ($warnings === [] ? [] : ['warnings' => $warnings]) + [
            'appId' => $id,
            // A SoftN app is managed on its own page; a forms app that hosts a project, in App Studio.
            'softnApp' => !empty($app['settings']['softnApp']),
            'version' => $saved['version'],
            'files' => array_keys(is_array($saved['files'] ?? null) ? $saved['files'] : []),
            'media' => array_keys(is_array($saved['assets'] ?? null) ? $saved['assets'] : []),
            'access' => $saved['access'] ?? null,
            'home' => $saved['home'] ?? false,
            'reach' => self::reach($app, $saved),
            // Kept for callers that read it before the app had a page of its own.
            'editorUrl' => self::addresses($app, $saved, $ctx)['workspaceUrl'],
            'next' => 'Installed. Its backend, if it has one, started on this version, or the install would have been refused. The page is drawn in the browser, which is the one place a mistake in a page shows: open appUrl, or ask the person to, before calling it done.',
        ] + self::addresses($app, $saved, $ctx);
    }

    // ── Data ────────────────────────────────────────────────────────────────────────────

    /**
     * The app's tables, or one page of a table: searched, filtered and sorted as the owner's data
     * manager does it, through the same store (hidden columns stay hidden, values are previews).
     */
    public function records(array $app, array $args): array
    {
        $id = (string) $app['id'];
        $table = isset($args['table']) && is_string($args['table']) && $args['table'] !== '' ? $args['table'] : null;
        if ($table === null) {
            $answer = $this->native->records($id, null, 0, null, ['summary' => true]);
            $tables = $answer['summary']['tables'] ?? array_map(static fn ($name) => ['name' => $name], $answer['tables'] ?? []);
            return ['installed' => $answer['installed'] ?? true, 'backend' => $answer['backend'] ?? true, 'tables' => $tables]
                + (($answer['backend'] ?? true) === false ? ['note' => 'This app has no backend: what it saves is kept in each visitor\'s own browser, and there is nothing here to read.'] : []);
        }
        if (($args['view'] ?? null) === 'structure') return $this->native->records($id, $table, 0, null, ['view' => 'structure']);

        $options = [];
        if (isset($args['search'])) $options['q'] = $args['search'];
        if (isset($args['filter'])) $options['filter'] = $args['filter'];
        if (isset($args['sort'])) { $options['sort'] = $args['sort']; $options['dir'] = ($args['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc'; }
        // Any number of rows up to the store's largest page: the store pages by a few fixed sizes,
        // so the next one up is read and cut to what was asked.
        $want = isset($args['limit']) && is_int($args['limit']) ? max(1, min(max(NativeRecordStore::PAGE_SIZES), $args['limit'])) : NativeRecordStore::PAGE;
        foreach (NativeRecordStore::PAGE_SIZES as $size) { if ($size >= $want) { $options['limit'] = $size; break; } }
        $answer = $this->native->records($id, $table, max(0, (int) ($args['offset'] ?? 0)), null, $options);
        if (count($answer['rows'] ?? []) > $want) {
            $answer['rows'] = array_slice($answer['rows'], 0, $want);
            if (isset($answer['keys'])) $answer['keys'] = array_slice($answer['keys'], 0, $want);
            $answer['hasMore'] = true;
            if (($answer['end'] ?? '') === 'end') $answer['end'] = 'more';
        }
        $answer = ['table' => $table] + $answer;
        $answer['limit'] = $want;
        // Which values are previews, by the row's place in this page; the stamps are for the data manager's own multi-row delete.
        $cut = [];
        foreach ((array) ($answer['cut'] ?? []) as $index => $columns) if ((int) $index < $want) $cut[(string) $index] = $columns;
        $answer['cut'] = (object) $cut;
        unset($answer['stamps'], $answer['tables']);
        if ($cut !== []) $answer['note'] = 'Values named in cut are previews (400 characters). get_native_app_record gives a row\'s whole values.';
        return $answer;
    }

    /** One record whole, with the revision a later change must name. */
    public function record(array $app, array $args): array
    {
        if (!is_string($args['table'] ?? null) || !is_array($args['key'] ?? null)) throw new \InvalidArgumentException('Name the table and the record\'s key, as list_native_app_records gave it: {"table": "items", "key": {"id": "1"}}.');
        return $this->native->manageRecord((string) $app['id'], ['action' => 'read', 'table' => $args['table'], 'key' => $args['key']]);
    }

    /**
     * A record created, changed or deleted, as the owner's data manager does it: the database's own
     * rules apply and the automations bound to the table follow, but the app's backend functions
     * are not run. A change or a deletion names the revision the record was read at.
     */
    public function changeRecord(array $app, array $args): array
    {
        $id = (string) $app['id'];
        $action = $args['action'] ?? null;
        if (!in_array($action, ['create', 'update', 'delete'], true)) throw new \InvalidArgumentException('action is "create", "update" or "delete".');
        if (!is_string($args['table'] ?? null) || $args['table'] === '') throw new \InvalidArgumentException('Name the table.');
        $input = ['action' => $action, 'table' => $args['table']];
        if ($action !== 'create') {
            if (!is_array($args['key'] ?? null)) throw new \InvalidArgumentException('Name the record by its key, as list_native_app_records gave it: {"id": "1"}.');
            if (!is_string($args['revision'] ?? null) || $args['revision'] === '') throw new \InvalidArgumentException('Read the record first (get_native_app_record) and pass its revision: a record that changed since is not overwritten or deleted unseen.');
            $input += ['key' => $args['key'], 'revision' => $args['revision']];
        }
        if ($action !== 'delete') {
            if (!is_array($args['values'] ?? null)) throw new \InvalidArgumentException('Give the values to save: {"title": "…"}. Only the fields that change, for an update.');
            $input['values'] = $args['values'];
        }
        $result = $this->native->manageRecord($id, $input, $this->flows?->nativeRecordSubscriptions($id) ?? []);
        if ($this->recordEvents !== null) {
            try { $this->native->dispatchRecordEvents($id, $this->recordEvents->for($id)); }
            catch (\Throwable) { error_log('Native record automation delivery pending for app ' . $id); }
        }
        return $result + ['action' => $action, 'table' => $args['table']];
    }

    // ── Members ─────────────────────────────────────────────────────────────────────────

    private function users(): AppUserService
    {
        return $this->users ?? throw new \RuntimeException('Members are unavailable.');
    }

    /** The people who can use the app, and the invitations still open. */
    public function members(array $app): array
    {
        $id = (string) $app['id'];
        $members = array_map(static fn (array $member) => [
            'memberId' => $member['id'] ?? null,
            'name' => $member['name'] ?? null,
            'email' => $member['email'] ?? null,
            'role' => $member['roleName'] ?? null,
            'roleId' => $member['roleId'] ?? null,
            'status' => $member['status'] ?? null,
            'joinedAt' => $member['joinedAt'] ?? null,
            'isOwner' => ($member['userId'] ?? null) === ($app['ownerId'] ?? null),
        ], $this->users()->getAppUsers($id));
        // The invitations still open: one that was accepted, withdrawn or has run out is not someone on their way in.
        $now = time();
        $open = array_values(array_filter($this->users()->getInvitations($id), static function (array $invitation) use ($now): bool {
            $expires = is_string($invitation['expiresAt'] ?? null) ? strtotime($invitation['expiresAt'] . (preg_match('/[zZ]|[+-]\d\d:?\d\d$/', $invitation['expiresAt']) ? '' : ' UTC')) : false;
            return ($invitation['status'] ?? null) === 'pending' && ($expires === false || $expires > $now);
        }));
        $invitations = array_map(static fn (array $invitation) => array_intersect_key($invitation, ['id' => 1, 'email' => 1, 'roleId' => 1, 'roleName' => 1, 'status' => 1, 'expiresAt' => 1, 'createdAt' => 1]), $open);
        return [
            'total' => count($members),
            'members' => array_slice($members, 0, self::MEMBERS_LISTED),
            'invitations' => array_slice($invitations, 0, self::MEMBERS_LISTED),
            'note' => 'These are the people FormLogic admits to an app that asks for membership. An app with its own sign-in (access "application") keeps its accounts in its own database: read them with list_native_app_records.',
        ];
    }

    /** A member suspended, let back in, or given another role. */
    public function updateMember(array $app, array $args, string $actor): array
    {
        $id = (string) $app['id'];
        $member = (string) ($args['memberId'] ?? '');
        if ($member === '' || !$this->users()->appUserBelongsToApp($member, $id)) throw new ChatToolDeniedException('That member is not in this app. list_app_members gives each one\'s memberId.', 'not_found');
        $data = [];
        if (isset($args['status'])) {
            if (!in_array($args['status'], ['active', 'suspended'], true)) throw new \InvalidArgumentException('status is "active" or "suspended".');
            $data['status'] = $args['status'];
        }
        if (isset($args['roleId'])) {
            if (!is_string($args['roleId']) || !$this->users()->roleBelongsToApp($args['roleId'], $id)) throw new ChatToolDeniedException('That role is not one of this app\'s. list_app_roles gives them.', 'app_scope');
            $data['roleId'] = $args['roleId'];
        }
        if ($data === []) throw new \InvalidArgumentException('Give a status ("active" or "suspended") or a roleId.');
        // A refusal is the service's own words (the owner is not suspended, the Owner role is not given). A
        // database error is a RuntimeException too, and its text names tables and columns: it goes on as it is.
        try { $this->users()->updateAppUser($member, $data, $actor, $id); }
        catch (\PDOException $database) { throw $database; }
        catch (\RuntimeException $refused) { throw new \InvalidArgumentException($refused->getMessage()); }
        return ['memberId' => $member] + $data;
    }

    /** A member taken out of the app. Their account elsewhere on the site is untouched. */
    public function removeMember(array $app, array $args, string $actor): array
    {
        $id = (string) $app['id'];
        $member = (string) ($args['memberId'] ?? '');
        if ($member === '' || !$this->users()->appUserBelongsToApp($member, $id)) throw new ChatToolDeniedException('That member is not in this app. list_app_members gives each one\'s memberId.', 'not_found');
        try { $this->users()->removeAppUser($member, $actor, $id); }
        catch (\PDOException $database) { throw $database; }
        catch (\RuntimeException $refused) { throw new \InvalidArgumentException($refused->getMessage()); }
        return ['memberId' => $member, 'removed' => true];
    }
}
