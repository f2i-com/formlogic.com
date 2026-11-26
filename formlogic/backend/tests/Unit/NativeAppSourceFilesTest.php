<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;

/**
 * Which files a SoftN app is made of here (NativeAppService::validateProject), and what a refusal
 * says. SoftN has written an app's pages as .html and their logic as .js, with .css beside them,
 * since its HTML pages (.ui and .logic before): the host keeps both spellings. Whoever sent a
 * project that is refused, a person or an AI, has only the refusal's words to go on.
 */
final class NativeAppSourceFilesTest extends TestCase
{
    private static function manifest(array $over = []): string
    {
        return json_encode($over + ['name' => 'Notes', 'version' => '1.0.0', 'main' => 'index.html'], JSON_THROW_ON_ERROR);
    }

    public function testAnAppWrittenAsHtmlPagesWithScriptsAndAStylesheetIsKept(): void
    {
        $files = [
            'manifest.json' => self::manifest(['files' => ['ui' => ['index.html', 'pages/about.html'], 'logic' => ['main.js']]]),
            'index.html' => "<script src=\"main.js\"></script>\n<link rel=\"stylesheet\" href=\"styles.css\">\n<App><Text>{greeting}</Text></App>",
            'pages/about.html' => '<App><Text>About</Text></App>',
            'main.js' => 'let greeting = "hello"',
            'styles.css' => '.card { padding: 1rem }',
            'xdb/tasks.xdb' => '{"collection":"tasks","records":[]}',
        ];
        [$kept, $media, $manifest, $capabilities] = NativeAppService::validateProject(['files' => $files, 'assets' => []]);
        $this->assertSame($files, $kept);
        $this->assertSame([], $media);
        $this->assertSame('index.html', $manifest['main']);
        $this->assertSame([], $capabilities);
        // The page's frame is handed every one of them; nothing of a backend is among them.
        $this->assertSame(array_keys($files), array_keys(NativeAppService::clientFiles(['files' => $files])));
    }

    public function testTheSpellingsFromBeforeAreKeptAsTheyWere(): void
    {
        $files = ['manifest.json' => self::manifest(['main' => 'ui/main.ui']), 'ui/main.ui' => '<App/>', 'logic/main.logic' => 'var a = 1', 'logic/counter.py' => 'count = 0'];
        $this->assertSame($files, NativeAppService::validateProject(['files' => $files])[0]);
    }

    public function testMigrationDeclarationsAreListsOfDistinctProjectFiles(): void
    {
        $path = 'server/migrations/001.sql';
        $server = ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'routes' => []];
        $files = ['index.html' => '<h1>Notes</h1>', 'server/main.logic' => '', $path => 'CREATE TABLE notes(id INTEGER PRIMARY KEY)'];
        foreach ([
            [$path, 'must be a list'], [(object) [0 => $path], 'must be a list'], [(object) [], 'must be a list'],
            [[$path, $path], 'is listed more than once'], [[null], 'must name an existing SQL file'],
            [['server/migrations/002.sql'], 'server/migrations/002.sql is listed'],
        ] as [$listed, $problem]) {
            $files['manifest.json'] = self::manifest(['server' => $server + ['database' => ['kind' => 'private-sqlite', 'migrations' => $listed]]]);
            try { NativeAppService::validateProject(['files' => $files]); $this->fail('Invalid migrations were accepted'); }
            catch (\InvalidArgumentException $refused) { $this->assertStringContainsString($problem, $refused->getMessage()); }
        }
        foreach ([[], ['migrations' => null], ['migrations' => []], ['migrations' => [$path]]] as $valid) {
            $files['manifest.json'] = self::manifest(['server' => $server + ['database' => ['kind' => 'private-sqlite'] + $valid]]);
            $this->assertSame($files, NativeAppService::validateProject(['files' => $files])[0]);
        }
    }

    public function testABackendStaysDotLogicAndOutOfThePage(): void
    {
        $server = ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']], 'routes' => []];
        $files = ['manifest.json' => self::manifest(['server' => $server]), 'index.html' => '<App/>', 'main.js' => 'let a = 1', 'server/main.logic' => 'function a(req) {}', 'server/migrations/001.sql' => 'CREATE TABLE items(id INTEGER PRIMARY KEY);'];
        $this->assertSame(['sql'], NativeAppService::validateProject(['files' => $files])[3]);
        $this->assertSame(['manifest.json', 'index.html', 'main.js'], array_keys(NativeAppService::clientFiles(['files' => $files])));
        // A backend's entry is not a .js file: this host runs server/….logic.
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('.logic entry');
        NativeAppService::validateProject(['files' => ['manifest.json' => self::manifest(['server' => ['entry' => 'server/main.js'] + $server]), 'index.html' => '<App/>', 'server/main.js' => 'function a(req) {}', 'server/migrations/001.sql' => 'CREATE TABLE items(id INTEGER PRIMARY KEY);']]);
    }

    public function testAContainerBackendKeptOutsideTheUsualFoldersStaysOutOfThePage(): void
    {
        $manifest = [
            'engine' => 2,
            'backend' => ['runtime' => 'javascript', 'entry' => 'api/handler.js', 'root' => 'api', 'routes' => ['/api/']],
            'databases' => [['name' => 'app', 'engine' => 'sqlite', 'file' => 'data/app.db', 'seedSql' => 'data/schema.sql', 'seedJson' => 'data/Starter.json']],
            'files' => ['logic' => ['main.js', 'api/handler.js', 'data/starter.json']],
        ];
        $files = [
            'manifest.json' => self::manifest($manifest),
            'index.html' => '<h1>Orders</h1>',
            'main.js' => 'let a = 1',
            // Not under the root: a name that only begins the same way is the page's own.
            'apiClient.js' => 'export const base = "/api/"',
            'api/handler.js' => 'export default async () => new Response("secret")',
            'api/lib/keys.js' => 'export const signingKey = "k"',
            'data/schema.sql' => 'CREATE TABLE items(id INTEGER PRIMARY KEY);',
            'data/starter.json' => '{"items":[{"id":1}]}',
            'data/labels.json' => '{"title":"Orders"}',
            'migrations/notes.json' => '{"applied":[]}',
            'config/seed.json' => '{"items":[]}',
        ];
        NativeAppService::validateProject(['files' => $files]);
        $client = NativeAppService::clientFiles(['files' => $files]);
        $this->assertSame(['manifest.json', 'index.html', 'main.js', 'apiClient.js', 'data/labels.json'], array_keys($client));
        $sent = json_decode($client['manifest.json'], true, 64, JSON_THROW_ON_ERROR);
        $this->assertSame(['runtime' => 'javascript', 'routes' => ['/api/']], $sent['backend']);
        $this->assertArrayNotHasKey('databases', $sent);
        $this->assertSame(['main.js'], $sent['files']['logic']);

        // The entry alone is private where no root is declared, whatever case the manifest names it in.
        $manifest['backend'] = ['runtime' => 'javascript', 'entry' => 'handler.js'];
        unset($manifest['databases'], $manifest['files']);
        $loose = ['manifest.json' => self::manifest($manifest), 'index.html' => '<h1>Orders</h1>', 'handler.js' => 'export default 1', 'main.js' => 'let a = 1'];
        $this->assertSame(['manifest.json', 'index.html', 'main.js'], array_keys(NativeAppService::clientFiles(['files' => $loose])));

        // With no backend declared, none of this applies: the same names are a page's own files.
        $plain = ['manifest.json' => self::manifest(), 'index.html' => '<App/>', 'api/handler.js' => 'let a = 1', 'config/seed.json' => '{}', 'migrations/notes.json' => '{}'];
        $this->assertSame(array_keys($plain), array_keys(NativeAppService::clientFiles(['files' => $plain])));
    }

    /**
     * A backend that declares no root lives in the folder its entry is kept in, as SoftN's own host
     * takes it (softn-host-rust): what sits beside the entry is the backend's, and no page is sent
     * it. `api/lib/keys.js` beside `api/handler.js` was sent to every visitor.
     */
    public function testWithNoRootDeclaredTheFolderOfAContainerBackendsEntryStaysOutOfThePage(): void
    {
        $page = ['index.html' => '<h1>Orders</h1>', 'main.js' => 'let a = 1'];
        $client = static function (array $backend, array $files, array $manifest = []) use ($page): array {
            $all = ['manifest.json' => self::manifest(['engine' => 2, 'backend' => ['runtime' => 'javascript'] + $backend] + $manifest)] + $page + array_fill_keys($files, 'export const k = 1');
            NativeAppService::validateProject(['files' => $all]);
            return array_values(array_diff(array_keys(NativeAppService::clientFiles(['files' => $all])), ['manifest.json', 'index.html', 'main.js']));
        };

        // Beside the entry and below it; a name that only begins the same way is the page's own.
        $this->assertSame(['apiClient.js', 'api2/client.js'], $client(['entry' => 'api/handler.js'], ['api/handler.js', 'api/keys.js', 'api/lib/keys.js', 'api/config.json', 'apiClient.js', 'api2/client.js']));
        // The folder the entry is in, not the first one of its path.
        $this->assertSame(['src/app.js', 'src/shared/format.js'], $client(['entry' => 'src/api/main.js'], ['src/api/main.js', 'src/api/db.js', 'src/app.js', 'src/shared/format.js']));
        // In whatever case the manifest and the files are written.
        $this->assertSame([], $client(['entry' => 'Api/Handler.js'], ['Api/Handler.js', 'Api/Lib/Keys.js']));
        // The manifest's own lists name none of it either.
        $all = ['manifest.json' => self::manifest(['engine' => 2, 'backend' => ['runtime' => 'javascript', 'entry' => 'api/handler.js'], 'files' => ['logic' => ['main.js', 'api/keys.js']]])] + $page + ['api/handler.js' => '', 'api/keys.js' => ''];
        $this->assertSame(['main.js'], json_decode(NativeAppService::clientFiles(['files' => $all])['manifest.json'], true)['files']['logic']);

        // The entry alone where hiding its folder would hide the app: at the top of the project,
        // in the manifest's frontendRoot, or in a folder named for what a page loads.
        $this->assertSame(['helper.js'], $client(['entry' => 'handler.js'], ['handler.js', 'helper.js']));
        $this->assertSame(['web/app.js'], $client(['entry' => 'web/handler.js'], ['web/handler.js', 'web/app.js'], ['frontendRoot' => '/Web/']));
        foreach (['public', 'assets', 'static', 'js', 'css'] as $folder) {
            $this->assertSame(["$folder/app.js"], $client(['entry' => "$folder/handler.js"], ["$folder/handler.js", "$folder/app.js"]), $folder);
        }
        // A folder inside one of those is the backend's again.
        $this->assertSame(['public/app.js'], $client(['entry' => 'public/api/handler.js'], ['public/api/handler.js', 'public/api/keys.js', 'public/app.js']));

        // A declared root is the whole answer: page files beside the entry are the page's.
        $this->assertSame(['app/page.js'], $client(['entry' => 'app/handler.js', 'root' => 'app/server'], ['app/handler.js', 'app/page.js', 'app/server/keys.js']));
    }

    /**
     * SoftN reads a backend's `runtime` and `entry`. This host once took `engine` and `entrypoint`
     * in their place: the runner did not, so such an app passed here, was refused as it was
     * installed for a capability it never asked for, and would run on no other SoftN host. It is
     * refused by the name to write; a project already kept with one is still read as a backend.
     */
    public function testABackendIsNamedAsSoftnNamesIt(): void
    {
        $files = static fn (array $backend): array => ['manifest.json' => self::manifest(['engine' => 2, 'backend' => $backend]), 'index.html' => '<h1>Orders</h1>', 'api/handler.js' => 'export default 1', 'api/keys.js' => 'export const k = 1', 'ui/app.js' => 'let a = 1'];
        $refused = static function (array $backend) use ($files): string {
            try { NativeAppService::validateProject(['files' => $files($backend)]); }
            catch (\InvalidArgumentException $e) { return $e->getMessage(); }
            return 'kept';
        };
        $runtime = 'manifest.json\'s backend names its runtime as "engine", which SoftN does not read, so the app would run on no SoftN host. Rename "engine" to "runtime".';
        $entry = 'manifest.json\'s backend names its entry as "entrypoint", which SoftN does not read, so the app would run on no SoftN host. Rename "entrypoint" to "entry".';
        $this->assertSame($runtime, $refused(['engine' => 'javascript', 'entrypoint' => 'api/handler.js']));
        $this->assertSame($runtime, $refused(['engine' => 'javascript', 'entry' => 'api/handler.js']));
        $this->assertSame($entry, $refused(['runtime' => 'javascript', 'entrypoint' => 'api/handler.js']));
        // A Python backend spelled so is told the same, not that Python is for pages.
        $python = ['manifest.json' => self::manifest(['engine' => 2, 'backend' => ['engine' => 'python', 'entry' => 'backend/main.py']]), 'index.html' => '<h1>Orders</h1>', 'backend/main.py' => 'def handle(req): pass'];
        try { NativeAppService::validateProject(['files' => $python]); $this->fail('kept'); }
        catch (\InvalidArgumentException $e) { $this->assertSame($runtime, $e->getMessage()); }
        // SoftN's own names are what is read; another key beside them is one more it does not read.
        $this->assertSame('kept', $refused(['runtime' => 'javascript', 'entry' => 'api/handler.js']));
        $this->assertSame('kept', $refused(['runtime' => 'javascript', 'entry' => 'api/handler.js', 'engine' => 'cobol', 'entrypoint' => 'missing.js']));

        // A project kept from before with those names is a backend still: its files stay off the page.
        $kept = ['files' => $files(['engine' => 'javascript', 'entrypoint' => 'api/handler.js'])];
        $this->assertTrue(NativeAppService::hasContainerBackend($kept));
        $client = NativeAppService::clientFiles($kept);
        $this->assertSame(['manifest.json', 'index.html', 'ui/app.js'], array_keys($client));
        $this->assertSame(['runtime' => 'javascript'], json_decode($client['manifest.json'], true)['backend']);
    }

    private static function phpApp(array $files, array $manifest = []): array
    {
        return ['manifest.json' => self::manifest($manifest + ['engine' => 2, 'backend' => ['runtime' => 'php', 'entry' => 'index.php']]), 'index.html' => '<h1>Shop</h1>', 'index.php' => '<?php echo 1;'] + $files;
    }

    /**
     * An app with a container backend keeps its `.htaccess` files: its author's rules for who may ask
     * for its files, which SoftN's hosts apply. Dropped at import, as they were, what they protected
     * was protected by nothing. No page is ever sent one.
     */
    public function testAContainerBackendsHtaccessFilesAreKeptAndNeverSentToAPage(): void
    {
        $files = self::phpApp(['.htaccess' => "Options -Indexes\n", 'includes/.htaccess' => "Require all denied\n", 'includes/config.php' => '<?php $k = 1;', 'app.js' => 'let a = 1']);
        $this->assertSame($files, NativeAppService::validateProject(['files' => $files])[0]);
        $this->assertSame(['manifest.json', 'index.html', 'app.js'], array_keys(NativeAppService::clientFiles(['files' => $files])));
        // Whatever the manifest lists, a page is not told of one either.
        $listed = self::phpApp(['.htaccess' => '', 'app.js' => ''], ['files' => ['logic' => ['app.js', '.htaccess']]]);
        $this->assertSame(['app.js'], json_decode(NativeAppService::clientFiles(['files' => $listed])['manifest.json'], true)['files']['logic']);

        $refused = static function (array $files): string {
            try { NativeAppService::validateProject(['files' => $files]); }
            catch (\InvalidArgumentException $e) { return $e->getMessage(); }
            return 'kept';
        };
        // The runner reads none of one over 64 KB: refused, not kept and ignored.
        $this->assertSame('kept', $refused(self::phpApp(['.htaccess' => str_repeat('#', NativeAppService::MAX_HTACCESS_BYTES)])));
        $this->assertSame('conf/.htaccess is larger than this host reads of an .htaccess (64 KB), so none of its rules would be applied. Shorten it.', $refused(self::phpApp(['conf/.htaccess' => str_repeat('#', NativeAppService::MAX_HTACCESS_BYTES + 1)])));
        // Nothing reads one for an app with no container backend, so it is not kept as if something did.
        $plain = ['manifest.json' => self::manifest(), 'index.html' => '<App/>', 'docs/.htaccess' => 'Require all denied'];
        $this->assertStringStartsWith('docs/.htaccess: this host applies an .htaccess only for an app with a container backend', $refused($plain));
        // It is its author's rules and nothing else: not a backend's entry, and no other dotfile is kept.
        $this->assertSame('manifest.json\'s backend.entry must name an existing file in the project.', $refused(self::phpApp(['.htaccess' => ''], ['backend' => ['runtime' => 'php', 'entry' => '.htaccess']])));
        foreach (['.env', '.htpasswd', 'conf/.htaccess.bak', 'my folder/.htaccess'] as $other) {
            $this->assertStringStartsWith('Invalid app source file', $refused(self::phpApp([$other => 'x'])), $other);
        }
    }

    /**
     * `backend.root` is a folder of the project, held to the rule the importer holds it to. Pages are
     * kept from what is under it while the runner refuses to run scripts there, and the runner
     * collapses "..": a root such as `a/../api` kept different files private on each side.
     */
    public function testABackendRootIsAFolderOfTheProject(): void
    {
        $refused = static function (mixed $root): string {
            try { NativeAppService::validateProject(['files' => self::phpApp(['api/handler.php' => '<?php echo 1;'], ['backend' => ['runtime' => 'php', 'entry' => 'index.php', 'root' => $root]])]); }
            catch (\InvalidArgumentException $e) { return $e->getMessage(); }
            return 'kept';
        };
        foreach (['api', 'api/', 'server/api', 'my-api_2', '', null] as $root) {
            $this->assertSame('kept', $refused($root), var_export($root, true));
        }
        foreach (['a/../api', '../api', './api', '/api', 'C:/api', 'api\\v1', '.hidden', 'my api', str_repeat('a', 241), 7, ['api']] as $root) {
            $this->assertStringStartsWith('manifest.json\'s backend.root must name a folder in the project', $refused($root), var_export($root, true));
        }
    }

    /** An archive read on the server (a marketplace listing, a pack) keeps them by the same rule. */
    public function testAnArchiveReadOnTheServerKeepsAContainerBackendsHtaccessFiles(): void
    {
        if (!class_exists(\ZipArchive::class)) $this->markTestSkipped('ZipArchive is not installed.');
        $archive = static function (array $files): array {
            $path = tempnam(sys_get_temp_dir(), 'fl-htaccess-');
            $zip = new \ZipArchive();
            $zip->open($path, \ZipArchive::OVERWRITE);
            foreach ($files as $name => $text) $zip->addFromString($name, $text);
            $zip->close();
            try { return NativeAppService::extractProjectFromArchive($path)['files']; }
            finally { @unlink($path); }
        };
        $rules = ['.htaccess' => "Options -Indexes\n", 'includes/.htaccess' => "Require all denied\n"];
        $this->assertSame(self::phpApp($rules), $archive(self::phpApp($rules)));
        // The one a static package carries for the server it was made for is left out, as it always was.
        $plain = ['manifest.json' => self::manifest(), 'index.html' => '<App/>'];
        $this->assertSame($plain, $archive($plain + ['.htaccess' => "Options -Indexes\n"]));
    }

    /**
     * What an `.htaccess` denies is not sent to a page. SoftN's hosts answer 403 when such a file is
     * asked for; here a page is handed the app's files, so one that is denied is not among them.
     * Read as those hosts read one: a deny for the folder, or for the files a block names.
     */
    public function testWhatAnHtaccessDeniesIsNotSentToAPage(): void
    {
        $sent = static function (array $rules, array $files): array {
            $all = self::phpApp($rules + array_fill_keys($files, '{}'));
            NativeAppService::validateProject(['files' => $all]);
            return array_values(array_diff(array_keys(NativeAppService::clientFiles(['files' => $all])), ['manifest.json', 'index.html']));
        };
        $files = ['data/customers.json', 'data/archive/2025.json', 'database.json', 'conf/keys.json', 'conf/theme.css', 'drafts/draft-a.json', 'drafts/final.json', 'app.js', 'secrets.json', 'conf/secrets.json'];

        // A folder denied whole, with everything under it; a name that only begins the same way is another file.
        $this->assertSame(['database.json', 'conf/keys.json', 'conf/theme.css', 'drafts/draft-a.json', 'drafts/final.json', 'app.js', 'secrets.json', 'conf/secrets.json'], $sent(['data/.htaccess' => "# customer records\r\nRequire all denied\r\n"], $files));
        $this->assertSame(['data/customers.json', 'data/archive/2025.json', 'database.json', 'drafts/draft-a.json', 'drafts/final.json', 'app.js', 'secrets.json'], $sent(['conf/.htaccess' => "<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n</IfModule>\n"], $files));
        // Files named by a block, in that folder and below: by a wildcard name, and by a pattern.
        $this->assertSame(['data/customers.json', 'data/archive/2025.json', 'database.json', 'conf/keys.json', 'conf/theme.css', 'drafts/draft-a.json', 'drafts/final.json', 'app.js'], $sent(['.htaccess' => "<Files \"Secrets.json\">\n  Require all denied\n</Files>\n"], $files));
        $this->assertSame(['data/customers.json', 'data/archive/2025.json', 'database.json', 'conf/theme.css', 'drafts/draft-a.json', 'drafts/final.json', 'app.js', 'secrets.json'], $sent(['conf/.htaccess' => "<FilesMatch \"\\.(json|bak)$\">\n  Deny from all\n</FilesMatch>\n"], $files));
        $this->assertSame(['data/customers.json', 'data/archive/2025.json', 'database.json', 'conf/keys.json', 'conf/theme.css', 'drafts/final.json', 'app.js', 'secrets.json', 'conf/secrets.json'], $sent(['drafts/.htaccess' => "<Files ~ \"^draft-\">\nRequire all denied\n</Files>\n"], $files));
        $this->assertSame(['conf/theme.css', 'app.js'], $sent(['.htaccess' => "<Files *.json>\nRequire all denied\n</Files>\n"], $files));

        // What is not a deny for everyone denies nothing: a rule for some methods, a condition
        // nobody here evaluates, a block that grants, a pattern that cannot be read, a rewrite.
        foreach ([
            "<Limit POST PUT>\n  Require all denied\n</Limit>\n",
            "<LimitExcept GET>\nDeny from all\n</LimitExcept>\n",
            "<If \"%{HTTP_HOST} == 'old.example'\">\nRequire all denied\n</If>\n<Else>\nRequire all denied\n</Else>\n",
            "<Files \"*.json\">\n  Require all granted\n</Files>\n",
            "<FilesMatch \"(json\">\n  Require all denied\n</FilesMatch>\n",
            "<FilesMatch \"" . str_repeat('a', 257) . "\">\n  Require all denied\n</FilesMatch>\n",
            "# Require all denied\nOptions -Indexes\nRewriteEngine On\nRewriteRule ^data/ - [F]\n",
        ] as $rules) {
            $this->assertSame($files, $sent(['.htaccess' => $rules], $files), $rules);
        }
    }

    /** @dataProvider otherKinds */
    public function testAFileOfAnotherKindIsRefusedWithWhatAnAppIsMadeOf(string $path): void
    {
        try {
            NativeAppService::validateProject(['files' => ['manifest.json' => self::manifest(), 'index.html' => '<App/>', $path => 'x']]);
            $this->fail('kept ' . $path);
        } catch (\InvalidArgumentException $e) {
            $this->assertStringStartsWith('Invalid app source file: ' . $path . '.', $e->getMessage());
            $this->assertStringContainsString('.html or .ui pages', $e->getMessage());
            $this->assertStringContainsString('assets/', $e->getMessage());
        }
    }

    /** @return iterable<string, array{0: string}> */
    public static function otherKinds(): iterable
    {
        // The case and the spelling SoftN writes, and nothing beside them: no other script, no module, no binary.
        foreach (['index.htm', 'main.JS', 'styles.scss', 'logic/code.wasm', 'page.HTML', 'notes.txt', 'logo.svg'] as $path) yield $path => [$path];
    }

    public function testANameWithTwoDotsTogetherOrOtherCharactersIsRefusedByName(): void
    {
        foreach (['pages/../index.html' => 'two dots together', 'my page.html' => null, 'ui/héllo.ui' => null] as $path => $said) {
            try {
                NativeAppService::validateProject(['files' => ['manifest.json' => self::manifest(), 'index.html' => '<App/>', $path => '<App/>']]);
                $this->fail('kept ' . $path);
            } catch (\InvalidArgumentException $e) {
                $this->assertStringStartsWith('Invalid app source file', $e->getMessage());
                if ($said !== null) $this->assertStringContainsString($said, $e->getMessage());
            }
        }
    }

    public function testAnIdIsKeptUpToTheLengthFormLogicsOwnExportGivesOne(): void
    {
        // The editable copy of a form app: `formlogic_` and the hex of its origin, kind and app id.
        $exported = 'formlogic_' . bin2hex('https://forms.example.com/app/0b5e7c1a-6f0e-4d59-9a53-2f8c1d3e4a6b');
        $this->assertGreaterThan(120, strlen($exported));
        foreach ([$exported, str_repeat('a', NativeAppService::MAX_MANIFEST_ID)] as $id) {
            $this->assertSame($id, NativeAppService::validateProject(['files' => ['manifest.json' => self::manifest(['id' => $id]), 'index.html' => '<App/>']])[2]['id']);
        }
        try {
            NativeAppService::validateProject(['files' => ['manifest.json' => self::manifest(['id' => str_repeat('a', NativeAppService::MAX_MANIFEST_ID + 1)]), 'index.html' => '<App/>']]);
            $this->fail('kept an id of 257 characters');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('up to 256 of them', $e->getMessage());
        }
        // A server block's keys are named after the id, and the runner holds that name to 128 characters.
        $server = ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'database' => ['kind' => 'private-sqlite'], 'routes' => []];
        $files = ['index.html' => '<App/>', 'server/main.logic' => 'function a(req) {}'];
        $longest = str_repeat('a', NativeAppService::MAX_BACKEND_IDENTITY);
        $this->assertSame($longest, NativeAppService::validateProject(['files' => ['manifest.json' => self::manifest(['id' => $longest, 'server' => $server])] + $files])[2]['id']);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('longer than an app with a server block can run under (120 characters)');
        NativeAppService::validateProject(['files' => ['manifest.json' => self::manifest(['id' => $exported, 'server' => $server])] + $files]);
    }

    /** @dataProvider manifests */
    public function testAManifestThatCannotRunSaysWhichPartIsWrong(string $manifest, string $said, array $files = []): void
    {
        try {
            NativeAppService::validateProject(['files' => ['manifest.json' => $manifest] + $files + ['index.html' => '<App/>']]);
            $this->fail('took ' . $manifest);
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString($said, $e->getMessage());
        }
    }

    /** @return iterable<string, array{0: string, 1: string, 2?: array<string, string>}> */
    public static function manifests(): iterable
    {
        yield 'not JSON' => ['{"name": "Notes", "main": "index.html",}', 'manifest.json is not valid JSON'];
        yield 'a list' => ['["index.html"]', 'must be a JSON object'];
        yield 'no main' => ['{"name":"Notes"}', 'names no first page'];
        yield 'main is logic' => ['{"name":"Notes","main":"main.js"}', 'main must be a page (a .html or .ui file): it names main.js', ['main.js' => 'let a = 1']];
        yield 'main is missing' => ['{"name":"Notes","main":"pages/home.html"}', 'main names pages/home.html, which is not among the app\'s files'];
        yield 'an id of other characters' => ['{"name":"Notes","main":"index.html","id":"my app!"}', 'id can only be letters'];
    }
}
