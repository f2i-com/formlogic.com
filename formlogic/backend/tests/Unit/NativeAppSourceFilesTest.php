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
