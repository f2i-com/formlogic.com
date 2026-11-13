<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\{NativeAppService, NativeAppVersions};
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Every version of a native app is kept when a later one replaces it, and its owner can go back:
 * what is kept and what is said of it, that nothing is kept of an install that did not happen,
 * that media is kept once by its content, what falls out and when, and that going back is a new
 * version with the old content. And what the history does when something is wrong with it: an
 * index that cannot be read just now or is not one, a record still waiting for its name, a kept
 * file that is damaged, a folder that cannot be written. None of them loses a version that was
 * kept, and none of them stops a publish.
 *
 * The apps are installed for real (NativeAppService::install) into a folder of their own. Most
 * have no backend, so nothing is started; the tests that need a database run on softn-runner
 * where the prepared runtime carries it for this server, and are skipped where it does not.
 */
final class NativeAppVersionsTest extends TestCase
{
    private const APP = 'notes';
    private const PNG = "\x89PNG\r\n\x1a\n\x00\xff\x80\x07";

    private ?string $storage = null;
    private NativeAppService $native;
    private NativeAppVersions $versions;

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/formlogic-native-versions-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700);
        $this->native = new NativeAppService($this->storage, $this->storage . '/no-runtime');
        $this->versions = new NativeAppVersions($this->native);
        unset($_ENV['NATIVE_HISTORY_MB']);
    }

    protected function tearDown(): void
    {
        unset($_ENV['NATIVE_HISTORY_MB']);
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-versions-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    /** An app with no backend: a page, and whatever else is given. */
    private static function project(array $files = [], array $media = [], array $over = []): array
    {
        return $over + ['access' => 'application', 'home' => true,
            'files' => $files + ['manifest.json' => '{"id":"notes","name":"Notes","main":"index.html"}', 'index.html' => '<h1>Notes</h1>'],
            'assets' => array_map('base64_encode', $media)];
    }

    private function install(array $project, int $expected, ?array $origin = null, ?NativeAppService $with = null): array
    {
        return ($with ?? $this->native)->install(self::APP, $project, $expected, null, $origin);
    }

    /** Where the install keeps the app, and its history beside the project. */
    private function root(): string { return $this->storage . '/' . hash('sha256', self::APP); }
    private function history(): string { return $this->root() . '/history'; }

    /** Every file of the history, by path, with a hash of what it holds: what "as it was" is compared by. */
    private function historyFiles(): array
    {
        clearstatcache();
        if (!is_dir($this->history())) return [];
        $base = strlen(str_replace('\\', '/', $this->history())) + 1;
        $files = [];
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->history(), \FilesystemIterator::SKIP_DOTS)) as $entry) {
            $files[substr(str_replace('\\', '/', $entry->getPathname()), $base)] = hash_file('sha256', $entry->getPathname());
        }
        ksort($files);
        return $files;
    }

    /** The names in one folder of the history. @return list<string> */
    private function kept(string $folder): array
    {
        $names = array_values(array_diff(is_dir($this->history() . '/' . $folder) ? scandir($this->history() . '/' . $folder) : [], ['.', '..']));
        sort($names);
        return $names;
    }

    /** The versions the list holds, newest first. @return list<int> */
    private function numbers(): array
    {
        return array_column($this->versions->list(self::APP)['versions'], 'version');
    }

    private function row(int $version): array
    {
        foreach ($this->versions->list(self::APP)['versions'] as $row) if ($row['version'] === $version) return $row;
        $this->fail("Version {$version} is not in the list");
    }

    private function assertNotKept(int $version): void
    {
        try { $this->versions->get(self::APP, $version); $this->fail("Version {$version} is still kept"); }
        catch (\RuntimeException $gone) { $this->assertSame(404, $gone->getCode(), $gone->getMessage()); }
    }

    /** Run $run with PHP's log sent to a file of this test's, and answer what was logged. */
    private function logged(callable $run): string
    {
        $file = $this->storage . '/php-error.log';
        if (is_file($file)) unlink($file);
        $before = (string) ini_get('error_log');
        ini_set('error_log', $file);
        try { $run(); } finally { ini_set('error_log', $before); }
        return is_file($file) ? (string) file_get_contents($file) : '';
    }

    /** The code and message a call is refused with. @return array{0: int, 1: string} */
    private function refused(callable $call): array
    {
        try { $call(); }
        catch (\RuntimeException|\InvalidArgumentException $refused) { return [$refused->getCode(), $refused->getMessage()]; }
        $this->fail('The call was not refused');
    }

    /** Whatever the install left that it should have retired: its journal, its staging and its backups. @return list<string> */
    private function leftByAnInstall(): array
    {
        clearstatcache();
        return array_map('basename', array_merge(glob($this->root() . '/private/install.json') ?: [], glob($this->root() . '/staging-*') ?: [],
            glob($this->root() . '/private/project.previous-*') ?: [], glob($this->root() . '/private/config.previous-*') ?: []));
    }

    /** The state of the existing test above: the newest install succeeded and its record is still waiting for its name. */
    private function leaveTheNewestRecordWaiting(string $indexBeforeIt): void
    {
        $index = $this->history() . '/index.json';
        rename($index, $this->history() . '/index.pending-0123456789abcdef.json');
        file_put_contents($index, $indexBeforeIt);
    }

    // ── Kept on replace ──────────────────────────────────────────────────────────────────────

    public function testTheVersionAnInstallReplacesIsKeptWithWhoMadeItHowAndWhatItChanged(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]), 0, ['by' => 'ana', 'how' => 'upload', 'summary' => 'First version']);
        $list = $this->versions->list(self::APP);
        $this->assertSame([1, [1]], [$list['current'], array_column($list['versions'], 'version')], 'a first version replaces nothing');
        $this->assertSame([], $this->kept('texts'), 'and nothing of it is copied: it is the project');
        $this->assertSame([], $this->kept('blobs'));

        $long = "  Adds an about page\n\tand a photo.  " . str_repeat('x', 300);
        $this->install(self::project(['index.html' => '<h1>Two</h1>', 'about.html' => '<p>About</p>'], ['assets/logo.png' => self::PNG, 'assets/photo.png' => self::PNG . '2']), 1, ['by' => 'ben', 'how' => 'mcp', 'summary' => $long]);

        $list = $this->versions->list(self::APP);
        $this->assertSame(2, $list['current']);
        [$now, $before] = $list['versions'];
        $this->assertSame([2, true, 'ben', 'mcp'], [$now['version'], $now['current'], $now['by'], $now['how']]);
        // One line, its spaces single, cut to 200 characters.
        $this->assertSame(200, mb_strlen($now['summary']));
        $this->assertStringStartsWith('Adds an about page and a photo. xxx', $now['summary']);
        $this->assertSame([2, 0, 1], [$now['changes']['added'], $now['changes']['removed'], $now['changes']['changed']]);
        $this->assertSame([false, false, false, false, false], [$now['changes']['routes'], $now['changes']['database'], $now['changes']['access'], $now['changes']['home'], $now['changes']['first']]);
        $this->assertArrayNotHasKey('paths', $now['changes'], 'the list carries counts, not every path of every version');

        $this->assertSame([1, false, 'ana', 'upload', 'First version'], [$before['version'], $before['current'], $before['by'], $before['how'], $before['summary']]);
        $this->assertTrue($before['changes']['first']);
        $this->assertSame(3, $before['changes']['added']);
        $this->assertSame([2, 1], [$before['files'], $before['assets']]);
        $this->assertNotFalse(strtotime((string) $before['madeAt']), 'when it was made is the time its project carried');
        $this->assertSame(['versions' => 30, 'bytes' => 256 * 1024 * 1024, 'pinned' => 20], $list['limits']);

        // What differs between version 1 and the app as it is, oldest to newest, and which of it is text.
        $one = $this->versions->get(self::APP, 1);
        $this->assertSame(2, $one['current']);
        $this->assertSame([['path' => 'about.html', 'text' => true], ['path' => 'assets/photo.png', 'text' => false]], $one['differs']['added']);
        $this->assertSame([['path' => 'index.html', 'text' => true]], $one['differs']['changed']);
        $this->assertSame([], $one['differs']['removed']);
        $this->assertSame([], $one['databaseAhead']);
        $this->assertSame(['assets/logo.png', 'index.html', 'manifest.json'], $one['version']['changes']['paths']['added'], 'one version\'s record names the paths it changed');
        $two = $this->versions->get(self::APP, 2);
        $this->assertSame([[], [], []], [$two['differs']['added'], $two['differs']['removed'], $two['differs']['changed']], 'the current version differs from itself in nothing');
        $this->assertSame(['index.html'], $two['version']['changes']['paths']['changed']);

        // Its files are there to read, each version's own.
        $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        $this->assertSame('<h1>Two</h1>', $this->versions->file(self::APP, 2, 'index.html')['text']);
        $this->assertSame([], glob($this->history() . '/index.pending-*') ?: [], 'no record is left pending');
    }

    public function testWhoMayEnterAndWhereItOpensAreSaidWhenOnlyTheyChanged(): void
    {
        $this->install(self::project(), 0);
        $this->install(self::project([], [], ['access' => 'members', 'home' => false]), 1, ['by' => 'ana', 'how' => 'page']);
        $changes = $this->row(2)['changes'];
        $this->assertSame([0, 0, 0, true, true], [$changes['added'], $changes['removed'], $changes['changed'], $changes['access'], $changes['home']]);
        $this->assertSame(['application', true], [$this->row(1)['access'], $this->row(1)['home']]);
        // The two versions hold the same source, so it is kept once.
        $this->install(self::project([], [], ['access' => 'members', 'home' => false]), 2);
        $this->assertCount(1, $this->kept('texts'));
    }

    public function testWhatIsSaidOfAVersionIsHeldToWhatAVersionCanBeSaidToBe(): void
    {
        $this->assertSame(['by' => null, 'how' => null, 'summary' => null, 'restored' => null], NativeAppVersions::origin(['by' => ['x'], 'how' => 'magic', 'summary' => "\n \t", 'restored' => 3]));
        $this->assertSame(['by' => 'user-1', 'how' => 'rollback', 'summary' => 'Back to version 3', 'restored' => 3], NativeAppVersions::origin(['by' => 'user-1', 'how' => 'rollback', 'summary' => 'Back to version 3', 'restored' => 3]));
        $this->assertNull(NativeAppVersions::origin(['by' => '../../etc', 'how' => 'page'])['by']);
        $this->assertNull(NativeAppVersions::oneLine("\xff\xfe not text"), 'text that is not UTF-8 is no summary');
        $this->assertSame(str_repeat('é', 200), NativeAppVersions::oneLine(str_repeat('é', 250)), 'cut by characters, never through one');
    }

    public function testAnAppFromBeforeItsHistoryWasKeptStartsOneWithNoOneKnownToHaveMadeIt(): void
    {
        $this->install(self::project(['index.html' => '<h1>Old</h1>'], ['assets/logo.png' => self::PNG]), 0, ['by' => 'ana', 'how' => 'page']);
        // As an app installed before this was built: a project, and no history beside it.
        foreach ($this->historyFiles() as $path => $hash) unlink($this->history() . '/' . $path);
        foreach (['texts', 'maps', 'blobs', ''] as $folder) rmdir(rtrim($this->history() . '/' . $folder, '/'));

        $this->assertSame([1], $this->numbers());
        $this->assertSame([null, null, null], [$this->row(1)['by'], $this->row(1)['how'], $this->row(1)['changes']]);
        $this->install(self::project(['index.html' => '<h1>New</h1>'], ['assets/logo.png' => self::PNG]), 1, ['by' => 'ben', 'how' => 'page']);
        $this->assertSame([2, 1], $this->numbers(), 'the version it had is kept all the same');
        $this->assertSame([null, null, null], [$this->row(1)['by'], $this->row(1)['how'], $this->row(1)['changes']]);
        $this->assertSame('<h1>Old</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        $this->assertSame([['path' => 'index.html', 'text' => true]], $this->versions->get(self::APP, 1)['differs']['changed']);
    }

    // ── Nothing of an install that did not happen ────────────────────────────────────────────

    public function testNothingIsKeptOfAnInstallThatIsRefused(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]), 0, ['by' => 'ana', 'how' => 'page']);
        $before = $this->historyFiles();
        $this->assertSame(['index.json'], array_values(array_filter(array_keys($before), static fn (string $path): bool => !str_starts_with($path, 'maps/'))));
        $next = self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG . 'changed']);

        // Refused before anything is touched: another version than the caller read, and a project that is not one.
        foreach ([[$next, 7], [['files' => ['index.html' => 'no manifest']], 1], [self::project(['../outside.html' => 'x']), 1]] as [$project, $expected]) {
            try { $this->install($project, $expected, ['by' => 'ben', 'how' => 'page']); $this->fail('The install was not refused'); }
            catch (\RuntimeException|\InvalidArgumentException) { /* refused */ }
            $this->assertSame($before, $this->historyFiles());
        }
        // Stopped part-way, at each point after its record was prepared: the journal puts the app back, and the record goes.
        foreach (['config-changed', 'activating', 'source-activated', 'migrated', 'project-written'] as $point) {
            $stopping = new StoppedAtNativeAppService($this->storage, $this->storage . '/no-runtime', $point);
            try { $this->install($next, 1, ['by' => 'ben', 'how' => 'page'], $stopping); $this->fail('The install was not stopped at ' . $point); }
            catch (\RuntimeException $stopped) { $this->assertSame('stopped at ' . $point, $stopped->getMessage()); }
            $this->assertSame(1, $this->native->get(self::APP)['version'], $point);
            $this->assertSame($before, $this->historyFiles(), 'the history is as it was after a stop at ' . $point);
            $this->assertSame([1], $this->numbers(), $point);
        }
        // And the install that then succeeds keeps version 1 once, as ana made it.
        $this->install($next, 1, ['by' => 'ben', 'how' => 'page']);
        $this->assertSame([2, 1], $this->numbers());
        $this->assertSame(['ana', 'ben'], [$this->row(1)['by'], $this->row(2)['by']]);
    }

    public function testAFirstInstallThatFailsLeavesNoHistoryBehind(): void
    {
        $stopping = new StoppedAtNativeAppService($this->storage, $this->storage . '/no-runtime', 'migrated');
        try { $this->install(self::project([], ['assets/logo.png' => self::PNG]), 0, null, $stopping); $this->fail('The install was not stopped'); }
        catch (\RuntimeException $stopped) { $this->assertSame('stopped at migrated', $stopped->getMessage()); }
        $this->assertNull($this->native->get(self::APP));
        $this->assertDirectoryDoesNotExist($this->history());
    }

    public function testAnInstallThatReachedItsLastStepIsKeptEvenWhenItsCallerIsToldOfAFailure(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>']), 0, ['by' => 'ana', 'how' => 'page']);
        $stopping = new StoppedAtNativeAppService($this->storage, $this->storage . '/no-runtime', 'metadata-promoted');
        try { $this->install(self::project(['index.html' => '<h1>Two</h1>']), 1, ['by' => 'ben', 'how' => 'page'], $stopping); $this->fail('The install was not stopped'); }
        catch (\RuntimeException $stopped) { $this->assertSame('stopped at metadata-promoted', $stopped->getMessage()); }
        // The journal rolls a finished install forward, and its record with it.
        $this->assertSame(2, $this->native->get(self::APP)['version']);
        $this->assertSame([2, 1], $this->numbers());
        $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
    }

    /** @return list<array{0: string, 1: bool}> */
    public static function terminations(): array
    {
        return [['config-changed', false], ['migrated', false], ['metadata-promoted', true]];
    }

    /**
     * A separate PHP process runs the update and exits at the named phase (no catch, no finally),
     * leaving its journal. Whoever comes next settles it: rolled back, the history is as it was;
     * rolled forward, the version it replaced is kept.
     */
    #[DataProvider('terminations')]
    public function testAnInstallSettledByTheJournalLeavesTheHistoryAsItWasOrKeepsTheVersion(string $phase, bool $rolledForward): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]), 0, ['by' => 'ana', 'how' => 'page']);
        $before = $this->historyFiles();
        $script = $this->storage . '/terminate.php';
        file_put_contents($script, '<?php
declare(strict_types=1);
require ' . var_export(dirname(__DIR__, 2) . '/vendor/autoload.php', true) . ';
final class TerminatingForHistory extends \FormLogic\Services\NativeAppService {
    protected function afterPhase(string $root, string $phase): void { if ($phase === ' . var_export($phase, true) . ') { fwrite(STDOUT, "terminated at " . $phase); exit(0); } }
}
$service = new TerminatingForHistory(' . var_export($this->storage, true) . ', ' . var_export($this->storage . '/no-runtime', true) . ');
$service->install("notes", ' . var_export(self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG . 'changed']), true) . ', 1, null, ["by" => "ben", "how" => "page"]);
fwrite(STDOUT, "completed");
');
        $output = shell_exec(escapeshellarg(PHP_BINARY) . ' -d xdebug.mode=off ' . escapeshellarg($script) . ' 2>&1');
        $this->assertSame('terminated at ' . $phase, trim((string) $output), 'the child process must die at the requested point');
        $this->assertFileExists($this->root() . '/private/install.json', 'the terminated process left its journal');
        $this->assertCount(1, glob($this->history() . '/index.pending-*') ?: [], 'and its record, still pending');

        // Reading the history is as likely as anything to be what settles it.
        $numbers = $this->numbers();
        $this->assertFileDoesNotExist($this->root() . '/private/install.json');
        $this->assertSame([], glob($this->history() . '/index.pending-*') ?: []);
        if ($rolledForward) {
            $this->assertSame([2, 1], $numbers);
            $this->assertSame(['ana', 'ben'], [$this->row(1)['by'], $this->row(2)['by']]);
            $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        } else {
            $this->assertSame([1], $numbers);
            $this->assertSame($before, $this->historyFiles(), 'the history is as it was');
        }
    }

    public function testARecordThatCouldNotBeGivenItsNameIsTakenUpByTheNextInstall(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>']), 0, ['by' => 'ana', 'how' => 'page']);
        $index = $this->history() . '/index.json';
        $earlier = file_get_contents($index);
        $this->install(self::project(['index.html' => '<h1>Two</h1>']), 1, ['by' => 'ben', 'how' => 'mcp']);
        // As if the second install had succeeded and its last rename had not: its record still pending, the index the one before.
        rename($index, $this->history() . '/index.pending-0123456789abcdef.json');
        file_put_contents($index, $earlier);
        // Until then a read takes the waiting record in the index's place (it writes nothing): the
        // version it replaced is listed, and nothing is said to be missing.
        $this->assertSame([2, 1], $this->numbers());
        $this->assertSame(['ben', 'mcp', null], [$this->row(2)['by'], $this->row(2)['how'], $this->row(2)['gap']]);
        $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        $this->assertCount(1, glob($this->history() . '/index.pending-*') ?: [], 'a read gives the record no name');

        $this->install(self::project(['index.html' => '<h1>Three</h1>']), 2, ['by' => 'cy', 'how' => 'page']);
        $this->assertSame([3, 2, 1], $this->numbers());
        $this->assertSame([['ana', 'page'], ['ben', 'mcp'], ['cy', 'page']], array_map(fn (int $n): array => [$this->row($n)['by'], $this->row($n)['how']], [1, 2, 3]));
        $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        $this->assertSame([], glob($this->history() . '/index.pending-*') ?: []);
    }

    // ── Media, once ──────────────────────────────────────────────────────────────────────────

    public function testMediaIsKeptOnceByItsContentHoweverManyVersionsAndPathsNameIt(): void
    {
        $x = random_bytes(5000);
        $y = random_bytes(7000);
        $z = random_bytes(9000);
        $media = ['assets/a.png' => $x, 'assets/copy/b.png' => $x, 'assets/c.bin' => $y];
        $this->install(self::project(['index.html' => '1'], $media), 0);
        $this->install(self::project(['index.html' => '2'], $media), 1);
        // Version 1 is kept: two files' bytes for its three paths.
        $this->assertEqualsCanonicalizing([hash('sha256', $x), hash('sha256', $y)], $this->kept('blobs'));
        $this->install(self::project(['index.html' => '2'], ['assets/c.bin' => $z] + $media), 2);
        $this->assertEqualsCanonicalizing([hash('sha256', $x), hash('sha256', $y)], $this->kept('blobs'), 'version 2 holds what version 1 held: nothing more is written');
        $this->install(self::project(['index.html' => '4'], ['assets/c.bin' => $z] + $media), 3);
        $this->assertEqualsCanonicalizing([hash('sha256', $x), hash('sha256', $y), hash('sha256', $z)], $this->kept('blobs'));
        foreach ($this->kept('blobs') as $name) $this->assertSame($name, hash_file('sha256', $this->history() . '/blobs/' . $name), 'a file is kept under the hash of its bytes');
        // Versions 2 and 3 hold the same source, and 1 and 2 the same media by the same names: each kept once.
        $this->assertCount(2, $this->kept('texts'));
        $index = json_decode((string) file_get_contents($this->history() . '/index.json'), true);
        $this->assertSame([3, 2, 1], array_column($index['versions'], 'version'));
        $this->assertSame($index['versions'][1]['map'], $index['versions'][2]['map']);
        $this->assertSame($index['versions'][0]['text'], $index['versions'][1]['text']);
        // What the history is said to take counts each of them once.
        $texts = array_sum(array_map(fn (string $name): int => (int) filesize($this->history() . '/texts/' . $name), $this->kept('texts')));
        $maps = array_sum(array_map(fn (string $key): int => (int) filesize((glob($this->history() . '/maps/' . $key . '.*') ?: [''])[0]), array_unique(array_column($index['versions'], 'map'))));
        $this->assertSame(5000 + 7000 + 9000 + $texts + $maps, $this->versions->list(self::APP)['bytes']);
        // And a version's media come back byte for byte when it is gone back to.
        $this->versions->restore(self::APP, 1, 4, 'ana');
        $now = $this->native->get(self::APP);
        $this->assertSame(array_map('base64_encode', $media), $now['assets']);
        $this->assertSame('1', $now['files']['index.html']);
    }

    // ── What falls out ───────────────────────────────────────────────────────────────────────

    public function testTheThirtyNewestAreKeptAndAPinnedOnePastThem(): void
    {
        for ($n = 1; $n <= 35; $n++) {
            $this->install(self::project(['index.html' => "<h1>{$n}</h1>"]), $n - 1);
            if ($n === 3) $this->assertSame(['version' => 2, 'pinned' => true], $this->versions->pin(self::APP, 2, true));
        }
        $this->assertSame([35, ...range(34, 5), 2], $this->numbers(), 'the current one, the thirty before it, and the pinned one');
        foreach ([1, 3, 4] as $gone) $this->assertNotKept($gone);
        $this->assertCount(31, $this->kept('texts'), 'what fell out is removed from disk too');
        $this->assertTrue($this->row(2)['pinned']);
        $this->assertSame('<h1>2</h1>', $this->versions->file(self::APP, 2, 'index.html')['text']);

        // Unpinned, it is past the thirty: said so, and gone at the next publish.
        $this->versions->pin(self::APP, 2, false);
        $this->assertSame([false, true], [$this->row(2)['pinned'], $this->row(2)['expires']]);
        $this->assertFalse($this->row(5)['expires']);
        $this->install(self::project(['index.html' => '<h1>36</h1>']), 35);
        $this->assertSame([36, ...range(35, 6)], $this->numbers());
        $this->assertNotKept(2);
        $this->assertCount(30, $this->kept('texts'));
    }

    public function testThePinStaysWithAVersionAndOnlySoManyCanBePinned(): void
    {
        $this->install(self::project(['index.html' => '<h1>1</h1>']), 0);
        // The current version can be pinned; the pin is its own when a later one replaces it.
        $this->versions->pin(self::APP, 1, true);
        $this->assertTrue($this->row(1)['pinned']);
        for ($n = 2; $n <= 22; $n++) $this->install(self::project(['index.html' => "<h1>{$n}</h1>"]), $n - 1);
        $this->assertTrue($this->row(1)['pinned']);
        for ($n = 2; $n <= 20; $n++) $this->versions->pin(self::APP, $n, true);
        foreach ([21, 22] as $one) {
            try { $this->versions->pin(self::APP, $one, true); $this->fail('A twenty-first version was pinned'); }
            catch (\RuntimeException $full) { $this->assertSame([409, 'At most 20 versions can be pinned. Unpin one first.'], [$full->getCode(), $full->getMessage()]); }
        }
        $this->versions->pin(self::APP, 7, true);
        $this->versions->pin(self::APP, 7, false);
        $this->assertSame(['version' => 21, 'pinned' => true], $this->versions->pin(self::APP, 21, true));
        try { $this->versions->pin(self::APP, 99, true); $this->fail('A version that does not exist was pinned'); }
        catch (\RuntimeException $missing) { $this->assertSame(404, $missing->getCode()); }
    }

    public function testTheSizeLimitTakesTheOldestUnpinnedThenThePinnedAndNeverTheNewestThree(): void
    {
        $_ENV['NATIVE_HISTORY_MB'] = '1';
        $this->assertSame(1024 * 1024, NativeAppVersions::maxBytes());
        $media = [];
        $publish = function (int $n, int $kilobytes) use (&$media): void {
            $media[$n] = random_bytes($kilobytes * 1000);
            $this->install(self::project(['index.html' => "<h1>{$n}</h1>"], ['assets/art.bin' => $media[$n]]), $n - 1);
        };
        $blobs = function (int ...$versions) use (&$media): array { return array_map(static fn (int $n): string => hash('sha256', $media[$n]), $versions); };

        $publish(1, 100); $publish(2, 100); $publish(3, 300);
        $this->versions->pin(self::APP, 1, true);
        $publish(4, 300); $publish(5, 300);
        $this->assertSame([5, 4, 3, 2, 1], $this->numbers(), 'four versions, 800 KB of media: within the megabyte');
        // A fifth would make 1.1 MB. The oldest unpinned goes, the pinned one stays.
        $publish(6, 300);
        $this->assertSame([6, 5, 4, 3, 1], $this->numbers());
        $this->assertEqualsCanonicalizing($blobs(5, 4, 3, 1), $this->kept('blobs'), 'and the bytes nothing names any more are removed');
        $publish(7, 300);
        $this->assertSame([7, 6, 5, 4, 1], $this->numbers());
        $this->assertLessThanOrEqual(1024 * 1024, $this->versions->list(self::APP)['bytes']);
        // With nothing unpinned past the newest three, the oldest pinned go; the newest three stay
        // though they alone would not fit a smaller limit.
        $this->versions->pin(self::APP, 4, true);
        $publish(8, 300); $publish(9, 300);
        $this->assertSame([9, 8, 7, 6], $this->numbers());
        $this->assertEqualsCanonicalizing($blobs(8, 7, 6), $this->kept('blobs'));
        $_ENV['NATIVE_HISTORY_MB'] = '0';
        $this->assertSame(NativeAppVersions::MAX_BYTES, NativeAppVersions::maxBytes(), 'a limit that is not a number of megabytes is the usual one');
    }

    // ── Going back ───────────────────────────────────────────────────────────────────────────

    public function testGoingBackIsANewVersionWithTheOldContent(): void
    {
        $one = self::project(['index.html' => '<h1>One</h1>', 'old.html' => 'old'], ['assets/logo.png' => self::PNG]);
        $this->install($one, 0, ['by' => 'ana', 'how' => 'page']);
        $this->install(self::project(['index.html' => '<h1>Two</h1>', 'about.html' => 'about'], ['assets/logo.png' => self::PNG . '2', 'assets/new.png' => self::PNG], ['access' => 'members', 'home' => false]), 1, ['by' => 'ana', 'how' => 'upload']);

        // Only from the version the page was looking at, only to a version that is kept, and never to the current one.
        foreach ([[1, 1, \RuntimeException::class, 409], [9, 2, \RuntimeException::class, 404], [2, 2, \InvalidArgumentException::class, 0]] as [$version, $expected, $class, $code]) {
            try { $this->versions->restore(self::APP, $version, $expected, 'ana'); $this->fail("Went back to {$version} from {$expected}"); }
            catch (\RuntimeException|\InvalidArgumentException $refused) { $this->assertSame([$class, $code], [get_class($refused), $refused->getCode()], $refused->getMessage()); }
            $this->assertSame(2, $this->native->get(self::APP)['version']);
        }

        $checked = [];
        $answer = $this->versions->restore(self::APP, 1, 2, 'ana', static function (array $project) use (&$checked): void { $checked = array_keys($project['files']); });
        $this->assertSame(['version' => 3, 'restored' => 1, 'databaseAhead' => []], $answer);
        $this->assertEqualsCanonicalizing(['index.html', 'old.html', 'manifest.json'], $checked, 'what is about to be installed is shown to the caller\'s check first');
        $now = $this->native->get(self::APP);
        $this->assertSame(3, $now['version']);
        $this->assertSame($one['files'], $now['files']);
        $this->assertSame($one['assets'], $now['assets']);
        // Who may enter and where it opens are the app's settings as they are now, not the old version's.
        $this->assertSame(['members', false], [$now['access'], $now['home']]);
        // History only grows: the version gone back from is kept, and the new one says what it is.
        $this->assertSame([3, 2, 1], $this->numbers());
        $row = $this->row(3);
        $this->assertSame(['ana', 'rollback', 1, 'Back to version 1'], [$row['by'], $row['how'], $row['restored'], $row['summary']]);
        // From version 2: old.html is back, about.html and the new picture are gone, the page and the logo are as they were.
        $this->assertSame([1, 2, 2], [$row['changes']['added'], $row['changes']['removed'], $row['changes']['changed']]);
        $this->assertSame('<h1>Two</h1>', $this->versions->file(self::APP, 2, 'index.html')['text']);
        // A check that refuses stops it before anything is installed.
        try { $this->versions->restore(self::APP, 2, 3, 'ana', static fn () => throw new \InvalidArgumentException('not this one')); $this->fail('A refused version was installed'); }
        catch (\InvalidArgumentException $refused) { $this->assertSame('not this one', $refused->getMessage()); }
        $this->assertSame(3, $this->native->get(self::APP)['version']);
    }

    public function testAVersionWhoseKeptFileIsDamagedIsNotGoneBackTo(): void
    {
        $this->install(self::project([], ['assets/logo.png' => self::PNG]), 0);
        $this->install(self::project([], ['assets/logo.png' => self::PNG . '2']), 1);
        file_put_contents($this->history() . '/blobs/' . hash('sha256', self::PNG), 'not what it was');
        try { $this->versions->restore(self::APP, 1, 2, 'ana'); $this->fail('A damaged version was installed'); }
        catch (\RuntimeException $damaged) { $this->assertSame(409, $damaged->getCode()); $this->assertStringContainsString('damaged', $damaged->getMessage()); }
        $this->assertSame(2, $this->native->get(self::APP)['version']);
    }

    // ── The database only moves forward ──────────────────────────────────────────────────────

    public function testDatabaseAheadIsWhatTheCurrentAppListsAndAVersionDoesNot(): void
    {
        $manifest = static fn (?array $migrations): string => json_encode(['main' => 'index.html'] + ($migrations === null ? [] : ['server' => ['database' => ['kind' => 'private-sqlite', 'migrations' => $migrations]]]));
        $one = ['manifest.json' => $manifest(['server/migrations/001.sql'])];
        $three = ['manifest.json' => $manifest(['server/migrations/001.sql', 'server/migrations/002_tags.sql', 'server/migrations/003.sql'])];
        $this->assertSame(['server/migrations/002_tags.sql', 'server/migrations/003.sql'], NativeAppVersions::databaseAhead($one, $three));
        $this->assertSame([], NativeAppVersions::databaseAhead($three, $three));
        $this->assertSame([], NativeAppVersions::databaseAhead($three, $one), 'a version that lists more than the app has run is ahead of nothing');
        $this->assertSame(['server/migrations/001.sql'], NativeAppVersions::databaseAhead(['manifest.json' => $manifest(null)], $one), 'a version from before the backend');
        $this->assertSame([], NativeAppVersions::databaseAhead(['manifest.json' => 'not json'], ['manifest.json' => $manifest(null)]));
    }

    public function testGoingBackLeavesTheDatabaseAndTheChangesAppliedToIt(): void
    {
        $runtime = dirname(__DIR__, 2) . '/resources/softn-native';
        $runner = ['Linux' => 'softn-runner-linux-x86_64', 'Windows' => 'softn-runner-windows-x86_64.exe'][PHP_OS_FAMILY] ?? null;
        if ($runner === null || !in_array(strtolower(php_uname('m')), ['x86_64', 'amd64'], true) || !is_file($runtime . '/bin/' . $runner) || !is_file($runtime . '/host-protocol.json')) {
            $this->markTestSkipped('The prepared Softn runtime carries no softn-runner for this server.');
        }
        $native = new NativeAppService($this->storage, $runtime, $this->storage . '/no-such-node.exe', 'auto');
        if (!$native->available()) $this->markTestSkipped('The native runtime is not prepared.');
        $versions = new NativeAppVersions($native);
        $backend = static function (array $migrations, string $logic, string $page): array {
            $files = ['manifest.json' => json_encode(['id' => 'test.notes', 'version' => '1.0.0', 'main' => 'ui/main.ui', 'server' => [
                'entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']],
                'database' => ['kind' => 'private-sqlite', 'migrations' => array_keys($migrations)],
                'routes' => [['path' => '/api/notes', 'method' => 'POST', 'handler' => 'createNote', 'transaction' => 'write', 'authorization' => 'anonymous']],
            ]]), 'ui/main.ui' => $page, 'server/main.logic' => $logic] + $migrations;
            return ['access' => 'application', 'assets' => [], 'files' => $files];
        };
        $logic = 'function createNote(req) { softn.sql.execute("INSERT INTO notes(title) VALUES(?)",[req.body.title]); return {status:201,body:softn.sql.first("SELECT id,title FROM notes ORDER BY id DESC",[])}; }';
        $first = ['server/migrations/001.sql' => 'CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT);'];
        $second = $first + ['server/migrations/002.sql' => 'CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT);'];
        $note = static fn (string $title): array => $native->request(self::APP, ['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => $title], 'client_ip' => '127.0.0.1']);

        $native->install(self::APP, $backend($first, $logic, '<Text>One</Text>'), 0, null, ['by' => 'ana', 'how' => 'page']);
        $this->assertSame(201, $note('Kept')['status']);
        $native->install(self::APP, $backend($second, $logic . ' // two', '<Text>Two</Text>'), 1, null, ['by' => 'ana', 'how' => 'page']);
        $this->assertSame(201, $note('Second')['status']);
        $changes = $versions->list(self::APP)['versions'][0]['changes'];
        $this->assertSame([true, false], [$changes['database'], $changes['routes']]);

        // Said before: version 1 was written before the tags table.
        $this->assertSame(['server/migrations/002.sql'], $versions->get(self::APP, 1)['databaseAhead']);
        // And after, by the going back itself, which still happens.
        $answer = $versions->restore(self::APP, 1, 2, 'ana');
        $this->assertSame(['version' => 3, 'restored' => 1, 'databaseAhead' => ['server/migrations/002.sql']], $answer);

        $now = $native->get(self::APP);
        $this->assertSame('<Text>One</Text>', $now['files']['ui/main.ui']);
        $this->assertSame($logic, $now['files']['server/main.logic']);
        // The change that has run stays listed, with its file, so the backend starts on the database as it is.
        $this->assertSame(array_keys($second), json_decode($now['files']['manifest.json'], true)['server']['database']['migrations']);
        $this->assertSame($second['server/migrations/002.sql'], $now['files']['server/migrations/002.sql']);
        // The database is not touched: its tables and its records are what they were.
        $this->assertEqualsCanonicalizing(['notes', 'tags'], $native->records(self::APP)['tables']);
        $this->assertSame(['Kept', 'Second'], array_column($native->records(self::APP, 'notes')['rows'], 'title'));
        $this->assertSame(201, $note('After going back')['status']);
        // Nothing is ahead of the version that came back, and version 2 can be returned to as well.
        $this->assertSame([], $versions->get(self::APP, 2)['databaseAhead']);
        $this->assertSame(4, $versions->restore(self::APP, 2, 3, 'ana')['version']);
        $this->assertSame(['Kept', 'Second', 'After going back'], array_column($native->records(self::APP, 'notes')['rows'], 'title'));
    }

    // ── An index that cannot be read, or is not one ──────────────────────────────────────────

    /** Three versions, each with a picture of its own: the history then keeps versions 2 and 1. */
    private function threeVersions(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG . '1']), 0, ['by' => 'ana', 'how' => 'page']);
        $this->install(self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG . '2']), 1, ['by' => 'ben', 'how' => 'mcp']);
        $this->install(self::project(['index.html' => '<h1>Three</h1>'], ['assets/logo.png' => self::PNG . '3']), 2, ['by' => 'cy', 'how' => 'page']);
    }

    /** What must hold after version 4 was installed while the index could not be read: the install happened, and the history is what it was. */
    private function assertVersionFourWentAheadAndTheHistoryIsAsItWas(array $before, string $log): void
    {
        $now = $this->native->get(self::APP);
        $this->assertSame([4, '<h1>Four</h1>'], [$now['version'], $now['files']['index.html']], 'the install went ahead');
        $this->assertSame([], $this->leftByAnInstall(), 'and left nothing of itself behind');
        $this->assertSame($before, $this->historyFiles(), 'nothing in the history was replaced, removed or added');
        $this->assertSame([4, 2, 1], $this->numbers());
        $this->assertSame(['ana', 'ben'], [$this->row(1)['by'], $this->row(2)['by']]);
        $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        // The one version that could not be kept is said: in the log, and in the list.
        $this->assertStringContainsString('version 3 was not kept when version 4 was installed', $log);
        $this->assertStringNotContainsString('<h1>', $log, 'the log holds no file\'s content');
        $this->assertSame([['from' => 3, 'to' => 3], null], [$this->row(4)['gap'], $this->row(4)['by']]);
        $this->assertNull($this->row(2)['gap']);
    }

    public function testAnIndexThatCannotBeReadDuringAnInstallIsNeitherReplacedNorSweptAgainst(): void
    {
        $this->threeVersions();
        $before = $this->historyFiles();
        $index = $this->history() . '/index.json';
        $elsewhere = $this->storage . '/index.elsewhere.json';
        // For as long as the install prepares its record, what stands at the index's name cannot
        // be read (a folder, as a file another program is holding cannot): then it can again.
        $watched = new WatchedNativeAppService($this->storage, $this->storage . '/no-runtime', [
            'backups-written' => static function () use ($index, $elsewhere): void { rename($index, $elsewhere); mkdir($index); },
            'config-changed' => static function () use ($index, $elsewhere): void { rmdir($index); rename($elsewhere, $index); },
        ]);
        $four = self::project(['index.html' => '<h1>Four</h1>'], ['assets/logo.png' => self::PNG . '4']);
        $log = $this->logged(fn () => $this->install($four, 3, ['by' => 'dee', 'how' => 'page'], $watched));
        $this->assertVersionFourWentAheadAndTheHistoryIsAsItWas($before, $log);

        // The next install keeps what it finds, and carries the gap in the record it writes.
        $this->install(self::project(['index.html' => '<h1>Five</h1>'], ['assets/logo.png' => self::PNG . '5']), 4, ['by' => 'eve', 'how' => 'page']);
        $this->assertSame([5, 4, 2, 1], $this->numbers());
        $this->assertSame([null, ['from' => 3, 'to' => 3], null], [$this->row(5)['gap'], $this->row(4)['gap'], $this->row(2)['gap']]);
        $this->assertSame(['eve', null, 'ben'], [$this->row(5)['by'], $this->row(4)['by'], $this->row(2)['by']]);
        $this->assertSame('<h1>Four</h1>', $this->versions->file(self::APP, 4, 'index.html')['text']);
        $this->assertSame('<h1>Two</h1>', $this->versions->file(self::APP, 2, 'index.html')['text']);
    }

    public function testAnIndexAnotherProgramHoldsWhileAnInstallPreparesIsLeftAsItIs(): void
    {
        if (PHP_OS_FAMILY !== 'Windows') $this->markTestSkipped('A file another handle holds under a lock can still be read on this system: the test with a folder at the index\'s name covers it.');
        $this->threeVersions();
        $before = $this->historyFiles();
        $index = $this->history() . '/index.json';
        $held = null;
        $readAs = null;
        // A real lock, as a backup tool or a scanner takes: held while the record is prepared, let go before the install ends.
        $watched = new WatchedNativeAppService($this->storage, $this->storage . '/no-runtime', [
            'backups-written' => static function () use ($index, &$held, &$readAs): void { $held = fopen($index, 'c+'); flock($held, LOCK_EX); $readAs = @file_get_contents($index); },
            'config-changed' => static function () use (&$held): void { flock($held, LOCK_UN); fclose($held); },
        ]);
        $four = self::project(['index.html' => '<h1>Four</h1>'], ['assets/logo.png' => self::PNG . '4']);
        $log = $this->logged(fn () => $this->install($four, 3, ['by' => 'dee', 'how' => 'page'], $watched));
        $this->assertSame('', $readAs, 'under the lock the file opens and reads as nothing, with no failure to tell it by');
        $this->assertVersionFourWentAheadAndTheHistoryIsAsItWas($before, $log);
    }

    public function testAnIndexThatCannotBeReadIsSaidAsThatToAReaderAndIsNotWrittenInto(): void
    {
        $this->threeVersions();
        $index = $this->history() . '/index.json';
        $elsewhere = $this->storage . '/index.elsewhere.json';
        rename($index, $elsewhere);
        mkdir($index);
        $calls = [
            'list' => fn () => $this->versions->list(self::APP), 'one version' => fn () => $this->versions->get(self::APP, 2),
            'a file' => fn () => $this->versions->file(self::APP, 2, 'index.html'), 'going back' => fn () => $this->versions->restore(self::APP, 2, 3, 'ana'),
            'a pin' => fn () => $this->versions->pin(self::APP, 2, true), 'a removal' => fn () => $this->versions->remove(self::APP, 1),
        ];
        $answers = [];
        $this->logged(function () use ($calls, &$answers): void { foreach ($calls as $name => $call) $answers[$name] = $this->refused($call); });
        // Never an empty history, which a page would show as "nothing has been replaced yet".
        foreach ($answers as $name => $answer) $this->assertSame([409, 'The app\'s history could not be read just now. Try again shortly.'], $answer, $name);
        $this->assertSame(3, $this->native->get(self::APP)['version']);
        rmdir($index);
        rename($elsewhere, $index);
        $this->assertSame([3, 2, 1], $this->numbers());
        $this->assertFalse($this->row(2)['pinned']);
    }

    public function testAnIndexThatIsNotOneIsSetAsideNotWrittenOverAndNothingIsRemovedThatTime(): void
    {
        $this->threeVersions();
        $index = $this->history() . '/index.json';
        $kept = array_values(array_filter(array_keys($this->historyFiles()), static fn (string $path): bool => $path !== 'index.json'));
        $this->assertNotSame([], preg_grep('~^blobs/~', $kept));
        // Read whole, and not an index: cut short.
        $cut = substr((string) file_get_contents($index), 0, 60);
        file_put_contents($index, $cut);

        $list = $pin = null;
        $this->logged(function () use (&$list, &$pin): void {
            $list = $this->versions->list(self::APP);
            $pin = $this->refused(fn () => $this->versions->pin(self::APP, 2, true));
        });
        $this->assertSame([true, [3]], [$list['unreadable'], array_column($list['versions'], 'version')], 'said as a history that cannot be read');
        $this->assertSame(409, $pin[0]);
        $this->assertStringContainsString('could not be read', $pin[1]);
        $this->assertSame($cut, file_get_contents($index), 'and a pin writes nothing over it');

        $this->logged(fn () => $this->install(self::project(['index.html' => '<h1>Four</h1>'], ['assets/logo.png' => self::PNG . '4']), 3, ['by' => 'dee', 'how' => 'page']));
        $aside = glob($this->history() . '/damaged-index-*.json') ?: [];
        $this->assertCount(1, $aside, 'the index that was not one is kept under another name');
        $this->assertSame($cut, file_get_contents($aside[0]), 'byte for byte');
        foreach ($kept as $path) $this->assertFileExists($this->history() . '/' . $path, 'nothing is removed at the install that set it aside');
        $list = $this->versions->list(self::APP);
        $this->assertSame([false, [4, 3]], [$list['unreadable'], array_column($list['versions'], 'version')], 'the history starts again');
        $this->assertSame([true, false], [$this->row(3)['startedAgain'], $this->row(4)['startedAgain']]);
        $this->assertSame('<h1>Three</h1>', $this->versions->file(self::APP, 3, 'index.html')['text']);

        // The install after that removes what the new index does not name, as every install does.
        // The file set aside is an operator's to look at, and stays.
        $this->install(self::project(['index.html' => '<h1>Five</h1>'], ['assets/logo.png' => self::PNG . '5']), 4);
        $this->assertSame([5, 4, 3], $this->numbers());
        $this->assertFileDoesNotExist($this->history() . '/blobs/' . hash('sha256', self::PNG . '1'));
        $this->assertFileExists($aside[0]);
    }

    // ── A record waiting for its name, and a change made meanwhile ───────────────────────────

    public function testAPinOfTheCurrentVersionWhileARecordWaitsForItsNameDoesNotLoseTheVersionBeforeIt(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]), 0, ['by' => 'ana', 'how' => 'page']);
        $earlier = (string) file_get_contents($this->history() . '/index.json');
        $this->install(self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG . '2']), 1, ['by' => 'ben', 'how' => 'mcp']);
        $this->leaveTheNewestRecordWaiting($earlier);

        $this->assertSame(['version' => 2, 'pinned' => true], $this->versions->pin(self::APP, 2, true));
        // The pin first gave the waiting record its name, as an install would, and was made to that.
        $this->assertSame([], glob($this->history() . '/index.pending-*') ?: []);
        $this->assertSame([2, 1], $this->numbers());
        $this->assertSame(['ben', 'mcp', true], [$this->row(2)['by'], $this->row(2)['how'], $this->row(2)['pinned']]);

        $this->install(self::project(['index.html' => '<h1>Three</h1>'], ['assets/logo.png' => self::PNG . '3']), 2, ['by' => 'cy', 'how' => 'page']);
        $this->assertSame([3, 2, 1], $this->numbers(), 'version 1 is still kept');
        $this->assertSame([['ana', 'page'], ['ben', 'mcp'], ['cy', 'page']], array_map(fn (int $n): array => [$this->row($n)['by'], $this->row($n)['how']], [1, 2, 3]));
        $this->assertTrue($this->row(2)['pinned'], 'and the pin stayed with version 2');
        // Its content too: the source, and the picture.
        $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        $this->versions->restore(self::APP, 1, 3, 'ana');
        $this->assertSame(base64_encode(self::PNG), $this->native->get(self::APP)['assets']['assets/logo.png']);
    }

    public function testAPinOfAnEarlierVersionWhileARecordWaitsIsMadeToTheRecordThatWaits(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>']), 0, ['by' => 'ana', 'how' => 'page']);
        $this->install(self::project(['index.html' => '<h1>Two</h1>']), 1, ['by' => 'ben', 'how' => 'mcp']);
        $earlier = (string) file_get_contents($this->history() . '/index.json');
        $this->install(self::project(['index.html' => '<h1>Three</h1>']), 2, ['by' => 'cy', 'how' => 'page']);
        // The index knows version 1 and takes version 2 for the installed one; the waiting record knows 2 and 1.
        $this->leaveTheNewestRecordWaiting($earlier);

        $this->assertSame(['version' => 1, 'pinned' => true], $this->versions->pin(self::APP, 1, true));
        $this->assertSame(['version' => 2, 'pinned' => true], $this->versions->pin(self::APP, 2, true), 'the version just replaced is in the waiting record alone');
        $this->install(self::project(['index.html' => '<h1>Four</h1>']), 3, ['by' => 'dee', 'how' => 'page']);
        $this->assertSame([4, 3, 2, 1], $this->numbers());
        $this->assertSame([true, true, false], [$this->row(1)['pinned'], $this->row(2)['pinned'], $this->row(3)['pinned']], 'neither pin was lost');
        $this->assertSame(['ana', 'ben', 'cy', 'dee'], array_map(fn (int $n): ?string => $this->row($n)['by'], [1, 2, 3, 4]));
    }

    public function testARemovalWhileARecordWaitsForItsNameIsNotUndoneByTheNextInstall(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>']), 0, ['by' => 'ana', 'how' => 'page']);
        $this->install(self::project(['index.html' => '<h1>Two</h1>']), 1, ['by' => 'ben', 'how' => 'mcp']);
        $earlier = (string) file_get_contents($this->history() . '/index.json');
        $this->install(self::project(['index.html' => '<h1>Three</h1>']), 2, ['by' => 'cy', 'how' => 'page']);
        $this->leaveTheNewestRecordWaiting($earlier);

        $this->assertSame(['version' => 1, 'removed' => true], $this->versions->remove(self::APP, 1));
        $this->assertSame([], glob($this->history() . '/index.pending-*') ?: []);
        $this->assertSame([3, 2], $this->numbers());
        $this->install(self::project(['index.html' => '<h1>Four</h1>']), 3, ['by' => 'dee', 'how' => 'page']);
        $this->assertSame([4, 3, 2], $this->numbers(), 'version 1 did not come back, and version 2 was not lost');
        $this->assertSame(['ben', 'cy'], [$this->row(2)['by'], $this->row(3)['by']]);
        $this->assertNotKept(1);
    }

    // ── A kept file that is damaged ──────────────────────────────────────────────────────────

    public function testAKeptFileThatIsDamagedIsWrittenAgainWhenItsContentIsInHand(): void
    {
        $x = random_bytes(4000);
        $y = random_bytes(4000);
        $same = ['index.html' => '<h1>The same page</h1>'];
        $this->install(self::project($same, ['assets/a.bin' => $x]), 0);
        $this->install(self::project($same, ['assets/a.bin' => $y]), 1);
        $this->install(self::project($same, ['assets/a.bin' => $x]), 2);
        // Versions 1 and 2 are kept, with one source between them and a file each. Both of
        // version 1's are then cut short on disk.
        $this->assertCount(1, $this->kept('texts'));
        $text = $this->history() . '/texts/' . $this->kept('texts')[0];
        $blob = $this->history() . '/blobs/' . hash('sha256', $x);
        file_put_contents($text, substr((string) file_get_contents($text), 0, 12));
        file_put_contents($blob, 'cut short');
        $this->assertSame(409, $this->refused(fn () => $this->versions->file(self::APP, 1, 'index.html'))[0]);

        // Version 3 holds that same source and that same file. When it is replaced, its content is
        // in hand, and what should hold it is not: written again, not taken as kept.
        $this->install(self::project(['index.html' => '<h1>Another page</h1>'], ['assets/a.bin' => $x]), 3);
        $this->assertSame($x, file_get_contents($blob));
        $this->assertSame('<h1>The same page</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        $this->assertFalse($this->row(1)['damaged']);
        $this->versions->restore(self::APP, 2, 4, 'ana');
        $this->assertSame([base64_encode($y), '<h1>The same page</h1>'], [$this->native->get(self::APP)['assets']['assets/a.bin'], $this->native->get(self::APP)['files']['index.html']]);
    }

    public function testAVersionWhoseMapCannotBeReadIsSaidToBeDamagedAndRemovingItLetsTheSweepWorkAgain(): void
    {
        $media = [1 => random_bytes(2000), 2 => random_bytes(2000), 3 => random_bytes(2000), 4 => random_bytes(2000), 5 => random_bytes(2000)];
        foreach ($media as $n => $bytes) $this->install(self::project(['index.html' => "<h1>{$n}</h1>"], ['assets/a.bin' => $bytes]), $n - 1);
        $blob = fn (int $n): string => $this->history() . '/blobs/' . hash('sha256', $media[$n]);
        $index = json_decode((string) file_get_contents($this->history() . '/index.json'), true);
        $mapOfOne = array_column($index['versions'], 'map', 'version')[1];
        file_put_contents($this->history() . '/maps/' . $mapOfOne . '.gz', 'not a map');

        // Said in the list, of that version alone; and it cannot be gone back to.
        $this->assertSame([true, false, false, false], [$this->row(1)['damaged'], $this->row(2)['damaged'], $this->row(3)['damaged'], $this->row(4)['damaged']]);
        $this->assertSame(409, $this->refused(fn () => $this->versions->restore(self::APP, 1, 5, 'ana'))[0]);

        // While it stays, no kept file is removed: its map might name any of them.
        $this->versions->remove(self::APP, 2);
        $this->assertSame([5, 4, 3, 1], $this->numbers());
        $this->assertFileExists($blob(2), 'nothing names it now, and it is kept all the same');
        // Its owner takes it out, and what nothing names goes: its own file, and the one left before.
        $this->assertSame(['version' => 1, 'removed' => true], $this->versions->remove(self::APP, 1));
        $this->assertSame([5, 4, 3], $this->numbers());
        $this->assertEqualsCanonicalizing([hash('sha256', $media[3]), hash('sha256', $media[4])], $this->kept('blobs'));
        $this->assertFileDoesNotExist($this->history() . '/maps/' . $mapOfOne . '.gz');
        $this->assertSame([false, false], [$this->row(3)['damaged'], $this->row(4)['damaged']]);
        // A version one of whose files is gone is damaged too.
        unlink($blob(3));
        $this->assertSame([true, false], [$this->row(3)['damaged'], $this->row(4)['damaged']]);
        $this->assertTrue($this->versions->get(self::APP, 3)['version']['damaged']);
    }

    // ── A history that cannot be written never refuses a publish ─────────────────────────────

    public function testAnAppWhoseHistoryCannotBeStartedIsInstalledAllTheSame(): void
    {
        // Where the history's folder belongs there is a file.
        mkdir($this->root(), 0700, true);
        file_put_contents($this->root() . '/history', 'not a folder');
        $log = $this->logged(fn () => $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]), 0, ['by' => 'ana', 'how' => 'page']));
        $this->assertSame(1, $this->native->get(self::APP)['version']);
        $this->assertStringContainsString('no history was started when version 1 was installed', $log);
        $log = $this->logged(fn () => $this->install(self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG]), 1, ['by' => 'ana', 'how' => 'page']));
        $now = $this->native->get(self::APP);
        $this->assertSame([2, '<h1>Two</h1>'], [$now['version'], $now['files']['index.html']]);
        $this->assertStringContainsString('version 1 was not kept when version 2 was installed', $log);
        $this->assertStringNotContainsString('<h1>', $log);
        $this->assertSame([], $this->leftByAnInstall());
        $this->assertSame('not a folder', file_get_contents($this->root() . '/history'));
        $this->assertSame([2], $this->numbers());
        $this->assertSame([409, 'The app\'s history cannot be changed just now: its folder on the server cannot be written.'], $this->refused(fn () => $this->versions->pin(self::APP, 2, true)));
    }

    public function testAPublishGoesAheadWhenItsHistoryCannotBeWrittenAndTheListSaysWhichVersionWasNotKept(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>']), 0, ['by' => 'ana', 'how' => 'page']);
        $this->install(self::project(['index.html' => '<h1>Two</h1>']), 1, ['by' => 'ben', 'how' => 'page']);
        // The folder the history keeps files in is no longer one (and is one again, when mended).
        $elsewhere = $this->storage . '/blobs.elsewhere';
        $break = function () use ($elsewhere): void { rename($this->history() . '/blobs', $elsewhere); file_put_contents($this->history() . '/blobs', 'x'); };
        $mend = function () use ($elsewhere): void { unlink($this->history() . '/blobs'); rename($elsewhere, $this->history() . '/blobs'); };
        $break();
        $before = $this->historyFiles();

        $three = self::project(['index.html' => '<h1>Three</h1>'], ['assets/logo.png' => self::PNG]);
        $log = $this->logged(fn () => $this->install($three, 2, ['by' => 'cy', 'how' => 'page']));
        $now = $this->native->get(self::APP);
        $this->assertSame([3, $three['files'], $three['assets']], [$now['version'], $now['files'], $now['assets']], 'the publish happened, whole');
        $this->assertSame([], $this->leftByAnInstall(), 'and its journal was settled');
        $this->assertSame($before, $this->historyFiles(), 'the history is as it was');
        $this->assertStringContainsString('version 2 was not kept when version 3 was installed', $log);
        $this->assertStringNotContainsString('<h1>', $log);
        // Said the next time the list is read: version 2 is the one that is missing.
        $this->assertSame([3, 1], $this->numbers());
        $this->assertSame([['from' => 2, 'to' => 2], null, null], [$this->row(3)['gap'], $this->row(3)['by'], $this->row(1)['gap']]);

        // Once the folder is one again, publishing keeps versions as before, and the gap is told on.
        $mend();
        $this->install(self::project(['index.html' => '<h1>Four</h1>'], ['assets/logo.png' => self::PNG]), 3, ['by' => 'dee', 'how' => 'page']);
        $this->assertSame([4, 3, 1], $this->numbers());
        $this->assertSame([null, ['from' => 2, 'to' => 2], null], [$this->row(4)['gap'], $this->row(3)['gap'], $this->row(1)['gap']]);
        $this->assertSame(['dee', null, 'ana'], [$this->row(4)['by'], $this->row(3)['by'], $this->row(1)['by']]);
        $this->assertSame('<h1>Three</h1>', $this->versions->file(self::APP, 3, 'index.html')['text']);
        $this->assertSame('<h1>One</h1>', $this->versions->file(self::APP, 1, 'index.html')['text']);
        // A pin of the current version made while the gap showed keeps the note of it.
        $break();
        $this->logged(fn () => $this->install(self::project(['index.html' => '<h1>Five</h1>']), 4));
        $mend();
        $this->versions->pin(self::APP, 5, true);
        $this->assertSame([['from' => 4, 'to' => 4], true], [$this->row(5)['gap'], $this->row(5)['pinned']]);
        $this->install(self::project(['index.html' => '<h1>Six</h1>']), 5);
        $this->assertSame([6, 5, 3, 1], $this->numbers());
        $this->assertSame([['from' => 4, 'to' => 4], true], [$this->row(5)['gap'], $this->row(5)['pinned']]);
    }

    public function testAnInstallThatFailsWhileItsHistoryCannotBeWrittenStillLeavesTheAppAndTheHistoryAsTheyWere(): void
    {
        $one = self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]);
        $this->install($one, 0, ['by' => 'ana', 'how' => 'page']);
        rmdir($this->history() . '/blobs');
        file_put_contents($this->history() . '/blobs', 'x');
        $before = $this->historyFiles();
        foreach (['config-changed', 'migrated', 'project-written'] as $point) {
            $stopping = new StoppedAtNativeAppService($this->storage, $this->storage . '/no-runtime', $point);
            $stopped = null;
            $this->logged(function () use ($stopping, &$stopped): void {
                $stopped = $this->refused(fn () => $this->install(self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG . '2']), 1, null, $stopping));
            });
            // The install got past its history, and failed where it was told to: not before.
            $this->assertSame('stopped at ' . $point, $stopped[1]);
            $now = $this->native->get(self::APP);
            $this->assertSame([1, $one['files'], $one['assets']], [$now['version'], $now['files'], $now['assets']], $point);
            $this->assertSame([], $this->leftByAnInstall(), $point);
            $this->assertSame($before, $this->historyFiles(), $point);
        }
    }

    /** @return list<array{0: string, 1: string, 2: bool}> */
    public static function terminationsWithAHistoryThatFails(): array
    {
        return [['cannot be written', 'migrated', false], ['cannot be written', 'metadata-promoted', true], ['is not an index', 'migrated', false], ['is not an index', 'metadata-promoted', true]];
    }

    /**
     * A separate PHP process runs the update and exits at the named phase, leaving its journal,
     * while the history cannot be written or its index is not one. Whoever comes next settles the
     * journal as it always does: the app is the old version or the new one, whole, and the history
     * has lost nothing it held.
     */
    #[DataProvider('terminationsWithAHistoryThatFails')]
    public function testADeadInstallIsSettledWithTheAppRightWhateverBecameOfItsHistory(string $fault, string $phase, bool $rolledForward): void
    {
        $two = self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG . '2']);
        $three = self::project(['index.html' => '<h1>Three</h1>'], ['assets/logo.png' => self::PNG . '3']);
        $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG . '1']), 0, ['by' => 'ana', 'how' => 'page']);
        $this->install($two, 1, ['by' => 'ben', 'how' => 'page']);
        $index = $this->history() . '/index.json';
        $cut = substr((string) file_get_contents($index), 0, 60);
        if ($fault === 'is not an index') file_put_contents($index, $cut);
        else { rename($this->history() . '/blobs', $this->storage . '/blobs.elsewhere'); file_put_contents($this->history() . '/blobs', 'x'); }
        $before = $this->historyFiles();

        $script = $this->storage . '/terminate.php';
        file_put_contents($script, '<?php
declare(strict_types=1);
require ' . var_export(dirname(__DIR__, 2) . '/vendor/autoload.php', true) . ';
ini_set("error_log", ' . var_export($this->storage . '/child-error.log', true) . ');
final class TerminatingWithAFailingHistory extends \FormLogic\Services\NativeAppService {
    protected function afterPhase(string $root, string $phase): void { if ($phase === ' . var_export($phase, true) . ') { fwrite(STDOUT, "terminated at " . $phase); exit(0); } }
}
$service = new TerminatingWithAFailingHistory(' . var_export($this->storage, true) . ', ' . var_export($this->storage . '/no-runtime', true) . ');
$service->install("notes", ' . var_export($three, true) . ', 2, null, ["by" => "cy", "how" => "page"]);
fwrite(STDOUT, "completed");
');
        $output = shell_exec(escapeshellarg(PHP_BINARY) . ' -d xdebug.mode=off ' . escapeshellarg($script) . ' 2>&1');
        $this->assertSame('terminated at ' . $phase, trim((string) $output), 'the child process got past its history and died at the requested point');
        $this->assertFileExists($this->root() . '/private/install.json', 'leaving its journal');

        // Reading the history settles it.
        $list = null;
        $this->logged(function () use (&$list): void { $list = $this->versions->list(self::APP); });
        $this->assertSame([], $this->leftByAnInstall(), 'the journal was settled');
        $this->assertSame([], glob($this->history() . '/index.pending-*') ?: []);
        $now = $this->native->get(self::APP);
        $expected = $rolledForward ? $three : $two;
        $this->assertSame([$rolledForward ? 3 : 2, $expected['files'], $expected['assets']], [$now['version'], $now['files'], $now['assets']], 'the app is one version or the other, whole');
        foreach ($before as $path => $hash) {
            if ($path !== 'index.json') $this->assertSame($hash, hash_file('sha256', $this->history() . '/' . $path), $path . ' is as it was');
        }
        $numbers = array_column($list['versions'], 'version');
        if ($fault === 'cannot be written') {
            // Nothing could be laid by, so nothing was: the history is what it was, and says what it lacks.
            $this->assertSame($before, $this->historyFiles());
            $this->assertSame($rolledForward ? [3, 1] : [2, 1], $numbers);
            $this->assertSame($rolledForward ? ['from' => 2, 'to' => 2] : null, $list['versions'][0]['gap']);
            $this->assertStringContainsString('version 2 was not kept when version 3 was installed', (string) file_get_contents($this->storage . '/child-error.log'));
        } elseif ($rolledForward) {
            // The install happened: the index that was not one is set aside, by whoever settled it, and nothing was removed.
            $aside = glob($this->history() . '/damaged-index-*.json') ?: [];
            $this->assertCount(1, $aside);
            $this->assertSame($cut, file_get_contents($aside[0]));
            $this->assertSame([[3, 2], false], [$numbers, $list['unreadable']]);
            $this->assertTrue($list['versions'][1]['startedAgain']);
            $this->assertSame('<h1>Two</h1>', $this->versions->file(self::APP, 2, 'index.html')['text']);
        } else {
            // The install did not happen: the index is the file it was, not set aside and not written over.
            $this->assertSame($cut, file_get_contents($index));
            $this->assertSame([], glob($this->history() . '/damaged-index-*.json') ?: []);
            $this->assertSame([[2], true], [$numbers, $list['unreadable']]);
        }
    }

    // ── Taking a version out ─────────────────────────────────────────────────────────────────

    public function testAnEarlierVersionIsTakenOutOfTheHistoryWithTheContentNothingElseNames(): void
    {
        $shared = random_bytes(2000);
        $x = random_bytes(3000);
        $y = random_bytes(3000);
        $key = 'const KEY = "sk-live-0123456789";';
        $this->install(self::project(['index.html' => '<h1>One</h1>', 'main.js' => $key], ['assets/shared.bin' => $shared, 'assets/a.bin' => $x]), 0, ['by' => 'ana', 'how' => 'page']);
        $this->install(self::project(['index.html' => '<h1>Two</h1>'], ['assets/shared.bin' => $shared, 'assets/a.bin' => $y]), 1);
        $this->install(self::project(['index.html' => '<h1>Three</h1>'], ['assets/shared.bin' => $shared]), 2);
        $this->install(self::project(['index.html' => '<h1>Four</h1>'], ['assets/shared.bin' => $shared]), 3);
        $installed = $this->native->get(self::APP);
        $blob = fn (string $bytes): string => $this->history() . '/blobs/' . hash('sha256', $bytes);
        // Everything the history holds as text, read back: where a removed key would still be found.
        $held = function (): string {
            $all = '';
            foreach ($this->kept('texts') as $name) $all .= gzdecode((string) file_get_contents($this->history() . '/texts/' . $name));
            return $all . file_get_contents($this->history() . '/index.json');
        };
        $this->assertStringContainsString('sk-live-0123456789', $held(), 'the key removed from the app is still in its history');

        // Never the current version, never one that is not kept, and a pinned one only once it is unpinned.
        $this->assertSame([409, 'Version 4 is the app as it is now, so it cannot be removed from the history.'], $this->refused(fn () => $this->versions->remove(self::APP, 4)));
        $this->assertSame([404, 'Version 9 is not kept any more.'], $this->refused(fn () => $this->versions->remove(self::APP, 9)));
        $this->versions->pin(self::APP, 1, true);
        $this->assertSame([409, 'Version 1 is pinned. Unpin it first, then remove it.'], $this->refused(fn () => $this->versions->remove(self::APP, 1)));
        $this->assertSame([4, 3, 2, 1], $this->numbers());
        $this->assertFileExists($blob($x));
        $this->versions->pin(self::APP, 1, false);

        $this->assertSame(['version' => 1, 'removed' => true], $this->versions->remove(self::APP, 1));
        $this->assertSame([4, 3, 2], $this->numbers());
        $this->assertNotKept(1);
        $this->assertSame([404, 'Version 1 is not kept any more.'], $this->refused(fn () => $this->versions->remove(self::APP, 1)));
        // Its own content is gone from the disk; what another kept version names stays.
        $this->assertFileDoesNotExist($blob($x));
        $this->assertFileExists($blob($shared));
        $this->assertFileExists($blob($y));
        $this->assertStringNotContainsString('sk-live-0123456789', $held(), 'the key is nowhere in the history now');
        $this->assertCount(2, $this->kept('texts'));
        // The app as it is installed is not touched, and the versions that stay can be gone back to.
        $this->assertSame($installed, $this->native->get(self::APP));
        $this->versions->remove(self::APP, 2);
        $this->assertFileDoesNotExist($blob($y));
        $this->assertFileExists($blob($shared));
        $this->assertSame(5, $this->versions->restore(self::APP, 3, 4, 'ana')['version']);
        $this->assertSame('<h1>Three</h1>', $this->native->get(self::APP)['files']['index.html']);
    }

    // ── What the manifest lets the app reach and ask for ─────────────────────────────────────

    public function testTheOutsideSitesAndWhatAnAppAsksForAreReadFromItsManifest(): void
    {
        $files = static fn (array $over): array => ['manifest.json' => json_encode(['id' => 'notes', 'main' => 'index.html'] + $over, JSON_UNESCAPED_SLASHES)];
        $this->assertSame([], NativeAppVersions::outsideSites($files([])));
        $this->assertSame([], NativeAppVersions::outsideSites(['manifest.json' => 'not json']));
        $this->assertSame(['https://api.example.com'], NativeAppVersions::outsideSites($files(['site' => ['entry' => 'index.html', 'outside' => ['https://api.example.com']]])));

        $nothing = ['backend' => [], 'ai' => null, 'payments' => null, 'phoneCodes' => null];
        $this->assertSame($nothing, NativeAppVersions::asksFor($files([])));
        $this->assertSame($nothing, NativeAppVersions::asksFor([]));
        $this->assertSame($nothing, NativeAppVersions::asksFor($files(['server' => 'not a block', 'config' => ['app' => 'nor this']])));
        $server = static fn (array $capabilities): array => ['server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => $capabilities]]];
        $this->assertSame(['sql', 'time'], NativeAppVersions::asksFor($files($server(['time', 'sql', 'time'])))['backend'], 'what the backend may use, in order, each once');
        $payments = ['purpose' => 'Pay to download.', 'items' => [['id' => 'download', 'label' => 'Download', 'priceCents' => 5]], 'routes' => ['/api/download']];
        $asked = NativeAppVersions::asksFor($files(['formlogicPayments' => $payments, 'config' => ['app' => ['verificationProvider' => 'twilio-verify']]]));
        $this->assertSame(['twilio-verify', 5], [$asked['phoneCodes'], $asked['payments']['items'][0]['priceCents']]);
        // The same thing said in another order is the same thing asked.
        $this->assertSame($asked, NativeAppVersions::asksFor($files(['config' => ['app' => ['verificationProvider' => 'twilio-verify']], 'formlogicPayments' => array_reverse($payments, true)])));
        $dearer = $payments;
        $dearer['items'][0]['priceCents'] = 500;
        $this->assertNotSame($asked, NativeAppVersions::asksFor($files(['formlogicPayments' => $dearer, 'config' => ['app' => ['verificationProvider' => 'twilio-verify']]])));
    }

    public function testAChangeToTheOutsideSitesOrToWhatTheAppAsksForIsSaidOfTheVersionThatMadeIt(): void
    {
        // A JavaScript app: a built site, and a manifest that says which other sites its pages may reach.
        $site = static function (array $outside, array $more = []): array {
            $manifest = ['id' => 'notes', 'name' => 'Notes', 'site' => ['entry' => 'index.html'] + ($outside === [] ? [] : ['outside' => $outside])] + $more;
            return self::project(['manifest.json' => json_encode($manifest, JSON_UNESCAPED_SLASHES)], ['site/index.html' => '<h1>Site</h1>']);
        };
        $phone = ['config' => ['app' => ['verificationProvider' => 'twilio-verify']]];
        $this->install($site([]), 0, ['by' => 'ana', 'how' => 'upload']);
        // An AI client gives the app a site to reach. It is one changed file, and it is said for what it is.
        $this->install($site(['https://api.example.com']), 1, ['by' => 'ana', 'how' => 'mcp']);
        $changes = $this->row(2)['changes'];
        $this->assertSame([1, true, false], [$changes['changed'], $changes['outside'], $changes['asks']]);
        $this->install($site(['https://api.example.com'], $phone), 2, ['by' => 'ana', 'how' => 'mcp']);
        $changes = $this->row(3)['changes'];
        $this->assertSame([1, false, true], [$changes['changed'], $changes['outside'], $changes['asks']]);
        // A change to the manifest that is neither says neither.
        $this->install($site(['https://api.example.com'], $phone + ['description' => 'Notes, kept.']), 3, ['by' => 'ana', 'how' => 'page']);
        $changes = $this->row(4)['changes'];
        $this->assertSame([1, false, false], [$changes['changed'], $changes['outside'], $changes['asks']]);

        // One version against the app as it is: whether they differ in either, and the sites of each.
        $one = $this->versions->get(self::APP, 1);
        $this->assertSame([true, true], [$one['differs']['outside'], $one['differs']['asks']]);
        $this->assertSame(['version' => [], 'now' => ['https://api.example.com']], $one['outside']);
        $three = $this->versions->get(self::APP, 3);
        $this->assertSame([false, false], [$three['differs']['outside'], $three['differs']['asks']]);
        $this->assertSame(['version' => ['https://api.example.com'], 'now' => ['https://api.example.com']], $three['outside']);

        // Going back brings the version's manifest back, and with it what it reached and asked for: said of the new version.
        $this->install($site([], $phone), 4, ['by' => 'ana', 'how' => 'page']);
        $this->versions->restore(self::APP, 2, 5, 'ana');
        $now = $this->native->get(self::APP)['files'];
        $this->assertSame(['https://api.example.com'], NativeAppVersions::outsideSites($now));
        $this->assertNull(NativeAppVersions::asksFor($now)['phoneCodes']);
        $changes = $this->row(6)['changes'];
        $this->assertSame([true, true], [$changes['outside'], $changes['asks']]);
    }

    // ── Media that did not change is not hashed again, and nothing is taken on trust ─────────

    public function testUnchangedMediaIsNamedByItsBytesHoweverManyInstallsCarryItOn(): void
    {
        $media = ['assets/a.bin' => random_bytes(5000), 'assets/b.bin' => random_bytes(100), 'assets/c.bin' => random_bytes(1)];
        $named = static fn (array $media): string => hash('sha256', (string) json_encode(array_map(static fn (string $bytes): array => [hash('sha256', $bytes), strlen($bytes)], $media), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        for ($n = 1; $n <= 4; $n++) $this->install(self::project(['index.html' => "<h1>{$n}</h1>"], $media), $n - 1);
        $first = $media;
        // One file changes, to other bytes of the same size; the others are carried on untouched.
        $media['assets/b.bin'] = random_bytes(100);
        $this->install(self::project(['index.html' => '<h1>5</h1>'], $media), 4);
        $this->install(self::project(['index.html' => '<h1>6</h1>'], $media), 5);
        $index = json_decode((string) file_get_contents($this->history() . '/index.json'), true);
        $maps = array_column($index['versions'], 'map', 'version');
        $this->assertSame([$named($media), $named($media), $named($first), $named($first)], [$index['head']['map'], $maps[5], $maps[4], $maps[1]]);
        foreach ($this->kept('blobs') as $name) $this->assertSame($name, hash_file('sha256', $this->history() . '/blobs/' . $name));
        $this->assertCount(4, $this->kept('blobs'), 'three files, and the one that changed');
        $this->versions->restore(self::APP, 4, 6, 'ana');
        $this->assertSame(array_map('base64_encode', $first), $this->native->get(self::APP)['assets']);
    }

    public function testARecordIsTakenForTheInstalledProjectOnlyWhereItIsThatVeryProject(): void
    {
        $x = random_bytes(3000);
        $y = random_bytes(3000);
        $other = random_bytes(3000);
        $this->install(self::project(['index.html' => '1'], ['assets/a.bin' => $x]), 0, ['by' => 'ana', 'how' => 'page']);
        $this->install(self::project(['index.html' => '2'], ['assets/a.bin' => $y]), 1, ['by' => 'ben', 'how' => 'page']);
        // The installed project's media is changed behind the history's back, as a hand on the
        // server might: the same version number, the same source, a file of the same size.
        $file = $this->root() . '/project.json';
        $project = json_decode((string) file_get_contents($file), true);
        $project['assets']['assets/a.bin'] = base64_encode($other);
        file_put_contents($file, json_encode($project));

        $this->install(self::project(['index.html' => '3'], ['assets/a.bin' => $y]), 2, ['by' => 'cy', 'how' => 'page']);
        // The record written for version 2 was not this project's, so nothing of it was taken on
        // trust: what is kept as version 2 is what was there, hashed, with no one known to have made it.
        $this->assertSame([3, 2, 1], $this->numbers());
        $this->assertSame([null, 'cy'], [$this->row(2)['by'], $this->row(3)['by']]);
        foreach ($this->kept('blobs') as $name) $this->assertSame($name, hash_file('sha256', $this->history() . '/blobs/' . $name));
        $this->assertContains(hash('sha256', $other), $this->kept('blobs'));
        $this->versions->restore(self::APP, 2, 3, 'ana');
        $this->assertSame(base64_encode($other), $this->native->get(self::APP)['assets']['assets/a.bin']);
        // And the file version 3 held is its own, not taken for the one that stood at its path before it.
        $this->versions->restore(self::APP, 3, 4, 'ana');
        $this->assertSame(base64_encode($y), $this->native->get(self::APP)['assets']['assets/a.bin']);
    }

    // ── Removing, backing up ─────────────────────────────────────────────────────────────────

    public function testRemovingTheAppRemovesItsHistoryAndABackupCarriesNone(): void
    {
        $this->install(self::project(['index.html' => '<h1>One</h1>'], ['assets/logo.png' => self::PNG]), 0);
        $this->install(self::project(['index.html' => '<h1>Two</h1>'], ['assets/logo.png' => self::PNG . '2']), 1);
        $this->versions->pin(self::APP, 1, true);
        $this->assertNotSame([], $this->kept('blobs'));

        // What a backup captures is the project as it is: the versions before it are not in it.
        $captured = $this->native->captureForBackup(self::APP, $this->storage . '/snapshot.sqlite');
        $this->assertEqualsCanonicalizing(['files', 'assets', 'version', 'home', 'access'], array_keys($captured['project']));

        $this->native->remove(self::APP);
        $this->assertDirectoryDoesNotExist($this->root(), 'the history went with the app\'s folder');

        // Restored from that backup, the app starts a history of its own.
        $this->native->restore(self::APP, $captured['project'], null, null);
        $this->assertDirectoryDoesNotExist($this->history());
        $this->assertSame([2], $this->numbers());
        $this->install(self::project(['index.html' => '<h1>Three</h1>']), 2);
        $this->assertSame([3, 2], $this->numbers());
    }
}

/** An install that stops, with an exception, once the named phase or step is reached. */
final class StoppedAtNativeAppService extends NativeAppService
{
    public function __construct(?string $storage, ?string $runtime, private string $point)
    {
        parent::__construct($storage, $runtime);
    }

    protected function afterPhase(string $root, string $phase): void
    {
        if ($phase === $this->point) throw new \RuntimeException('stopped at ' . $phase);
    }

    protected function afterStep(string $root, string $step): void
    {
        if ($step === $this->point) throw new \RuntimeException('stopped at ' . $step);
    }
}

/**
 * An install that calls back when a named phase or step is reached, for a test to change what is
 * on disk part-way: `backups-written` is the step just before the history's record is prepared,
 * and `config-changed` the phase just after it.
 */
final class WatchedNativeAppService extends NativeAppService
{
    /** @param array<string, callable(): void> $at */
    public function __construct(?string $storage, ?string $runtime, private array $at)
    {
        parent::__construct($storage, $runtime);
    }

    protected function afterPhase(string $root, string $phase): void
    {
        if (isset($this->at[$phase])) ($this->at[$phase])();
    }

    protected function afterStep(string $root, string $step): void
    {
        if (isset($this->at[$step])) ($this->at[$step])();
    }
}
