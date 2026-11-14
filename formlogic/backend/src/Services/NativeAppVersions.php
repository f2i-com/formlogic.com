<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Support\Environment;
use InvalidArgumentException;
use RuntimeException;

/**
 * Every version of a native app (a SoftN app or a JavaScript app) that a later one replaced, kept
 * beside its project so its owner can look at one and go back to it (docs/APP_BACKEND_API.md,
 * "Versions and going back").
 *
 * Storage, under the installation's own folder (NativeAppService's root for the app):
 *  - history/index.json            the truth. The versions kept, newest first, and what is known
 *                                  of the current one (`head`: who made it, how, what it changed,
 *                                  and what it holds: its source by hash, its media by map and by
 *                                  `print`, a quick hash of the media as the project carries it).
 *                                  A version is kept exactly when this file names it; everything
 *                                  else in the folder is content it may name.
 *  - history/index.pending-<op>.json   one install's record, written before that install changes
 *                                  anything and given the index's name only once it has succeeded.
 *  - history/texts/<sha256>.gz     a version's source files, whole: {path: text} as JSON, gzipped,
 *                                  named by the SHA-256 of that JSON. Two versions with the same
 *                                  source (a change of media, a setting) share one.
 *  - history/maps/<sha256>.gz      a version's media and built files by name: {path: [sha256, size]}.
 *  - history/blobs/<sha256>        one media or built file's bytes, once, however many versions
 *                                  and paths name it. A project may hold 64 MB of them and they
 *                                  rarely change, so no version keeps a copy of its own.
 *  - history/write.lock            held while the index is changed outside an install (a pin, a
 *                                  removal).
 *  - history/damaged-index-<when>.json   an index that was there and did not read as one, set
 *                                  aside when the next install started the history again.
 *                                  Nothing reads it; it is an operator's to look at.
 *
 * Nothing is ever half there. Each file is written under another name, flushed, and renamed into
 * place. An install lays the replaced version's content by and writes its record as a pending
 * file (prepare), under the installation's exclusive management lock and after its journal exists;
 * the journal's roll-forward gives the record its name (commit) and its roll-back removes it
 * (discard), whether the install is alive or a later process is settling what it left. So the
 * record of a version appears only when the install that replaced it succeeded, and a failed or
 * recovered install leaves the history as it was. Content written for an install that failed is
 * named by nothing and goes at the next successful one.
 *
 * The history never decides whether an install happens. Where it cannot be prepared (a full disk,
 * a folder that cannot be written, an index another program is holding), the install goes ahead
 * and the version it replaces is not kept: said in the log, and in the list as a gap, which the
 * index shows by itself (its head is then an earlier version than the one installed) and the next
 * record carries (`gap`). An index that is there and cannot be read just now is never replaced,
 * and nothing is removed against it. One that reads and is not an index is set aside under
 * another name, never written over, and nothing is removed that time.
 *
 * What is kept: the newest KEEP earlier versions and any that are pinned, within maxBytes() for
 * the whole history (content counted once). When it is over, the oldest unpinned go first, then
 * the oldest pinned; the newest KEEP_ALWAYS are never taken by the size limit. An owner can take
 * an earlier version out too (remove()): its content goes where no other kept version names it.
 *
 * Going back is a new version whose content is the old one's, installed like any other. The
 * database is not touched: its migrations only go forward, so the ones already applied stay
 * listed in the version that comes back (databaseAhead).
 *
 * Reads take the shared management lock (NativeAppService::withHistory), as every other read of
 * an installation does. An install holds it exclusively throughout, so a pin or a removal, which
 * holds it shared and its own write lock, can never fall between an install's prepare and its
 * commit. Before either writes the index, a record an install could not give its name is given
 * it (settled()), as the next install would: nothing is written into an index that is behind.
 */
final class NativeAppVersions
{
    /** How many earlier versions are kept, newest first. A pinned one is kept past them. */
    public const KEEP = 30;
    /** The newest earlier versions the size limit never takes. */
    public const KEEP_ALWAYS = 3;
    /**
     * The most one app's whole history may take: four times what one project may hold. A project's
     * media is kept once however many versions share it, and its source compresses to a small part
     * of a megabyte, so an ordinary app keeps all its versions in one copy of its media and a few
     * megabytes. Only an app that replaces tens of megabytes of media at every publish reaches
     * this, and it then keeps fewer versions. A site sets another limit with NATIVE_HISTORY_MB.
     */
    public const MAX_BYTES = 4 * NativeAppService::MAX_PROJECT_BYTES;
    /** How many versions may be pinned at once: each can hold a whole project's media. */
    public const MAX_PINNED = 20;
    /** A version's one-line summary is cut to this many characters. */
    public const SUMMARY_LENGTH = 200;
    /**
     * How a version came to be: saved on the app's page, uploaded as a file, changed by an AI
     * over MCP or in FormLogic's chat, a going back, the app's data brought from another host
     * (the same source installed again), a pack, a plugin.
     */
    public const HOW = ['page', 'upload', 'mcp', 'chat', 'rollback', 'import', 'pack', 'plugin'];
    /** How many paths of each kind a version's record lists; the counts beside them are exact. */
    public const PATHS_LISTED = 300;

    private const FOLDER = '/history';
    private const FORMAT = 1;
    private const DAMAGED = 'One of this version\'s files is missing from the app\'s history or damaged, so it cannot be read.';
    /**
     * What reading the index found (readIndex): nothing there; an index; something there whose
     * bytes could not be read just now (another program holds it, a passing error, not a plain
     * file); bytes that were read whole and are not an index. The last two are never the first.
     */
    private const NONE = 'none';
    private const READ = 'read';
    private const BUSY = 'busy';
    private const UNREADABLE = 'unreadable';
    private const BUSY_NOW = 'The app\'s history could not be read just now. Try again shortly.';

    public function __construct(private NativeAppService $native) {}

    /** The size limit for one app's whole history, in bytes. */
    public static function maxBytes(): int
    {
        $megabytes = filter_var(Environment::nonEmpty('NATIVE_HISTORY_MB'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 1024 * 1024]]);
        return $megabytes === false ? self::MAX_BYTES : $megabytes * 1024 * 1024;
    }

    // ── The three steps of an install (called by NativeAppService, which holds the exclusive lock) ──

    /**
     * Before an install changes anything: lay by the content of the project it replaces ($old;
     * null for a first install), and write the record of that version, with what is known of the
     * new one, as this install's pending index. Nothing here is visible until commit().
     *
     * Never throws, and never stands between an owner and a publish: where the history cannot be
     * prepared (its folder cannot be written, the disk is full, its index is there and cannot be
     * read just now) the install goes ahead, the version it replaces is not kept, and the log says
     * so. Nothing of this install is then left pending, so commit() replaces nothing and removes
     * nothing; the list shows the gap (gapBefore()). Answers whether the record was prepared.
     *
     * @param array<string, mixed>|null $old the installed project, as NativeAppService::get() reads it
     * @param array<string, mixed> $project the project being installed, as its caller gave it
     * @param array<string, string> $files its source files, validated
     * @param array<string, string> $decoded its media and built files, decoded
     * @param array{by?: mixed, how?: mixed, summary?: mixed, restored?: mixed}|null $origin who is installing it, how, and a line saying what for
     */
    public static function prepare(string $root, string $operation, ?array $old, array $project, array $files, array $decoded, int $version, ?array $origin = null): bool
    {
        try {
            self::record($root, $operation, $old, $project, $files, $decoded, $version, $origin);
            return true;
        } catch (\Throwable $error) {
            $pending = $root . self::FOLDER . '/index.pending-' . $operation . '.json';
            if (self::isOperation($operation) && is_file($pending)) @unlink($pending);
            // What is said is which version, and why in this class's own words: no file's content.
            error_log('Native app history: ' . ($old === null ? 'no history was started' : 'version ' . (int) ($old['version'] ?? 0) . ' was not kept')
                . ' when version ' . $version . ' was installed (' . self::said($root, $error) . ')');
            return false;
        }
    }

    /**
     * prepare()'s work. Throws when it cannot be done.
     *
     * @param array<string, mixed>|null $old
     * @param array<string, mixed> $project
     * @param array<string, string> $files
     * @param array<string, string> $decoded
     * @param array{by?: mixed, how?: mixed, summary?: mixed, restored?: mixed}|null $origin
     */
    private static function record(string $root, string $operation, ?array $old, array $project, array $files, array $decoded, int $version, ?array $origin): void
    {
        if (!self::isOperation($operation)) throw new InvalidArgumentException('Invalid update identity');
        $dir = $root . self::FOLDER;
        foreach (['', '/texts', '/maps', '/blobs'] as $part) self::directory($dir . $part);
        // Read before anything is laid by. An index that is there and cannot be read just now is
        // not an empty one: a record written from it would hold this one version, and giving it
        // the index's name would drop every other.
        $index = self::readIndex($dir);
        if ($index['state'] === self::BUSY) throw new RuntimeException('its index is there and could not be read just now');

        $newAssets = array_filter(is_array($project['assets'] ?? null) ? $project['assets'] : [], 'is_string');
        $newSettings = [
            // As install() decides them: saying nothing about who may enter keeps what the app has.
            'access' => ($project['access'] ?? $old['access'] ?? 'members') === 'members' ? 'members' : 'application',
            'home' => ($project['home'] ?? false) === true,
        ];
        $versions = [];
        $print = null;
        if ($old === null) {
            $newMap = self::newMap($decoded, $newAssets, [], []);
            $changes = self::changes([], [], $files, $newMap, null, null);
        } else {
            $oldVersion = (int) ($old['version'] ?? 0);
            $oldFiles = array_filter(is_array($old['files'] ?? null) ? $old['files'] : [], 'is_string');
            $oldAssets = is_array($old['assets'] ?? null) ? $old['assets'] : [];
            $oldJson = self::json($oldFiles);
            $oldPrint = self::printOf($oldAssets);
            // Where a record known to be this project's already names each of its files (knownMap),
            // a file whose bytes are kept under that name is not decoded and hashed again. Any
            // doubt about one file hashes it, and any disagreement hashes them all.
            $known = self::knownMap($dir, $index, $operation, $oldVersion, hash('sha256', $oldJson), $oldPrint);
            $oldMap = self::keepAssets($dir, $oldAssets, $known ?? []);
            if ($known !== null && $oldMap !== $known) $oldMap = self::keepAssets($dir, $oldAssets);
            [$oldText, $oldTextBytes] = self::putObject($dir, 'texts', $oldJson);
            [$oldMapKey, $oldMapBytes] = $oldMap === [] ? [null, 0] : self::putObject($dir, 'maps', self::json($oldMap));
            $index = self::adopting($dir, $index, $operation, $oldVersion, $oldText, $oldMapKey);
            // What was recorded of this version when it was installed, if it is this version: a
            // project put there another way (a restore from a backup, an app from before its
            // history was kept) has no one known to have made it.
            $head = self::describes($index['head'], $oldVersion, $oldText, $oldMapKey) ? $index['head'] : null;
            $oldSettings = ['access' => ($old['access'] ?? '') === 'members' ? 'members' : 'application', 'home' => ($old['home'] ?? false) === true];
            $record = [
                'version' => $oldVersion,
                'madeAt' => is_string($old['updatedAt'] ?? null) ? $old['updatedAt'] : null,
                'by' => $head['by'] ?? null, 'how' => $head['how'] ?? null, 'summary' => $head['summary'] ?? null, 'restored' => $head['restored'] ?? null,
                'changes' => is_array($head['changes'] ?? null) ? $head['changes'] : null,
                'pinned' => ($head['pinned'] ?? false) === true,
                'text' => $oldText, 'textBytes' => $oldTextBytes, 'map' => $oldMapKey, 'mapBytes' => $oldMapBytes,
                'files' => count($oldFiles), 'assets' => count($oldMap),
                'bytes' => array_sum(array_map('strlen', $oldFiles)) + array_sum(array_column($oldMap, 1)),
            ] + $oldSettings;
            // The versions before this one that were replaced without being kept: an install whose
            // history could not be prepared leaves the index behind, and it is said here once.
            $gap = $head !== null ? self::gapOf($head) : self::gapBefore($index, $oldVersion);
            if ($gap !== null) $record['gap'] = $gap;
            // An index that did not read as one is set aside by commit(): the history starts again here.
            if ($index['state'] === self::UNREADABLE) $record['startedAgain'] = true;
            // Newest first. A record of this number or a later one is of a project that is no longer there.
            $versions = array_values(array_filter($index['versions'], static fn (array $kept): bool => $kept['version'] < $oldVersion));
            array_unshift($versions, $record);
            $unchanged = false;
            $newMap = self::newMap($decoded, $newAssets, $oldAssets, $oldMap, $unchanged);
            // Media that is the replaced project's, path for path and text for text, has its print.
            if ($unchanged) $print = $oldPrint;
            $changes = self::changes($oldFiles, $oldMap, $files, $newMap, $oldSettings, $newSettings);
        }
        $made = self::origin($origin);
        $head = ['version' => $version] + $made + [
            'changes' => $changes, 'pinned' => false,
            // What the new project holds, by content: the next install knows this record is of the
            // project it replaces by these, and a comparison with a kept version reads them.
            'text' => hash('sha256', self::json($files)),
            'map' => $newMap === [] ? null : self::putObject($dir, 'maps', self::json($newMap))[0],
            'print' => $print ?? self::printOf($newAssets),
            'files' => count($files), 'assets' => count($newMap),
            'bytes' => array_sum(array_map('strlen', $files)) + array_sum(array_column($newMap, 1)),
        ];
        $pending = ['format' => self::FORMAT, 'head' => $head, 'versions' => self::pruned($dir, $versions)];
        self::write($dir . '/index.pending-' . $operation . '.json', json_encode($pending, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    /**
     * The install succeeded: its pending index takes the index's name, in one rename, and what
     * the index no longer names is removed. An install whose record could not be prepared left
     * none pending: nothing is replaced and nothing removed. Never throws: the install is done
     * whatever happens here, and a record that could not be given its name is taken up by the
     * next install (adopting()), or by the next pin or removal (settled()).
     */
    public static function commit(string $root, string $operation): void
    {
        try {
            if (!self::isOperation($operation)) return;
            $dir = $root . self::FOLDER;
            $pending = $dir . '/index.pending-' . $operation . '.json';
            if (!is_file($pending)) return;
            if (self::adopt($dir, $pending)) self::sweep($dir, true);
        } catch (\Throwable $error) {
            error_log('Native app history: the version an update replaced was not recorded (' . self::said($root, $error) . ')');
        }
    }

    /**
     * The install did not happen: its pending index goes, and so does the content laid by for it,
     * so the folder holds what it held before. Never throws: what cannot be removed now is named
     * by nothing, and goes at the next install.
     */
    public static function discard(string $root, string $operation): void
    {
        try {
            $dir = $root . self::FOLDER;
            if (!self::isOperation($operation) || !is_dir($dir)) return;
            $pending = $dir . '/index.pending-' . $operation . '.json';
            if (is_file($pending) && !@unlink($pending)) throw new RuntimeException('its record could not be removed');
            // Not while a record another install could not give its name is waiting to be taken
            // up (adopting()): the content it names is named by it alone.
            if ((glob($dir . '/index.pending-*.json') ?: []) !== []) return;
            self::sweep($dir);
            // A first install that failed leaves no history folder behind (each goes only if empty).
            if (!self::present($dir . '/index.json')) {
                foreach (['/texts', '/maps', '/blobs', ''] as $part) @rmdir($dir . $part);
            }
        } catch (\Throwable $error) {
            error_log('Native app history: what an update that failed laid by was not removed (' . self::said($root, $error) . ')');
        }
    }

    // ── Reading the history, and going back (the owner's routes) ─────────────────────────────

    /**
     * The versions, newest first: the current one, then every earlier one that is kept. Each says
     * whether it is `damaged` (a file of it is missing from the history, so it cannot be gone back
     * to; its owner can remove it) and, as `gap`, the versions just before it that were replaced
     * without being kept. `unreadable`: an index is there and is not one, so only the current
     * version is listed (the next install starts the history again).
     *
     * @return array{current: int, versions: list<array<string, mixed>>, bytes: int, limits: array{versions: int, bytes: int, pinned: int}, unreadable: bool}
     */
    public function list(string $appId): array
    {
        return $this->native->withHistory($appId, function (string $root, array $project): array {
            $dir = $root . self::FOLDER;
            $index = self::reading($dir, $project);
            $current = (int) ($project['version'] ?? 0);
            $rows = [self::row(self::currentRecord($index, $project), $current)];
            $kept = array_values(array_filter($index['versions'], static fn (array $record): bool => $record['version'] < $current));
            $maps = [];
            $bytes = self::bytesOf($dir, $kept, $maps, onDisk: true);
            $held = self::held($dir);
            foreach ($kept as $position => $record) {
                // An unpinned version past the newest KEEP is one a pin was holding: it goes at the next publish.
                $rows[] = ['expires' => $position >= self::KEEP && empty($record['pinned']), 'damaged' => self::isDamaged($dir, $record, $maps, $held)] + self::row($record, $current);
            }
            return ['current' => $current, 'versions' => $rows, 'bytes' => $bytes,
                'limits' => ['versions' => self::KEEP, 'bytes' => self::maxBytes(), 'pinned' => self::MAX_PINNED],
                'unreadable' => $index['state'] === self::UNREADABLE];
        });
    }

    /**
     * One version: its record, with the paths it changed; what differs between it and the current
     * project, oldest to newest (`added` is in the current app and not in this version, `removed`
     * the other way round), each path with whether it is a text file that can be shown;
     * `databaseAhead`, the database changes the current app has applied that this version does
     * not list; and `outside`, the other sites this version's pages may reach and the ones the
     * app's may now (a going back brings the version's own back).
     *
     * @return array{current: int, version: array<string, mixed>, differs: array<string, mixed>, databaseAhead: list<string>, outside: array{version: list<string>, now: list<string>}}
     */
    public function get(string $appId, int $version): array
    {
        return $this->native->withHistory($appId, function (string $root, array $project) use ($appId, $version): array {
            $dir = $root . self::FOLDER;
            $index = self::reading($dir, $project);
            $current = (int) ($project['version'] ?? 0);
            $currentFiles = self::sourceOf($project);
            $reach = self::outsideSites($currentFiles);
            if ($version === $current) {
                $none = self::changes($currentFiles, [], $currentFiles, [], null, null);
                return ['current' => $current, 'version' => self::row(self::currentRecord($index, $project), $current, true),
                    'differs' => self::differs($none, [], []), 'databaseAhead' => [], 'outside' => ['version' => $reach, 'now' => $reach]];
            }
            $record = self::recordOf($index, $version, $current);
            $files = self::object($dir, 'texts', $record['text']);
            $map = self::mapOf($dir, $record['map'] ?? null);
            $currentMap = $this->currentMap($dir, $index, $project, $appId);
            $changes = self::changes($files, $map, $currentFiles, $currentMap,
                ['access' => $record['access'] ?? null, 'home' => $record['home'] ?? null],
                ['access' => $project['access'] ?? null, 'home' => ($project['home'] ?? false) === true], PHP_INT_MAX);
            $maps = is_string($record['map'] ?? null) ? [$record['map'] => $map] : [];
            return ['current' => $current, 'version' => ['damaged' => self::isDamaged($dir, $record, $maps, self::held($dir))] + self::row($record, $current, true),
                'differs' => self::differs($changes, $map, $currentMap), 'databaseAhead' => self::databaseAhead($files, $currentFiles),
                'outside' => ['version' => self::outsideSites($files), 'now' => $reach]];
        });
    }

    /**
     * One source file of a version, as text. The path is one the version holds: a media or built
     * file is refused (422), and any other path is not found.
     *
     * @return array{current: int, version: int, path: string, text: string}
     */
    public function file(string $appId, int $version, mixed $path): array
    {
        // Held to what a source file can be named before it is looked for, so nothing else is ever a key.
        $named = is_string($path) && strlen($path) <= 400 && !str_contains($path, '..') && preg_match(NativeAppService::SOURCE_PATH, $path) === 1;
        return $this->native->withHistory($appId, function (string $root, array $project) use ($appId, $version, $path, $named): array {
            $dir = $root . self::FOLDER;
            $index = self::reading($dir, $project);
            $current = (int) ($project['version'] ?? 0);
            if ($version === $current) {
                $files = self::sourceOf($project);
                $map = $named && isset($files[$path]) ? [] : $this->currentMap($dir, $index, $project, $appId);
            } else {
                $record = self::recordOf($index, $version, $current);
                $files = self::object($dir, 'texts', $record['text']);
                $map = $named && isset($files[$path]) ? [] : self::mapOf($dir, $record['map'] ?? null);
            }
            if ($named && isset($files[$path]) && is_string($files[$path])) return ['current' => $current, 'version' => $version, 'path' => $path, 'text' => $files[$path]];
            if (is_string($path) && isset($map[$path])) throw new RuntimeException('That is a media or built file, not text, so it is not shown here.', 422);
            throw new RuntimeException("Version {$version} has no such file.", 404);
        });
    }

    /**
     * Pin a version, so it is kept past the newest KEEP, or unpin it. The current version can be
     * pinned too: the pin stays with it when a later one replaces it.
     *
     * @return array{version: int, pinned: bool}
     */
    public function pin(string $appId, int $version, bool $pinned): array
    {
        return $this->changing($appId, function (string $dir, array $index, array $project) use ($appId, $version, $pinned): array {
            $current = (int) ($project['version'] ?? 0);
            $head = self::describesProject($index['head'], $project) ? $index['head'] : null;
            $pinnedNow = $head !== null && !empty($head['pinned']) ? 1 : 0;
            $at = null;
            foreach ($index['versions'] as $position => $record) {
                if ($record['version'] >= $current) continue;
                if (!empty($record['pinned'])) $pinnedNow++;
                if ($record['version'] === $version) $at = $position;
            }
            if ($version !== $current && $at === null) throw new RuntimeException("Version {$version} is not kept any more.", 404);
            $was = $at !== null ? !empty($index['versions'][$at]['pinned']) : ($head !== null && !empty($head['pinned']));
            if ($was === $pinned) return ['version' => $version, 'pinned' => $pinned];
            if ($pinned && $pinnedNow >= self::MAX_PINNED) throw new RuntimeException('At most ' . self::MAX_PINNED . ' versions can be pinned. Unpin one first.', 409);
            if ($at !== null) {
                $index['versions'][$at]['pinned'] = $pinned;
            } else {
                // A project the index has no record of (an app from before its history was kept, a
                // version whose record could not be written) is named now, by what it holds.
                $head ??= $this->headOf($dir, $index, $project, $appId);
                $head['pinned'] = $pinned;
                $index['head'] = $head;
            }
            self::writeIndex($dir, $index);
            return ['version' => $version, 'pinned' => $pinned];
        });
    }

    /**
     * Take one earlier version out of the history: its record goes, and its content where no
     * other kept version names it. Never the current version (it is the app, not its history),
     * and a pinned one only once it is unpinned, so a pin keeps what it says it keeps. It cannot
     * be undone. The app as it is installed is not touched.
     *
     * @return array{version: int, removed: bool}
     */
    public function remove(string $appId, int $version): array
    {
        return $this->changing($appId, function (string $dir, array $index, array $project) use ($version): array {
            $current = (int) ($project['version'] ?? 0);
            if ($version === $current) throw new RuntimeException("Version {$version} is the app as it is now, so it cannot be removed from the history.", 409);
            $at = null;
            foreach ($index['versions'] as $position => $record) {
                if ($record['version'] === $version && $version < $current) $at = $position;
            }
            if ($at === null) throw new RuntimeException("Version {$version} is not kept any more.", 404);
            if (!empty($index['versions'][$at]['pinned'])) throw new RuntimeException("Version {$version} is pinned. Unpin it first, then remove it.", 409);
            array_splice($index['versions'], $at, 1);
            self::writeIndex($dir, $index);
            // What nothing names any more goes now. No install is under way (this holds the
            // management lock, shared) and no other pin or removal (the write lock), and a record
            // that was waiting for its name has been given it, so nothing left unnamed is anyone's.
            self::sweep($dir);
            return ['version' => $version, 'removed' => true];
        });
    }

    /**
     * Go back to a version: a new version whose content is that one's, installed like any other
     * and recorded as a going back. Who may enter the app and where it opens stay as they are now:
     * they are the app's settings, not a version's content. What the app's own files say comes
     * back with them: its manifest, and so what it asks this server for and the other sites its
     * pages may reach (get() says where those differ). The database is not touched. Where the
     * version predates database changes that are applied, those stay listed in what is installed
     * (the app's backend would not start on a database that has run a change it does not list),
     * and the answer names them.
     *
     * $check is given the project about to be installed and throws to refuse it (the engine's
     * rules, as a publish from the page is held to them).
     *
     * @param (callable(array<string, mixed>): void)|null $check
     * @return array{version: int, restored: int, databaseAhead: list<string>}
     */
    public function restore(string $appId, int $version, int $expectedVersion, ?string $by = null, ?callable $check = null): array
    {
        [$project, $ahead] = $this->native->withHistory($appId, function (string $root, array $installed) use ($version, $expectedVersion): array {
            $dir = $root . self::FOLDER;
            $current = (int) ($installed['version'] ?? 0);
            if ($current !== $expectedVersion) throw new RuntimeException("The app is now at version {$current}. Reload and look again before going back.", 409);
            if ($version === $current) throw new InvalidArgumentException("Version {$version} is the current version already.");
            $record = self::recordOf(self::reading($dir, $installed), $version, $current);
            $files = self::object($dir, 'texts', $record['text']);
            $map = self::mapOf($dir, $record['map'] ?? null);
            // The project as it is installed holds its media as base64, and so does what is sent on.
            NativeAppService::raiseMemoryFor((int) ceil(((int) ($record['bytes'] ?? 0)) * 4 / 3));
            $assets = [];
            foreach ($map as $path => [$hash, $size]) $assets[$path] = base64_encode(self::blob($dir, $hash, $size));
            $currentFiles = self::sourceOf($installed);
            $ahead = self::databaseAhead($files, $currentFiles);
            if ($ahead !== []) $files = self::carrying($files, $currentFiles, $ahead);
            return [['files' => $files, 'assets' => $assets, 'access' => ($installed['access'] ?? '') === 'members' ? 'members' : 'application', 'home' => ($installed['home'] ?? false) === true], $ahead];
        });
        if ($check !== null) $check($project);
        // The version the page was looking at is checked again under the install's own lock.
        $saved = $this->native->install($appId, $project, $expectedVersion, null, ['by' => $by, 'how' => 'rollback', 'restored' => $version, 'summary' => 'Back to version ' . $version]);
        return ['version' => (int) ($saved['version'] ?? 0), 'restored' => $version, 'databaseAhead' => $ahead];
    }

    /**
     * The database changes (migrations) the current app lists that a version does not: applied to
     * the database since that version was written, and staying applied when it comes back. The
     * current app's list is what has run: an install starts the backend on its database before it
     * is kept, and no later version may drop or change one that has run.
     *
     * @param array<string, mixed> $versionFiles
     * @param array<string, mixed> $currentFiles
     * @return list<string>
     */
    public static function databaseAhead(array $versionFiles, array $currentFiles): array
    {
        return array_values(array_diff(self::migrations($currentFiles), self::migrations($versionFiles)));
    }

    /**
     * The other sites a project's pages may reach: its manifest's `site.outside` (a JavaScript
     * app's), as the policy its pages are sent under takes them, in order of name. An app with no
     * such list reaches none.
     *
     * @param array<string, mixed> $files the project's source files
     * @return list<string>
     */
    public static function outsideSites(array $files): array
    {
        $site = self::manifest($files)['site'] ?? null;
        $sites = SecurityHeadersMiddleware::siteOutside(is_array($site) && is_array($site['outside'] ?? null) ? $site['outside'] : []);
        sort($sites, SORT_STRING);
        return $sites;
    }

    /**
     * What a project asks this server for, as its manifest says it: what its backend may use
     * (`server.requires.capabilities`), FormLogic's AI and charging its visitors (`formlogicAi`,
     * `formlogicPayments`), and sign-in codes sent to a phone (`config.app.verificationProvider`).
     * A project that asks for none of them answers the same as one with no manifest. (What a
     * SoftN app's page may use is not in its files here: permission.json is not read for a hosted
     * app, and the person's files are a setting of the app, which a going back leaves alone.)
     *
     * @param array<string, mixed> $files the project's source files
     * @return array{backend: list<string>, ai: mixed, payments: mixed, phoneCodes: ?string}
     */
    public static function asksFor(array $files): array
    {
        $manifest = self::manifest($files);
        $requires = is_array($manifest['server'] ?? null) && is_array($manifest['server']['requires'] ?? null) ? $manifest['server']['requires'] : [];
        $backend = array_values(array_unique(array_filter(is_array($requires['capabilities'] ?? null) ? $requires['capabilities'] : [], 'is_string')));
        sort($backend, SORT_STRING);
        $app = is_array($manifest['config'] ?? null) && is_array($manifest['config']['app'] ?? null) ? $manifest['config']['app'] : [];
        return [
            'backend' => $backend,
            'ai' => self::ordered($manifest['formlogicAi'] ?? null),
            'payments' => self::ordered($manifest['formlogicPayments'] ?? null),
            'phoneCodes' => is_string($app['verificationProvider'] ?? null) ? $app['verificationProvider'] : null,
        ];
    }

    /**
     * Who made a version, how, and its one-line summary, as they are kept: an id in the form the
     * site's ids have, one of HOW, a single line cut to SUMMARY_LENGTH, and for a going back the
     * version gone back to. Anything else is left out.
     *
     * @param array{by?: mixed, how?: mixed, summary?: mixed, restored?: mixed}|null $origin
     * @return array{by: ?string, how: ?string, summary: ?string, restored: ?int}
     */
    public static function origin(?array $origin): array
    {
        $how = is_string($origin['how'] ?? null) && in_array($origin['how'], self::HOW, true) ? $origin['how'] : null;
        return [
            'by' => is_string($origin['by'] ?? null) && preg_match('/^[A-Za-z0-9_.:-]{1,100}$/D', $origin['by']) === 1 ? $origin['by'] : null,
            'how' => $how,
            'summary' => is_string($origin['summary'] ?? null) ? self::oneLine($origin['summary']) : null,
            'restored' => $how === 'rollback' && is_int($origin['restored'] ?? null) && $origin['restored'] > 0 ? $origin['restored'] : null,
        ];
    }

    /** A summary as it is kept: one line, its spaces single, cut to SUMMARY_LENGTH; null when nothing is left. */
    public static function oneLine(string $text): ?string
    {
        // Text that is not UTF-8 cannot be written to the index: it is no summary.
        $line = preg_replace('/[\p{C}\s]+/u', ' ', $text);
        $line = is_string($line) ? mb_substr(trim($line), 0, self::SUMMARY_LENGTH) : '';
        return $line === '' ? null : $line;
    }

    // ── Records ──────────────────────────────────────────────────────────────────────────────

    /**
     * The index as it stands: the versions newest first, the head, and which of four things was
     * found (`state`). They are told apart, as NativeAppService's journal reader tells them:
     *  - NONE: nothing is there. No history yet.
     *  - READ: an index.
     *  - BUSY: something is there and its bytes could not be read just now (another program is
     *    holding the file, a passing error, or it is not a plain file). That says nothing about
     *    what it holds: it is never replaced, and nothing is removed against it.
     *  - UNREADABLE: its bytes were read, all of them, and are not an index. The next install
     *    sets it aside and starts the history again.
     * For the last two the versions are empty, which a caller must never take for "no history".
     *
     * @return array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string}
     */
    private static function readIndex(string $dir, ?string $file = null): array
    {
        $path = $file ?? $dir . '/index.json';
        $empty = ['head' => null, 'versions' => []];
        if (!self::present($path)) return $empty + ['state' => self::NONE];
        $raw = self::readWhole($path);
        if ($raw === null) {
            // Gone since the check: nothing is there. Still there: busy, whatever it holds.
            if (!self::present($path)) return $empty + ['state' => self::NONE];
            if ($file === null) error_log('Native app history: index.json is there and could not be read just now');
            return $empty + ['state' => self::BUSY];
        }
        $index = json_decode($raw, true);
        if (!is_array($index) || ($index['format'] ?? null) !== self::FORMAT || !is_array($index['versions'] ?? null)) {
            if ($file === null) error_log('Native app history: index.json was read and is not an index');
            return $empty + ['state' => self::UNREADABLE];
        }
        $versions = [];
        foreach ($index['versions'] as $record) {
            if (is_array($record) && is_int($record['version'] ?? null) && $record['version'] > 0 && self::isKey($record['text'] ?? null) && (($record['map'] ?? null) === null || self::isKey($record['map']))) $versions[] = $record;
        }
        usort($versions, static fn (array $a, array $b): int => $b['version'] <=> $a['version']);
        $head = $index['head'] ?? null;
        $head = is_array($head) && is_int($head['version'] ?? null) && self::isKey($head['text'] ?? null) && (($head['map'] ?? null) === null || self::isKey($head['map'])) ? $head : null;
        return ['head' => $head, 'versions' => $versions, 'state' => self::READ];
    }

    /**
     * The index for a read (the owner's routes, under the shared lock). One that is there and
     * cannot be read just now is said as that (409), never shown as an empty history. A record an
     * install could not give its name is read in the index's place where it is the installed
     * project's, as far as its source says: nothing is written here, and the next install, pin or
     * removal gives it its name.
     *
     * @param array<string, mixed> $project
     * @return array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string}
     */
    private static function reading(string $dir, array $project): array
    {
        $index = self::readIndex($dir);
        if ($index['state'] === self::BUSY) throw new RuntimeException(self::BUSY_NOW, 409);
        if (self::describesProject($index['head'], $project)) return $index;
        foreach (glob($dir . '/index.pending-*.json') ?: [] as $left) {
            $candidate = self::readIndex($dir, $left);
            if (self::describesProject($candidate['head'], $project)) return $candidate;
        }
        // A pin or a removal may have given a waiting record its name between the two looks above
        // (they hold this same lock, shared, as a read does): the index is read once more, as it
        // is now, before it is taken to be behind.
        if ($index['state'] !== self::UNREADABLE && self::present($dir . '/index.json')) {
            $again = self::readIndex($dir);
            if (self::describesProject($again['head'], $project)) return $again;
        }
        return $index;
    }

    /**
     * A record an earlier install prepared and could not give its name (commit() failed after the
     * install itself succeeded), where it is of the very project now being replaced: taken as the
     * index, so that version's maker and the versions before it are not lost. Any other pending
     * record is of an install that failed, and is left for the sweep.
     *
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @return array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string}
     */
    private static function adopting(string $dir, array $index, string $operation, int $version, string $text, ?string $map): array
    {
        if (self::describes($index['head'], $version, $text, $map)) return $index;
        foreach (glob($dir . '/index.pending-*.json') ?: [] as $left) {
            if (basename($left) === 'index.pending-' . $operation . '.json') continue;
            $candidate = self::readIndex($dir, $left);
            if (self::describes($candidate['head'], $version, $text, $map)) return $candidate;
        }
        return $index;
    }

    /**
     * Give a prepared record the index's name, in one rename. An index that is there and did not
     * read as one is first set aside under another name, never written over; one that cannot be
     * read just now is left alone, and the record waits (it is taken up later, as after a rename
     * that failed). Answers whether what the index no longer names may now be removed: not when
     * an index was set aside, whose content nothing can name any more. Throws when the record
     * could not be given its name.
     */
    private static function adopt(string $dir, string $pending): bool
    {
        $standing = self::readIndex($dir);
        if ($standing['state'] === self::BUSY) throw new RuntimeException('the index is there and could not be read just now, so its record waits');
        $aside = $standing['state'] === self::UNREADABLE;
        if ($aside) {
            if (!self::rename($dir . '/index.json', $dir . '/damaged-index-' . gmdate('Ymd\THis\Z') . '-' . bin2hex(random_bytes(3)) . '.json')) throw new RuntimeException('an index that is not one could not be set aside');
            error_log('Native app history: an index that was not one was set aside, and the history starts again');
        }
        if (!self::rename($pending, $dir . '/index.json')) throw new RuntimeException('its record could not be given its name');
        return !$aside;
    }

    /**
     * For a change to the index outside an install (a pin, a removal; the caller holds the write
     * lock under the shared management lock): a record an install prepared and could not give its
     * name is given it now, where it is the installed project's, so nothing is written into an
     * index that is a version behind (the next install would take the waiting record over it,
     * and the change with the version it was made to would be lost). Decided as an install
     * decides it, by everything the project holds: its number, its source and its media.
     *
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @param array<string, mixed> $project
     * @return array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string}
     */
    private function settled(string $dir, array $index, array $project, string $appId): array
    {
        if (self::describesProject($index['head'], $project)) return $index;
        $waiting = glob($dir . '/index.pending-*.json') ?: [];
        if ($waiting === []) return $index;
        $whole = $this->native->get($appId) ?? [];
        $version = (int) ($whole['version'] ?? 0);
        $assets = is_array($whole['assets'] ?? null) ? $whole['assets'] : [];
        $text = hash('sha256', self::json(self::sourceOf($whole)));
        $print = self::printOf($assets);
        $map = false;
        foreach ($waiting as $left) {
            $candidate = self::readIndex($dir, $left);
            $head = $candidate['head'];
            if ($head === null || $head['version'] !== $version || $head['text'] !== $text) continue;
            if (is_string($head['print'] ?? null)) {
                if ($head['print'] !== $print) continue;
            } else {
                // A record from before prints were kept: by the map of every file, hashed.
                if ($map === false) { $entries = self::mapOfAssets($assets); $map = $entries === [] ? null : hash('sha256', self::json($entries)); }
                if (($head['map'] ?? null) !== $map) continue;
            }
            try { self::adopt($dir, $left); }
            catch (RuntimeException) { throw new RuntimeException(self::BUSY_NOW, 409); }
            return $candidate;
        }
        return $index;
    }

    /**
     * Run $change on the index, for a change made outside an install: under the shared management
     * lock (no install is under way) and the history's own write lock (no other change is), with
     * the index read and any record that was waiting for its name given it first. An index that
     * cannot be read just now, or that is not one, is not changed: the answer says so.
     *
     * @template T
     * @param callable(string, array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string}, array<string, mixed>): T $change
     * @return T
     */
    private function changing(string $appId, callable $change): mixed
    {
        return $this->native->withHistory($appId, function (string $root, array $project) use ($appId, $change): mixed {
            $dir = $root . self::FOLDER;
            try { self::directory($dir); $lock = @fopen($dir . '/write.lock', 'c'); }
            catch (RuntimeException) { $lock = false; }
            if ($lock === false) throw new RuntimeException('The app\'s history cannot be changed just now: its folder on the server cannot be written.', 409);
            // Installs are shut out by the management lock, held shared here; this one is for two changes at once.
            if (!flock($lock, LOCK_EX)) { fclose($lock); throw new RuntimeException('The app\'s history is busy. Try again shortly.', 409); }
            try {
                $index = self::readIndex($dir);
                if ($index['state'] === self::BUSY) throw new RuntimeException(self::BUSY_NOW, 409);
                $index = $this->settled($dir, $index, $project, $appId);
                if ($index['state'] === self::UNREADABLE) throw new RuntimeException('The app\'s history could not be read, so nothing in it can be changed. The next publish starts it again.', 409);
                return $change($dir, $index, $project);
            } finally { flock($lock, LOCK_UN); fclose($lock); }
        });
    }

    /**
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     */
    private static function writeIndex(string $dir, array $index): void
    {
        self::write($dir . '/index.json', json_encode(['format' => self::FORMAT, 'head' => $index['head'], 'versions' => $index['versions']], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    /** Whether a head is the record of the project with this version number and this content. */
    private static function describes(?array $head, int $version, string $text, ?string $map): bool
    {
        return $head !== null && ($head['version'] ?? null) === $version && ($head['text'] ?? null) === $text && ($head['map'] ?? null) === $map;
    }

    /**
     * Whether a head is the record of the installed project, as far as its source says (the
     * project is read here without its media): its number and its source files.
     *
     * @param array<string, mixed> $project
     */
    private static function describesProject(?array $head, array $project): bool
    {
        return $head !== null && ($head['version'] ?? null) === (int) ($project['version'] ?? 0) && ($head['text'] ?? null) === hash('sha256', self::json(self::sourceOf($project)));
    }

    /**
     * The versions before $version that were replaced without being kept, as far as an index
     * whose head is not that version's record can say. Its head is the last version it knew as
     * the installed one, whose content was never laid by: an install whose history could not be
     * prepared went ahead and left the index where it was. So from that head to the version
     * before $version, none is kept. Null where the index says no such thing (it is empty, or
     * its head is of this number or a later one).
     *
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @return array{from: int, to: int}|null
     */
    private static function gapBefore(array $index, int $version): ?array
    {
        $head = $index['head'];
        $from = $head !== null ? (int) $head['version'] : (isset($index['versions'][0]) ? (int) $index['versions'][0]['version'] + 1 : null);
        return $from !== null && $from >= 1 && $from < $version ? ['from' => $from, 'to' => $version - 1] : null;
    }

    /**
     * A record's note of the versions just before it that were not kept, as it is told on.
     *
     * @param array<string, mixed> $record
     * @return array{from: int, to: int}|null
     */
    private static function gapOf(array $record): ?array
    {
        $gap = $record['gap'] ?? null;
        return is_array($gap) && is_int($gap['from'] ?? null) && is_int($gap['to'] ?? null) && $gap['from'] >= 1 && $gap['from'] <= $gap['to'] ? ['from' => $gap['from'], 'to' => $gap['to']] : null;
    }

    /**
     * What is known of the current version: its head where that is its record, and otherwise
     * (an app from before its history was kept, one restored from a backup, or a version whose
     * record could not be written) its number, when it was made, how many files it has, and the
     * versions before it that the index shows were not kept.
     *
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @param array<string, mixed> $project
     * @return array<string, mixed>
     */
    private static function currentRecord(array $index, array $project): array
    {
        $files = self::sourceOf($project);
        $current = (int) ($project['version'] ?? 0);
        $known = self::describesProject($index['head'], $project) ? $index['head'] : ['gap' => self::gapBefore($index, $current)];
        return ['version' => $current, 'madeAt' => is_string($project['updatedAt'] ?? null) ? $project['updatedAt'] : null, 'files' => count($files)]
            + $known + ['access' => ($project['access'] ?? '') === 'members' ? 'members' : 'application', 'home' => ($project['home'] ?? false) === true];
    }

    /**
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @return array<string, mixed>
     */
    private static function recordOf(array $index, int $version, int $current): array
    {
        foreach ($index['versions'] as $record) {
            if ($record['version'] === $version && $version < $current) return $record;
        }
        throw new RuntimeException("Version {$version} is not kept any more.", 404);
    }

    /**
     * A version as the owner's page is told of it. Without `$paths`, what it changed is counts
     * and flags alone: a list of thirty versions does not carry thirty lists of paths.
     *
     * @param array<string, mixed> $record
     * @return array<string, mixed>
     */
    private static function row(array $record, int $current, bool $paths = false): array
    {
        $changes = is_array($record['changes'] ?? null) ? $record['changes'] : null;
        if ($changes !== null && !$paths) unset($changes['paths']);
        // A record written before these two were looked for says nothing of them.
        if ($changes !== null) $changes += ['outside' => false, 'asks' => false];
        return [
            'version' => (int) $record['version'], 'current' => (int) $record['version'] === $current,
            'madeAt' => is_string($record['madeAt'] ?? null) ? $record['madeAt'] : null,
            'by' => is_string($record['by'] ?? null) ? $record['by'] : null,
            'how' => is_string($record['how'] ?? null) ? $record['how'] : null,
            'restored' => is_int($record['restored'] ?? null) ? $record['restored'] : null,
            'summary' => is_string($record['summary'] ?? null) ? $record['summary'] : null,
            'pinned' => ($record['pinned'] ?? false) === true, 'expires' => false, 'damaged' => false,
            // The versions just before this one that were replaced without being kept, and
            // whether the history starts again at this one (what was kept before could not be read).
            'gap' => self::gapOf($record), 'startedAgain' => ($record['startedAgain'] ?? false) === true,
            'changes' => $changes,
            'files' => (int) ($record['files'] ?? 0), 'assets' => is_int($record['assets'] ?? null) ? $record['assets'] : null,
            'bytes' => is_int($record['bytes'] ?? null) ? $record['bytes'] : null,
            'access' => is_string($record['access'] ?? null) ? $record['access'] : null, 'home' => is_bool($record['home'] ?? null) ? $record['home'] : null,
        ];
    }

    /**
     * The versions to keep of those given (newest first): the newest KEEP and the pinned, then,
     * while the history is over its size limit, without the oldest unpinned and then the oldest
     * pinned. The newest KEEP_ALWAYS stay whatever they take.
     *
     * @param list<array<string, mixed>> $versions
     * @return list<array<string, mixed>>
     */
    private static function pruned(string $dir, array $versions): array
    {
        $kept = [];
        foreach ($versions as $position => $record) {
            if ($position < self::KEEP || !empty($record['pinned'])) $kept[] = $record;
        }
        $limit = self::maxBytes();
        $maps = [];
        while (count($kept) > self::KEEP_ALWAYS && self::bytesOf($dir, $kept, $maps) > $limit) {
            $drop = count($kept) - 1;
            for ($i = count($kept) - 1; $i >= self::KEEP_ALWAYS; $i--) {
                if (empty($kept[$i]['pinned'])) { $drop = $i; break; }
            }
            array_splice($kept, $drop, 1);
        }
        return $kept;
    }

    /**
     * What a set of versions takes on disk, each piece of content counted once.
     *
     * A map that cannot be read names media this cannot see. For the size limit (pruned) it counts
     * for nothing: while its version is kept nothing is removed from the media (sweep), so dropping
     * other versions would free nothing, and the list says its version is damaged (isDamaged) for
     * its owner to remove. For what the owner is shown ($onDisk), the media are every kept file
     * there, as none of them goes until then.
     *
     * @param list<array<string, mixed>> $versions
     * @param array<string, array<string, array{0: string, 1: int}>|null> $maps maps read so far, by key; null for one that cannot be read
     */
    private static function bytesOf(string $dir, array $versions, array &$maps, bool $onDisk = false): int
    {
        $texts = $mapFiles = $blobs = [];
        $unread = false;
        foreach ($versions as $record) {
            $texts[$record['text']] = (int) ($record['textBytes'] ?? 0);
            $key = $record['map'] ?? null;
            if (!is_string($key)) continue;
            $mapFiles[$key] = (int) ($record['mapBytes'] ?? 0);
            $map = self::mapRead($dir, $key, $maps);
            if ($map === null) { $unread = true; continue; }
            foreach ($map as [$hash, $size]) $blobs[$hash] = $size;
        }
        if ($unread && $onDisk && is_dir($dir . '/blobs')) {
            foreach (scandir($dir . '/blobs') ?: [] as $name) {
                if ($name === '.' || $name === '..' || isset($blobs[$name])) continue;
                $size = @filesize($dir . '/blobs/' . $name);
                if (is_int($size)) $blobs[$name] = $size;
            }
        }
        return array_sum($texts) + array_sum($mapFiles) + array_sum($blobs);
    }

    /**
     * A map by its key, read once: null for one that cannot be read.
     *
     * @param array<string, array<string, array{0: string, 1: int}>|null> $maps
     * @return array<string, array{0: string, 1: int}>|null
     */
    private static function mapRead(string $dir, string $key, array &$maps): ?array
    {
        if (!array_key_exists($key, $maps)) {
            try { $maps[$key] = self::mapOf($dir, $key); } catch (\Throwable) { $maps[$key] = null; }
        }
        return $maps[$key];
    }

    /**
     * The names of the kept files that are there, as keys.
     *
     * @return array<int|string, int>
     */
    private static function held(string $dir): array
    {
        return is_dir($dir . '/blobs') ? array_flip(scandir($dir . '/blobs') ?: []) : [];
    }

    /**
     * Whether a kept version cannot be gone back to, as far as a look at the folder says: its
     * source is not there, its map cannot be read, or a file its map names is gone. (Going back
     * checks every byte against its name; this is what the list can say without reading them.)
     *
     * @param array<string, mixed> $record
     * @param array<string, array<string, array{0: string, 1: int}>|null> $maps
     * @param array<int|string, int> $held
     */
    private static function isDamaged(string $dir, array $record, array &$maps, array $held): bool
    {
        if (!is_file($dir . '/texts/' . $record['text'] . '.gz') && !is_file($dir . '/texts/' . $record['text'] . '.json')) return true;
        $key = $record['map'] ?? null;
        if (!is_string($key)) return false;
        $map = self::mapRead($dir, $key, $maps);
        if ($map === null) return true;
        foreach ($map as [$hash]) {
            if (!isset($held[$hash])) return true;
        }
        return false;
    }

    /**
     * Remove what the index does not name: content of versions that fell out or were taken out,
     * content laid by for an install that failed, pending records and files a stopped process
     * left half-written. Only against an index that was read, or none at all: one that cannot be
     * read just now, or that is not an index, names content this cannot see, and nothing goes.
     * The caller holds the management lock, exclusively (an install) or shared with the history's
     * write lock (a removal), so nothing here is anyone's work in progress.
     *
     * $installed: this is the sweep of an install that has just given its record its name. Where
     * that record starts the history again (the index before it was not one, and was set aside),
     * nothing is removed at that install, also when it is a later process that finishes it.
     */
    private static function sweep(string $dir, bool $installed = false): void
    {
        $index = self::readIndex($dir);
        if ($index['state'] !== self::READ && $index['state'] !== self::NONE) return;
        if ($installed && ($index['versions'][0]['startedAgain'] ?? false) === true) return;
        $texts = $maps = $blobs = $read = [];
        $readable = true;
        foreach ($index['versions'] as $record) {
            $texts[$record['text']] = true;
            if (!is_string($record['map'] ?? null)) continue;
            $maps[$record['map']] = true;
            $map = self::mapRead($dir, $record['map'], $read);
            if ($map === null) { $readable = false; continue; }
            foreach ($map as [$hash]) $blobs[$hash] = true;
        }
        if (is_string($index['head']['map'] ?? null)) $maps[$index['head']['map']] = true;
        $clear = static function (string $folder, array $named) use ($dir): void {
            foreach (scandir($dir . $folder) ?: [] as $name) {
                if ($name === '.' || $name === '..') continue;
                $key = (string) strtok($name, '.');
                if (str_contains($name, '.tmp-') || !isset($named[$key])) @unlink($dir . $folder . '/' . $name);
            }
        };
        if (is_dir($dir . '/texts')) $clear('/texts', $texts);
        if (is_dir($dir . '/maps')) $clear('/maps', $maps);
        // A map that cannot be read names files this cannot see: none is removed until it can be,
        // or until its version is taken out of the history (remove()).
        if ($readable && is_dir($dir . '/blobs')) $clear('/blobs', $blobs);
        // Pending records and half-written indexes. An index set aside (damaged-index-…) is not one of them.
        foreach (glob($dir . '/index.*') ?: [] as $left) {
            if (basename($left) !== 'index.json') @unlink($left);
        }
    }

    // ── What a version holds, and what changed ───────────────────────────────────────────────

    /**
     * The installed project's source files, as text.
     *
     * @param array<string, mixed> $project
     * @return array<string, string>
     */
    private static function sourceOf(array $project): array
    {
        return array_filter(is_array($project['files'] ?? null) ? $project['files'] : [], 'is_string');
    }

    /**
     * The current project's media and built files by name. From its head where that is its
     * record; otherwise from the project itself, every file of it hashed.
     *
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @param array<string, mixed> $project
     * @return array<string, array{0: string, 1: int}>
     */
    private function currentMap(string $dir, array $index, array $project, string $appId): array
    {
        if (self::describesProject($index['head'], $project)) {
            try { return self::mapOf($dir, $index['head']['map'] ?? null); } catch (\Throwable) { /* read from the project below */ }
        }
        $whole = $this->native->get($appId);
        return self::mapOfAssets(is_array($whole['assets'] ?? null) ? $whole['assets'] : []);
    }

    /**
     * A head for the installed project where it has none of its own (pin()): its number and what
     * it holds, with no one known to have made it, and the versions before it that the index
     * shows were not kept. Its map is laid by, since a head names one.
     *
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @param array<string, mixed> $project
     * @return array<string, mixed>
     */
    private function headOf(string $dir, array $index, array $project, string $appId): array
    {
        self::directory($dir . '/maps');
        $whole = $this->native->get($appId);
        $assets = is_array($whole['assets'] ?? null) ? $whole['assets'] : [];
        $map = self::mapOfAssets($assets);
        $files = self::sourceOf($project);
        $gap = self::gapBefore($index, (int) ($project['version'] ?? 0));
        return ['version' => (int) ($project['version'] ?? 0)] + self::origin(null) + [
            'changes' => null, 'pinned' => false,
            'text' => hash('sha256', self::json($files)),
            'map' => $map === [] ? null : self::putObject($dir, 'maps', self::json($map))[0],
            'print' => self::printOf($assets),
            'files' => count($files), 'assets' => count($map),
            'bytes' => array_sum(array_map('strlen', $files)) + array_sum(array_column($map, 1)),
        ] + ($gap !== null ? ['gap' => $gap] : []);
    }

    /**
     * @param array<string, mixed> $assets path to base64
     * @return array<string, array{0: string, 1: int}>
     */
    private static function mapOfAssets(array $assets): array
    {
        $map = [];
        foreach ($assets as $path => $encoded) {
            $bytes = is_string($encoded) ? base64_decode($encoded, true) : false;
            if ($bytes !== false) $map[(string) $path] = [hash('sha256', $bytes), strlen($bytes)];
        }
        return $map;
    }

    /**
     * A quick hash of a project's media as the project carries it: every path with its base64
     * text, in order of path. An install writes it into the head for the project it installs
     * (print), and the next one works it out again from the project it finds installed. Where
     * the two are the same, with the version number and the source, that head is this project's
     * record and its map names this project's files, so they need not be hashed again to find
     * out (knownMap()). It is not a name anything is kept under: those are SHA-256 of the bytes.
     *
     * @param array<string, mixed> $assets path to base64
     */
    private static function printOf(array $assets): string
    {
        $paths = [];
        foreach ($assets as $path => $encoded) {
            if (is_string($encoded)) $paths[] = (string) $path;
        }
        sort($paths, SORT_STRING);
        $print = hash_init('xxh128');
        foreach ($paths as $path) {
            hash_update($print, strlen($path) . ':' . $path . strlen($assets[$path]) . ':');
            hash_update($print, $assets[$path]);
        }
        return hash_final($print);
    }

    /**
     * The map of the installed project's media, where a record known to be this very project's
     * names one: the index's head, or the head of a record waiting to be given its name. Known
     * by the project's number, its source, and the print of its media (printOf()), which that
     * record carries from the install that wrote it. Null where no record says so (one written
     * before prints were kept, a project put there another way) or its map cannot be read:
     * every file is then hashed, as it always was.
     *
     * @param array{head: array<string, mixed>|null, versions: list<array<string, mixed>>, state: string} $index
     * @return array<string, array{0: string, 1: int}>|null
     */
    private static function knownMap(string $dir, array $index, string $operation, int $version, string $text, string $print): ?array
    {
        $is = static fn (?array $head): bool => $head !== null && ($head['version'] ?? null) === $version && ($head['text'] ?? null) === $text && ($head['print'] ?? null) === $print;
        $head = $is($index['head']) ? $index['head'] : null;
        if ($head === null) {
            foreach (glob($dir . '/index.pending-*.json') ?: [] as $left) {
                if (basename($left) === 'index.pending-' . $operation . '.json') continue;
                $candidate = self::readIndex($dir, $left)['head'];
                if ($is($candidate)) { $head = $candidate; break; }
            }
        }
        if ($head === null) return null;
        try { return self::mapOf($dir, $head['map'] ?? null); } catch (\Throwable) { return null; }
    }

    /**
     * Lay by a project's media and built files: each one's bytes under the name of their SHA-256.
     * Answers the project's map.
     *
     * A file is written where none of that name is there, and written again where one is there
     * and is not the size of these bytes (a file cut short is replaced, not kept).
     *
     * $known is what a record known to be this project's says each path holds (knownMap()). A
     * path it names, whose base64 text is of that size and whose bytes are there under that name
     * at that size, takes that entry without being decoded. Every other path is decoded and
     * hashed, so a doubt about one file costs that file's hash and never its safety.
     *
     * @param array<string, mixed> $assets path to base64
     * @param array<string, array{0: string, 1: int}> $known
     * @return array<string, array{0: string, 1: int}>
     */
    private static function keepAssets(string $dir, array $assets, array $known = []): array
    {
        $map = [];
        foreach ($assets as $path => $encoded) {
            $path = (string) $path;
            $entry = $known[$path] ?? null;
            if ($entry !== null && is_string($encoded) && self::decodedLength($encoded) === $entry[1] && self::holds($dir . '/blobs/' . $entry[0], $entry[1])) {
                $map[$path] = $entry;
                continue;
            }
            $bytes = is_string($encoded) ? base64_decode($encoded, true) : false;
            if ($bytes === false) throw new RuntimeException('The version being replaced could not be kept: one of its files could not be read.');
            $hash = hash('sha256', $bytes);
            if (!self::holds($dir . '/blobs/' . $hash, strlen($bytes))) self::write($dir . '/blobs/' . $hash, $bytes);
            $map[$path] = [$hash, strlen($bytes)];
        }
        return $map;
    }

    /**
     * The new project's media and built files by name. A file whose base64 text is the replaced
     * project's at the same path is the same bytes, and takes that file's entry; every other is
     * hashed.
     *
     * @param array<string, string> $decoded the new project's files, decoded
     * @param array<string, mixed> $newAssets the same files as base64, as the project carries them
     * @param array<string, mixed> $oldAssets the replaced project's, as base64
     * @param array<string, array{0: string, 1: int}> $oldMap the replaced project's map
     * @param bool $unchanged set to whether every file of the new project is one of these, and the replaced project had no other: its media is then the same, path for path and text for text
     * @return array<string, array{0: string, 1: int}>
     */
    private static function newMap(array $decoded, array $newAssets, array $oldAssets, array $oldMap, bool &$unchanged = false): array
    {
        $map = [];
        $taken = 0;
        foreach ($decoded as $path => $bytes) {
            if (!is_string($bytes)) continue;
            $path = (string) $path;
            $entry = $oldMap[$path] ?? null;
            $same = $entry !== null && $entry[1] === strlen($bytes) && is_string($newAssets[$path] ?? null) && is_string($oldAssets[$path] ?? null) && $newAssets[$path] === $oldAssets[$path];
            if ($same) $taken++;
            $map[$path] = $same ? $entry : [hash('sha256', $bytes), strlen($bytes)];
        }
        $unchanged = $taken === count($map) && $taken === count($newAssets) && $taken === count(array_filter($oldAssets, 'is_string'));
        return $map;
    }

    /** How many bytes a base64 text decodes to, by its length; null where that cannot be told from it (it is then decoded). */
    private static function decodedLength(string $encoded): ?int
    {
        $length = strlen($encoded);
        if ($length === 0) return 0;
        if ($length % 4 !== 0) return null;
        return intdiv($length, 4) * 3 - ($encoded[$length - 1] === '=' ? ($encoded[$length - 2] === '=' ? 2 : 1) : 0);
    }

    /**
     * Whether a plain file of exactly this size is at this path, asked of the disk each time
     * (PHP's note of the last file it looked at is dropped first). The paths PHP has resolved
     * are left alone: looking each one up again cost as much as the question, for hundreds of
     * files at every install, and the answer never comes from them.
     */
    private static function holds(string $file, int $size): bool
    {
        clearstatcache();
        return is_file($file) && filesize($file) === $size;
    }

    /**
     * How many bytes the history keeps under one media or built file's SHA-256, or null where no kept
     * version has them (never kept, or gone with the versions that named them). For a page that still
     * names a file an earlier version had (NativeAppService::withKeptMedia, ownerMediaFile): a draft
     * made before the app was changed elsewhere. The caller holds the installation's management lock.
     */
    public static function keptFileSize(string $root, string $hash): ?int
    {
        if (!self::isKey($hash)) return null;
        $file = $root . self::FOLDER . '/blobs/' . $hash;
        clearstatcache(true, $file);
        if (!is_file($file) || is_link($file)) return null;
        $size = @filesize($file);
        return is_int($size) && $size <= NativeAppService::MAX_MEDIA_FILE_BYTES ? $size : null;
    }

    /** Those bytes (keptFileSize), checked against the SHA-256 they are kept under; null where they are not there whole. */
    public static function keptFile(string $root, string $hash): ?string
    {
        $size = self::keptFileSize($root, $hash);
        if ($size === null) return null;
        $bytes = @file_get_contents($root . self::FOLDER . '/blobs/' . $hash);
        return is_string($bytes) && strlen($bytes) === $size && hash_equals($hash, hash('sha256', $bytes)) ? $bytes : null;
    }

    /** One kept file's bytes, checked against the name they are kept under. */
    private static function blob(string $dir, string $hash, int $size): string
    {
        $bytes = self::isKey($hash) ? @file_get_contents($dir . '/blobs/' . $hash) : false;
        if (!is_string($bytes) || strlen($bytes) !== $size || hash('sha256', $bytes) !== $hash) throw new RuntimeException(self::DAMAGED, 409);
        return $bytes;
    }

    /**
     * @return array<string, array{0: string, 1: int}>
     */
    private static function mapOf(string $dir, mixed $key): array
    {
        if ($key === null) return [];
        $map = [];
        foreach (self::object($dir, 'maps', $key) as $path => $entry) {
            if (!is_array($entry) || !self::isKey($entry[0] ?? null) || !is_int($entry[1] ?? null)) throw new RuntimeException(self::DAMAGED, 409);
            $map[(string) $path] = [$entry[0], $entry[1]];
        }
        return $map;
    }

    /** JSON as content is named and kept: an empty set of files is an object, as a full one is. */
    private static function json(array $value): string
    {
        return json_encode($value === [] ? new \stdClass() : $value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * Keep a piece of JSON under the SHA-256 of its text, gzipped where PHP can (zlib). Answers
     * its name and what it takes on disk.
     *
     * A file of that name already there is kept only where it reads back as this very text: one
     * cut short or damaged is written again (under another name, then renamed), since the text
     * that belongs there is in hand.
     *
     * @return array{0: string, 1: int}
     */
    private static function putObject(string $dir, string $kind, string $json): array
    {
        $key = hash('sha256', $json);
        foreach (['.gz', '.json'] as $ending) {
            $file = $dir . '/' . $kind . '/' . $key . $ending;
            clearstatcache(true, $file);
            if (is_file($file) && self::unpacked($file, $ending) === $json) return [$key, (int) filesize($file)];
        }
        $packed = function_exists('gzencode') ? gzencode($json, 6) : false;
        $bytes = is_string($packed) ? $packed : $json;
        self::write($dir . '/' . $kind . '/' . $key . (is_string($packed) ? '.gz' : '.json'), $bytes);
        return [$key, strlen($bytes)];
    }

    /** A kept piece of JSON's text as its file holds it (`.gz` unpacked), or null where it cannot be read. */
    private static function unpacked(string $file, string $ending): ?string
    {
        if (!is_file($file)) return null;
        $raw = @file_get_contents($file);
        if (!is_string($raw)) return null;
        if ($ending !== '.gz') return $raw;
        $json = function_exists('gzdecode') ? @gzdecode($raw) : false;
        return is_string($json) ? $json : null;
    }

    /**
     * A kept piece of JSON, read back and checked against its name.
     *
     * @return array<string, mixed>
     */
    private static function object(string $dir, string $kind, mixed $key): array
    {
        $json = null;
        if (self::isKey($key)) {
            foreach (['.gz', '.json'] as $ending) {
                $read = self::unpacked($dir . '/' . $kind . '/' . $key . $ending, $ending);
                if ($read !== null && hash('sha256', $read) === $key) { $json = $read; break; }
            }
        }
        if ($json === null) throw new RuntimeException(self::DAMAGED, 409);
        $value = json_decode($json, true, 8);
        if (!is_array($value)) throw new RuntimeException(self::DAMAGED, 409);
        return $value;
    }

    /**
     * What changed from one project to the next: how many paths were added, removed and changed
     * (source, media and built files together), the paths themselves (the first $listed of each),
     * and whether the backend's routes, the database's changes, the other sites its pages may
     * reach (`outside`), what it asks this server for (`asks`), who may enter and where the app
     * opens moved. `first` marks a version that replaced nothing.
     *
     * @param array<string, mixed> $oldFiles
     * @param array<string, array{0: string, 1: int}> $oldMap
     * @param array<string, mixed> $newFiles
     * @param array<string, array{0: string, 1: int}> $newMap
     * @param array{access: mixed, home: mixed}|null $oldSettings
     * @param array{access: mixed, home: mixed}|null $newSettings
     * @return array{added: int, removed: int, changed: int, routes: bool, database: bool, outside: bool, asks: bool, access: bool, home: bool, first: bool, paths: array{added: list<string>, removed: list<string>, changed: list<string>}}
     */
    private static function changes(array $oldFiles, array $oldMap, array $newFiles, array $newMap, ?array $oldSettings, ?array $newSettings, int $listed = self::PATHS_LISTED): array
    {
        $prints = static function (array $files, array $map): array {
            $prints = [];
            foreach ($files as $path => $text) $prints[(string) $path] = 'text:' . hash('xxh128', (string) $text);
            foreach ($map as $path => $entry) $prints[(string) $path] = ($prints[(string) $path] ?? '') . 'file:' . $entry[0];
            return $prints;
        };
        $old = $prints($oldFiles, $oldMap);
        $new = $prints($newFiles, $newMap);
        $added = array_map('strval', array_keys(array_diff_key($new, $old)));
        $removed = array_map('strval', array_keys(array_diff_key($old, $new)));
        $changed = [];
        foreach ($new as $path => $print) {
            if (isset($old[$path]) && $old[$path] !== $print) $changed[] = (string) $path;
        }
        sort($added, SORT_STRING); sort($removed, SORT_STRING); sort($changed, SORT_STRING);
        $moved = array_merge($added, $removed, $changed);
        // The manifest is one file among the changed ones: what it lets the app reach and ask for
        // is said apart, so a change to either is never only "1 file changed".
        $sameManifest = ($oldFiles['manifest.json'] ?? null) === ($newFiles['manifest.json'] ?? null);
        return [
            'added' => count($added), 'removed' => count($removed), 'changed' => count($changed),
            'routes' => json_encode(self::server($oldFiles)['routes'] ?? null) !== json_encode(self::server($newFiles)['routes'] ?? null),
            'database' => self::migrations($oldFiles) !== self::migrations($newFiles) || preg_grep('~^server/migrations/~', $moved) !== [],
            'outside' => !$sameManifest && self::outsideSites($oldFiles) !== self::outsideSites($newFiles),
            'asks' => !$sameManifest && json_encode(self::asksFor($oldFiles)) !== json_encode(self::asksFor($newFiles)),
            'access' => $oldSettings !== null && $newSettings !== null && $oldSettings['access'] !== $newSettings['access'],
            'home' => $oldSettings !== null && $newSettings !== null && $oldSettings['home'] !== $newSettings['home'],
            'first' => $oldSettings === null && $newSettings === null && $oldFiles === [] && $oldMap === [],
            'paths' => ['added' => array_slice($added, 0, $listed), 'removed' => array_slice($removed, 0, $listed), 'changed' => array_slice($changed, 0, $listed)],
        ];
    }

    /**
     * A comparison as the page shows it, file by file: each path with whether both projects hold
     * it as text (a source file), which is what can be shown side by side.
     *
     * @param array{added: int, removed: int, changed: int, routes: bool, database: bool, outside: bool, asks: bool, access: bool, home: bool, first: bool, paths: array{added: list<string>, removed: list<string>, changed: list<string>}} $changes
     * @param array<string, array{0: string, 1: int}> $versionMap
     * @param array<string, array{0: string, 1: int}> $currentMap
     * @return array<string, mixed>
     */
    private static function differs(array $changes, array $versionMap, array $currentMap): array
    {
        $entries = static fn (array $paths): array => array_map(static fn (string $path): array => ['path' => $path, 'text' => !isset($versionMap[$path]) && !isset($currentMap[$path])], $paths);
        return ['added' => $entries($changes['paths']['added']), 'removed' => $entries($changes['paths']['removed']), 'changed' => $entries($changes['paths']['changed']),
            'routes' => $changes['routes'], 'database' => $changes['database'], 'outside' => $changes['outside'], 'asks' => $changes['asks'],
            'access' => $changes['access'], 'home' => $changes['home']];
    }

    /**
     * A project's manifest, or [] where it has none that reads.
     *
     * @param array<string, mixed> $files
     * @return array<string, mixed>
     */
    private static function manifest(array $files): array
    {
        $manifest = is_string($files['manifest.json'] ?? null) ? json_decode($files['manifest.json'], true) : null;
        return is_array($manifest) ? $manifest : [];
    }

    /**
     * The manifest's `server` block, or [] where there is none.
     *
     * @param array<string, mixed> $files
     * @return array<string, mixed>
     */
    private static function server(array $files): array
    {
        $manifest = self::manifest($files);
        return is_array($manifest['server'] ?? null) ? $manifest['server'] : [];
    }

    /** A value of the manifest with every object's keys in order, so two that say the same compare the same. */
    private static function ordered(mixed $value): mixed
    {
        if (!is_array($value)) return $value;
        if (!array_is_list($value)) ksort($value, SORT_STRING);
        return array_map(static fn (mixed $inner): mixed => self::ordered($inner), $value);
    }

    /**
     * The database changes a project lists, in its order.
     *
     * @param array<string, mixed> $files
     * @return list<string>
     */
    private static function migrations(array $files): array
    {
        $listed = self::server($files)['database']['migrations'] ?? null;
        return is_array($listed) ? array_values(array_filter($listed, 'is_string')) : [];
    }

    /**
     * A version's source with the database changes applied since it was written: each one's file
     * as the current app has it, and the manifest listing them in the order the current app does
     * (the order they ran in), then any only this version names. The manifest is read and written
     * as objects, so an empty object in it stays one. A version with no backend to list them in is
     * left as it is: install() then says why it cannot replace an app whose database has changes.
     *
     * @param array<string, string> $files
     * @param array<string, string> $currentFiles
     * @param list<string> $ahead
     * @return array<string, string>
     */
    private static function carrying(array $files, array $currentFiles, array $ahead): array
    {
        try { $manifest = json_decode((string) ($files['manifest.json'] ?? ''), false, 64, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { return $files; }
        if (!$manifest instanceof \stdClass || !($manifest->server ?? null) instanceof \stdClass) return $files;
        if (!($manifest->server->database ?? null) instanceof \stdClass) return $files;
        $listed = self::migrations($files);
        $manifest->server->database->migrations = array_values(array_unique(array_merge(self::migrations($currentFiles), $listed)));
        try { $files['manifest.json'] = json_encode($manifest, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); }
        catch (\JsonException) { return $files; }
        foreach ($ahead as $path) {
            if (is_string($currentFiles[$path] ?? null)) $files[$path] = $currentFiles[$path];
        }
        return $files;
    }

    // ── Files ────────────────────────────────────────────────────────────────────────────────

    private static function isOperation(string $operation): bool
    {
        return preg_match('/^[a-f0-9]{8,64}$/D', $operation) === 1;
    }

    private static function isKey(mixed $key): bool
    {
        return is_string($key) && preg_match('/^[a-f0-9]{64}$/D', $key) === 1;
    }

    /** An error's own words for the log, without where the installation is on disk. */
    private static function said(string $root, \Throwable $error): string
    {
        $places = array_unique([$root, str_replace('\\', '/', $root), str_replace('/', '\\', $root)]);
        return mb_strcut(str_replace($places, 'the installation', $error->getMessage()), 0, 300);
    }

    /** Whether anything at all is at a path: a file, a folder, or a link to nothing. */
    private static function present(string $path): bool
    {
        clearstatcache(true, $path);
        return file_exists($path) || is_link($path);
    }

    /**
     * A file's bytes, all of them, or null when they could not be read just now. Never a guess:
     * on Windows a file another program holds under a lock opens, and reads as nothing or as a
     * part of itself with no error, so what was read is held to the size the open file reports.
     * Only a plain file is read (never a link, never a folder), and a read that fails is tried
     * again for a moment, since what holds a file usually lets go.
     */
    private static function readWhole(string $path): ?string
    {
        if (is_link($path) || !is_file($path)) return null;
        for ($attempt = 0; $attempt < 4; $attempt++) {
            if ($attempt > 0) usleep(50000);
            $stream = @fopen($path, 'rb');
            if ($stream === false) continue;
            try {
                $stat = fstat($stream);
                $raw = @stream_get_contents($stream);
            } finally { fclose($stream); }
            if (is_string($raw) && is_array($stat) && strlen($raw) === $stat['size']) return $raw;
        }
        return null;
    }

    private static function directory(string $path): void
    {
        if (is_link($path)) throw new RuntimeException('App storage is unavailable');
        if (is_dir($path)) return;
        if (file_exists($path) || (!@mkdir($path, 0700, true) && !is_dir($path))) throw new RuntimeException('App storage is unavailable');
    }

    /**
     * Write $bytes to $path completely or not at all, as NativeAppService writes what it
     * publishes: to a private file beside it, every byte counted, flushed to disk, then renamed.
     */
    private static function write(string $path, string $bytes): void
    {
        $pending = $path . '.tmp-' . bin2hex(random_bytes(6));
        try {
            $stream = @fopen($pending, 'xb');
            if ($stream === false) throw new RuntimeException('Could not write the app\'s history');
            try {
                for ($written = 0, $length = strlen($bytes); $written < $length; $written += $count) {
                    $count = @fwrite($stream, $written === 0 ? $bytes : substr($bytes, $written));
                    if ($count === false || $count === 0) throw new RuntimeException('Short write to the app\'s history: ' . $written . ' of ' . $length . ' bytes');
                }
                if (!fflush($stream)) throw new RuntimeException('Could not flush the app\'s history');
                fsync($stream);
            } finally { fclose($stream); }
            @chmod($pending, 0600);
            if (!self::rename($pending, $path)) throw new RuntimeException('Could not place a file of the app\'s history');
        } finally { if (is_file($pending)) @unlink($pending); }
    }

    /** rename(), tried again for a moment: on Windows a file another process is reading cannot be replaced until it is closed. */
    private static function rename(string $from, string $to): bool
    {
        for ($attempt = 0; $attempt < 5; $attempt++) {
            if (@rename($from, $to)) return true;
            usleep(40000);
        }
        return false;
    }
}
