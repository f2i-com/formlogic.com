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
        foreach (['index.htm', 'main.JS', 'main.mjs', 'main.ts', 'App.jsx', 'styles.scss', 'logic/code.wasm', 'page.HTML', 'notes.txt', 'logo.svg'] as $path) yield $path => [$path];
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
