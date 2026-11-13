<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\{AppService, AppUserService, ChatToolDeniedException, ChatToolsContext, ChatToolsService, FormService, NativeAppService, ResponseService, SoftnAppTools, SoftnKnowledge};
use PHPUnit\Framework\TestCase;

/**
 * Looking after a hosted SoftN app with tools (SoftnAppTools, through ChatToolsService as MCP and
 * the chat reach it): reading its source without its media, changing files and media, its data,
 * its people, and what each surface is and is not let do. The real runtime, database and browser
 * are ui/e2e/mcp-softn-app.spec.ts's.
 */
final class SoftnAppToolsTest extends TestCase
{
    private const APP = ['id' => 'app-1', 'ownerId' => 'owner', 'name' => 'Notes', 'slug' => 'notes', 'status' => 'draft', 'settings' => ['softnApp' => true]];

    /** @var list<array{0: string, 1: array<string, mixed>, 2: int}> what install() was given */
    private array $installs = [];
    /** @var list<array<string, mixed>> what manageRecord() was given */
    private array $recordCalls = [];

    private function project(array $over = []): array
    {
        return $over + ['version' => 3, 'home' => true, 'access' => 'members', 'files' => ['manifest.json' => '{"name":"Notes","main":"ui/main.ui","server":{"routes":[{"path":"/api/items","method":"get"}]}}', 'ui/main.ui' => '<App><Text>Notes</Text></App>', 'server/main.logic' => 'function listItems(req) {}'], 'assets' => ['assets/logo.png' => 'AAAA']];
    }

    /** @return array{0: ChatToolsService, 1: NativeAppService&\PHPUnit\Framework\MockObject\MockObject} */
    private function tools(array|false|null $project = null, array $app = self::APP, ?AppUserService $users = null): array
    {
        // null: the usual project; false: nothing installed.
        $project = $project === false ? null : ($project ?? $this->project());
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturnCallback(static fn (string $id) => $id === $app['id'] ? $app : null);
        $apps->method('getAllApps')->willReturn([$app, ['id' => 'app-2', 'ownerId' => 'owner', 'name' => 'Orders', 'slug' => 'orders', 'status' => 'published', 'settings' => []]]);
        $native = $this->createMock(NativeAppService::class);
        $native->method('get')->willReturn($project);
        $native->method('summary')->willReturn($project === null ? null : array_diff_key($project, ['assets' => 1]));
        $native->method('runtimeProject')->willReturn($project === null ? null : ['project' => array_diff_key($project, ['assets' => 1]), 'media' => ['sha256' => 'x', 'size' => 3, 'count' => 1]]);
        $native->method('mediaSizes')->willReturn($project === null ? [] : ['assets/logo.png' => 3]);
        $native->method('install')->willReturnCallback(function (string $appId, array $given, int $expected): array {
            $this->installs[] = [$appId, $given, $expected];
            return ['version' => $expected + 1] + $given;
        });
        $native->method('manageRecord')->willReturnCallback(function (string $appId, array $input): array {
            $this->recordCalls[] = $input;
            return $input['action'] === 'read' ? ['record' => ['values' => ['title' => 'x'], 'revision' => 'r1', 'fields' => []]] : ['saved' => true];
        });
        $service = new ChatToolsService($this->createMock(FormService::class), $apps, $this->createMock(ResponseService::class), appUsers: $users, native: $native, softnKnowledge: new SoftnKnowledge(null, ['softn' => 'v1', 'components' => ['Button' => "## Button — A button.\nTag: <Button> (group: essentials)"], 'docs' => []], ['javascript' => "# How to build a SoftN app\n\nIntro.\n\n## Files\nmanifest.json\n", 'python' => "# How\n\n## Python logic (.py)\nx\n"]));
        return [$service, $native];
    }

    private static function mcp(array $scopes = ['apps:read', 'apps:write', 'screens:write', 'responses:read', 'responses:write'], ?string $siteUrl = 'https://forms.example'): ChatToolsContext
    {
        return new ChatToolsContext('owner', source: 'mcp', siteUrl: $siteUrl, requireScope: static function (string $scope) use ($scopes): void {
            if (!in_array($scope, $scopes, true)) throw new ChatToolDeniedException('This MCP token lacks the required scope: ' . $scope, 'scope');
        });
    }

    public function testTheProjectIsListedWithItsSourceAndItsMediaAreNamedNotSent(): void
    {
        [$tools] = $this->tools();
        $read = $tools->call('get_native_app_project', ['appId' => 'app-1'], self::mcp());
        $this->assertSame(3, $read['version']);
        $this->assertSame(['manifest.json', 'ui/main.ui', 'server/main.logic'], array_column($read['files'], 'path'));
        $this->assertSame([['path' => 'assets/logo.png', 'bytes' => 3]], $read['media']);
        $this->assertSame('<App><Text>Notes</Text></App>', $read['sources']['ui/main.ui']);
        $this->assertStringNotContainsString('AAAA', json_encode($read));
        $this->assertSame('https://forms.example/app/notes', $read['appUrl']);
        $this->assertSame('https://forms.example/apps/app-1/softn', $read['workspaceUrl']);

        // By name: several at once, and the one-file answer it always had.
        $some = $tools->call('get_native_app_project', ['appId' => 'app-1', 'files' => ['ui/main.ui', 'server/main.logic']], self::mcp());
        $this->assertSame(['ui/main.ui', 'server/main.logic'], array_keys($some['sources']));
        $one = $tools->call('get_native_app_project', ['appId' => 'app-1', 'file' => 'ui/main.ui'], self::mcp());
        $this->assertSame(['ui/main.ui', '<App><Text>Notes</Text></App>'], [$one['file'], $one['source']]);
        try {
            $tools->call('get_native_app_project', ['appId' => 'app-1', 'file' => 'nope.ui'], self::mcp());
            $this->fail('read a file that is not there');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('The files are: manifest.json, ui/main.ui, server/main.logic', $e->getMessage());
        }
    }

    public function testALargeProjectIsListedAndReadFileByFileAndAChatTurnIsHandedLess(): void
    {
        $big = str_repeat('x', 30000);
        [$tools] = $this->tools($this->project(['files' => ['manifest.json' => '{"main":"ui/main.ui"}', 'ui/main.ui' => $big, 'ui/other.ui' => $big]]));
        $listed = $tools->call('get_native_app_project', ['appId' => 'app-1'], self::mcp());
        $this->assertArrayNotHasKey('sources', $listed);
        $this->assertStringContainsString('starting with manifest.json', $listed['note']);
        // Over MCP both files come. In chat neither fits an answer, and a file is sent whole or not at
        // all: a part handed over as if it were the file would be written back as the file.
        $mcp = $tools->call('get_native_app_project', ['appId' => 'app-1', 'files' => ['ui/main.ui', 'ui/other.ui']], self::mcp());
        $this->assertSame([30000, 30000], array_map('strlen', array_values($mcp['sources'])));
        $chat = new ChatToolsContext('owner');
        $several = $tools->callChatTool('get_native_app_project', ['appId' => 'app-1', 'files' => ['manifest.json', 'ui/main.ui', 'ui/other.ui']], $chat);
        $this->assertSame(['manifest.json'], array_keys($several['sources']));
        $this->assertSame([['path' => 'ui/main.ui', 'bytes' => 30000], ['path' => 'ui/other.ui', 'bytes' => 30000]], $several['notSent']['files']);
        $this->assertStringContainsString('none of their text was sent', $several['notSent']['note']);
        $this->assertLessThan(30000, strlen(json_encode($several)));
    }

    /** One file is read from where the caller says, so a file longer than an answer carries can be read whole, and says it is a part. */
    public function testAFileLongerThanAnAnswerIsReadInPartsThatSayTheyAreParts(): void
    {
        // Letters outside ASCII: six characters each as a chat turn is handed them, three bytes each as stored.
        $page = '<App>' . str_repeat('日本語のページ。', 2000) . '</App>';
        [$tools] = $this->tools($this->project(['files' => ['manifest.json' => '{"main":"ui/main.ui"}', 'ui/main.ui' => $page]]));
        $chat = new ChatToolsContext('owner');
        $read = '';
        $offset = 0;
        for ($turn = 0; $turn < 40; $turn++) {
            $part = $tools->callChatTool('get_native_app_project', ['appId' => 'app-1', 'file' => 'ui/main.ui', 'offset' => $offset], $chat);
            // What the chat hands the model is the answer as JSON, held to 30,000 characters.
            $this->assertLessThan(30000, strlen((string) json_encode($part, JSON_UNESCAPED_SLASHES)), 'part ' . $turn);
            $this->assertSame([strlen($page), $offset], [$part['bytes'], $part['offset']]);
            $this->assertTrue(mb_check_encoding($part['source'], 'UTF-8'), 'a part ends between characters, never inside one');
            $this->assertArrayNotHasKey('sources', $part);
            $read .= $part['source'];
            if (!isset($part['nextOffset'])) break;
            $this->assertFalse($part['whole']);
            $this->assertStringContainsString('do not write it back from a part', $part['note']);
            $offset = $part['nextOffset'];
        }
        $this->assertGreaterThan(2, $turn);
        $this->assertSame($page, $read);
        $this->assertFalse($part['whole'], 'the last part is still a part');

        // Over MCP it comes at once, and says it is the whole file.
        $whole = $tools->call('get_native_app_project', ['appId' => 'app-1', 'file' => 'ui/main.ui'], self::mcp());
        $this->assertSame([$page, true], [$whole['source'], $whole['whole']]);
        $this->assertArrayNotHasKey('nextOffset', $whole);

        // From chat such a file is not rewritten: what the model holds of it may be a part.
        try { $tools->callChatTool('update_native_app_files', ['appId' => 'app-1', 'expectedVersion' => 3, 'files' => ['ui/main.ui' => '<App/>']], $chat); $this->fail('chat rewrote a file it cannot read in one piece'); }
        catch (ChatToolDeniedException $e) { $this->assertSame('file_too_long', $e->getReasonCode()); $this->assertStringContainsString('edit_softn_app', $e->getMessage()); }
        $this->assertSame([], $this->installs);
        // A new file, and a short one, it writes.
        $this->assertSame(4, $tools->callChatTool('update_native_app_files', ['appId' => 'app-1', 'expectedVersion' => 3, 'files' => ['ui/about.ui' => '<App/>', 'manifest.json' => '{"main":"ui/main.ui"}']], $chat)['version']);
    }

    public function testAnAppWithManyMediaFilesListsTheFirstAndSaysHowManyThereAre(): void
    {
        [$tools, $native] = $this->tools();
        $many = [];
        for ($i = 0; $i < 450; $i++) $many['assets/sprites/frame-' . $i . '.png'] = 100 + $i;
        $native = $this->createMock(NativeAppService::class);
        $native->method('runtimeProject')->willReturn(['project' => array_diff_key($this->project(), ['assets' => 1]), 'media' => ['sha256' => 'x', 'size' => 1, 'count' => 450]]);
        $native->method('mediaSizes')->willReturn($many);
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(self::APP);
        $service = new ChatToolsService($this->createMock(FormService::class), $apps, $this->createMock(ResponseService::class), native: $native);
        $listed = $service->callChatTool('get_native_app_project', ['appId' => 'app-1'], new ChatToolsContext('owner'));
        $this->assertSame([450, SoftnAppTools::MEDIA_LISTED], [$listed['mediaCount'], count($listed['media'])]);
        $this->assertStringContainsString('of 450 media files', $listed['mediaNote']);
        $this->assertLessThan(30000, strlen((string) json_encode($listed, JSON_UNESCAPED_SLASHES)));
    }

    public function testAnAppWithNothingInstalledSaysSoAndHowToBegin(): void
    {
        [$tools] = $this->tools(false);
        $read = $tools->call('get_native_app_project', ['appId' => 'app-1'], self::mcp());
        $this->assertFalse($read['installed']);
        $this->assertSame(0, $read['version']);
        $this->assertStringContainsString('expectedVersion 0', $read['note']);
    }

    public function testAnUpdateWritesRemovesAndKeepsEverythingElse(): void
    {
        [$tools] = $this->tools();
        $saved = $tools->call('update_native_app_files', ['appId' => 'app-1', 'expectedVersion' => 3, 'files' => ['ui/about.ui' => '<App/>'], 'remove' => ['server/main.logic'], 'media' => ['assets/new.png' => 'BBBB'], 'removeMedia' => ['assets/logo.png'], 'home' => false], self::mcp());
        [$appId, $project, $expected] = $this->installs[0];
        $this->assertSame(['app-1', 3], [$appId, $expected]);
        $this->assertSame(['manifest.json', 'ui/main.ui', 'ui/about.ui'], array_keys($project['files']));
        $this->assertSame(['assets/new.png' => 'BBBB'], $project['assets']);
        $this->assertSame(['members', false], [$project['access'], $project['home']]);
        $this->assertSame(4, $saved['version']);
        $this->assertTrue($saved['softnApp']);
        // Not at the app's own address any more, so beside it.
        $this->assertSame('https://forms.example/app/notes/native', $saved['appUrl']);
        $this->assertStringContainsString('open appUrl', $saved['next']);
        $this->assertArrayNotHasKey('warnings', $saved);
    }

    /**
     * A link to another page file of the app opens it in place (SoftN v0.0.40's frame), so an
     * install says nothing of one. A link to a page file the app does not have still stops the
     * app when it is followed: the install says so, naming each.
     */
    public function testAnInstallWarnsOfALinkToAPageTheAppDoesNotHave(): void
    {
        $files = [
            'manifest.json' => '{"main":"index.html"}',
            'index.html' => '<App><a href="about.html">About</a> <a href="https://example.com/x.html">Elsewhere</a> <a href="#top">Top</a> <a href="index.html">Home</a> <a href="missing.html">Gone</a></App>',
            'about.html' => '<App><a href="./index.html#top">Back</a></App>',
            'pages/more.ui' => "<App><Button @click={() => go()}>Go</Button></App>\n<logic>function go() { location.href = '../about.html' }</logic>",
            'main.js' => 'let page = "about.html"',
            // A backend's files are not pages.
            'server/main.logic' => 'var x = "<a href=\'about.html\'>"',
        ];
        $warnings = SoftnAppTools::warnings($files);
        $this->assertCount(2, $warnings);
        // The link to a page that is not there, from the page it is on; not a link to a page the app has (by a link or by its code), to itself, or to a part of the page.
        $this->assertStringContainsString('(index.html → missing.html)', $warnings[0]);
        $this->assertStringContainsString('opens it in place', $warnings[0]);
        $this->assertStringNotContainsString('about.html', $warnings[0]);
        // And the link to another site, which stops the app as surely.
        $this->assertStringContainsString('another site', $warnings[1]);
        $this->assertStringContainsString('(index.html: https://example.com/x.html)', $warnings[1]);
        // A link from a folder is read from that folder, and one from the app's root from there.
        $this->assertStringContainsString('(pages/more.ui → pages/gone.html; pages/more.ui → gone.ui)', SoftnAppTools::warnings(['manifest.json' => '{}', 'pages/more.ui' => '<App><a href="gone.html">One</a><a href="/gone.ui">Two</a><a href="../pages/more.ui">Here</a></App>'])[0]);
        $this->assertSame([], SoftnAppTools::warnings(['manifest.json' => '{}', 'index.html' => '<import About from="./about.html" /><App>#if (page === "about")<About />#end <a href="about.html">About</a></App>', 'about.html' => '<Text>About</Text>']));

        [$tools] = $this->tools();
        $saved = $tools->call('update_native_app_files', ['appId' => 'app-1', 'expectedVersion' => 3, 'files' => ['ui/main.ui' => '<App><a href="about.ui">About</a> <a href="gone.ui">Gone</a></App>', 'ui/about.ui' => '<App/>']], self::mcp());
        $this->assertCount(1, $saved['warnings']);
        $this->assertStringContainsString('(ui/main.ui → ui/gone.ui)', $saved['warnings'][0]);
    }

    /**
     * A link is read from the page that shows it, as SoftN reads one: a part brought in with
     * `<import>` is shown by the pages that import it, and its links are theirs, not its own
     * folder's. (Followed in a browser: a link `about.html` written in parts/nav.html and shown
     * by index.html opens about.html.)
     */
    public function testALinkInAnImportedPartIsReadFromThePagesThatShowIt(): void
    {
        $page = static fn (string $body): string => "<import Nav from=\"./parts/nav.html\" />\n<App><Nav />{$body}</App>";
        $files = ['manifest.json' => '{"main":"index.html"}', 'index.html' => $page(''), 'about.html' => '<App>About</App>', 'parts/nav.html' => '<a href="about.html">About</a> <a href="index.html">Home</a>'];
        $this->assertSame([], SoftnAppTools::warnings($files));
        // Through a part of a part, and with the earlier spelling's folders.
        $this->assertSame([], SoftnAppTools::warnings(['manifest.json' => '{}', 'ui/main.ui' => '<import Shell from="./components/Shell.ui" /><Shell />', 'ui/components/Shell.ui' => '<import Nav from="./Nav.ui" /><Nav />', 'ui/components/Nav.ui' => '<a href="about.ui">About</a>', 'ui/about.ui' => '<App/>']));
        // It opens from one of the pages that show it: left alone, though from the other it would not.
        $this->assertSame([], SoftnAppTools::warnings($files + ['docs/guide.html' => "<import Nav from=\"../parts/nav.html\" />\n<App><Nav /></App>"]));
        // From no page that shows it: named with the file it is written in, as the first of those pages reads it.
        $broken = SoftnAppTools::warnings(['parts/nav.html' => '<a href="team.html">Team</a>'] + $files);
        $this->assertCount(1, $broken);
        $this->assertStringContainsString('(parts/nav.html → team.html)', $broken[0]);
        // Two parts that only bring each other in are read from themselves, and nothing loops.
        $this->assertSame([], SoftnAppTools::warnings(['manifest.json' => '{}', 'a.html' => '<import B from="./b.html" /><a href="b.html">B</a>', 'b.html' => '<import A from="./a.html" /><a href="a.html">A</a>']));
    }

    /**
     * What stops a hosted app when it is followed, beyond a page that is not there: each of these
     * was clicked in a browser on an installed app. And what does not stop it, which is left alone.
     */
    public function testAnInstallWarnsOfLinksThatAreNotToAPageOfTheApp(): void
    {
        $with = static fn (string $links, array $more = []): array => SoftnAppTools::warnings(['manifest.json' => '{"main":"index.html"}', 'index.html' => "<App>{$links}</App>", 'about.html' => '<App/>', 'docs/guide.html' => '<App/>', 'styles.css' => 'body{}', 'server/admin.html' => '<App/>'] + $more);

        // No page file named: no ending, the root, a folder, a query alone, a stylesheet, one of the app's pictures.
        $none = $with('<a href="about">1</a><a href="/">2</a><a href="./">3</a><a href="docs/">4</a><a href="?tab=2">5</a><a href="styles.css">6</a><a href="assets/dot.png" download="dot.png">7</a>');
        $this->assertCount(1, $none);
        $this->assertStringContainsString('names no page file', $none[0]);
        $this->assertStringContainsString('(index.html: "about"; index.html: "/"; index.html: "./"; index.html: "docs/"; index.html: "?tab=2"; index.html: "styles.css"; index.html: "assets/dot.png")', $none[0]);
        $this->assertStringContainsString('named in full with its ending', $none[0]);

        // A page file that is not there: above the app's own folder, the wrong case, one only the backend has, an ending this host keeps no page under.
        $gone = $with('<a href="../about.html">1</a><a href="about.HTML">2</a><a href="server/admin.html">3</a><a href="old.htm">4</a>');
        $this->assertCount(1, $gone);
        $this->assertStringContainsString('(index.html → ../about.html; index.html → about.HTML; index.html → server/admin.html; index.html → old.htm)', $gone[0]);

        // Another site and a mail address.
        $out = $with('<a href="https://example.com/">1</a><a href="//cdn.example.com/x">2</a><a href="mailto:someone@example.com">3</a>');
        $this->assertCount(1, $out);
        $this->assertStringContainsString('(index.html: https://example.com/; index.html: //cdn.example.com/x; index.html: mailto:someone@example.com)', $out[0]);
        $this->assertStringContainsString('text the person can copy', $out[0]);

        // The page's own code going to a page that is not there does nothing: said apart, as that.
        $code = $with('<Button @click={() => go()}>Go</Button>', ['main2.ui' => "<logic>function go() { location.href = 'gone.html'; window.location.assign(\"about.html\"); if (location.href == 'x.html') {} }</logic>"]);
        $this->assertCount(1, $code);
        $this->assertStringContainsString('does nothing (main2.ui → gone.html)', $code[0]);

        // Left alone: a page of the app however it is written, a place on the page, a link with a target
        // (it opens nothing and the app stays), an address made in code, and what is not a link at all.
        $this->assertSame([], $with(
            '<a href=" about.html">1</a><a href="docs\\guide.html">2</a><a href="about.html?from=home#team">3</a><a href="#top">4</a><a href="">5</a>'
            . '<a href="https://example.com/" target="_blank" rel="noopener">6</a><a target=_blank href="missing.html">7</a><a href={next}>8</a><a href="{page}.html">9</a>'
            . '<a data-href="missing.html">10</a><link href="missing.html"><use xlink:href="missing.html" /><a-card href="missing.html"></a-card>'
            . '<!-- <a href="missing.html">old</a> --><pre><a href="missing.html">an example</a></pre><code>&lt;a href="x"&gt; <a href="missing.html">x</a></code>'
            . '<a href="javascript:void(0)">11</a><a href="tel:+15550100">12</a><a title="a > b" href="about.html">13</a>'
        ));
        // A target that is this frame is no target.
        $this->assertCount(1, $with('<a href="missing.html" target="_self">1</a>'));
    }

    /**
     * A page is read once from start to end, whatever it holds: a page made of openings that are
     * never closed (each of which a pattern would read on from to the page's end) costs no more
     * than any other page of its size. A source file may be 1.5 MB.
     */
    public function testAPageOfUnclosedOpeningsIsReadAsQuicklyAsAnyOther(): void
    {
        $size = 1400000;
        foreach (['<a ', '<a href="', '<!-- ', '<pre ', '<code>', '<import from="', 'location = "', "<a href='x.html' "] as $opening) {
            $page = str_repeat($opening, intdiv($size, strlen($opening)));
            $started = hrtime(true);
            $warnings = SoftnAppTools::warnings(['manifest.json' => '{"main":"index.html"}', 'index.html' => $page, 'about.html' => $page]);
            $took = (hrtime(true) - $started) / 1e9;
            $this->assertLessThan(5.0, $took, 'a page of "' . trim($opening) . '" took ' . round($took, 2) . ' s');
            $this->assertIsArray($warnings);
        }
        // And one of ordinary links, every one of them to a page that is not there, is named once.
        $many = SoftnAppTools::warnings(['manifest.json' => '{}', 'index.html' => str_repeat('<a href="gone.html">x</a>', 40000)]);
        $this->assertCount(1, $many);
        $this->assertStringContainsString('(index.html → gone.html)', $many[0]);
    }

    public function testWhatAnUpdateIsGivenIsHeldToItsShape(): void
    {
        [$tools] = $this->tools();
        $bad = [
            'Nothing to change' => ['appId' => 'app-1', 'expectedVersion' => 3],
            'no file to remove' => ['appId' => 'app-1', 'expectedVersion' => 3, 'remove' => ['ui/gone.ui']],
            'manifest.json is not removed' => ['appId' => 'app-1', 'expectedVersion' => 3, 'remove' => ['manifest.json']],
            'name it in remove' => ['appId' => 'app-1', 'expectedVersion' => 3, 'files' => ['ui/main.ui' => null]],
            'files is an object' => ['appId' => 'app-1', 'expectedVersion' => 3, 'files' => ['<App/>']],
            'access is "members"' => ['appId' => 'app-1', 'expectedVersion' => 3, 'access' => 'public'],
            'home is true or false' => ['appId' => 'app-1', 'expectedVersion' => 3, 'home' => 'yes'],
            // The version the caller read is not the one installed: said for an AI, before the install is tried.
            'is at version 3, not 2' => ['appId' => 'app-1', 'expectedVersion' => 2, 'files' => ['ui/main.ui' => '<App/>']],
        ];
        foreach ($bad as $said => $args) {
            try {
                $tools->call('update_native_app_files', $args, self::mcp());
                $this->fail('accepted: ' . $said);
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString($said, $e->getMessage());
            }
        }
        $this->assertSame([], $this->installs);
    }

    public function testAWholeProjectSentWithoutMediaKeepsTheAppsOwn(): void
    {
        [$tools] = $this->tools();
        $files = ['manifest.json' => '{"main":"ui/main.ui"}', 'ui/main.ui' => '<App/>'];
        $tools->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 3, 'project' => ['files' => $files, 'access' => 'members', 'home' => true]], self::mcp());
        $this->assertSame(['assets/logo.png' => 'AAAA'], $this->installs[0][1]['assets']);
        // `assets: {}` is how a project says it has none.
        $tools->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 3, 'project' => ['files' => $files, 'assets' => [], 'access' => 'members']], self::mcp());
        $this->assertSame([], $this->installs[1][1]['assets']);
        // null for them is "as they are", not "none".
        $tools->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 3, 'project' => ['files' => $files, 'assets' => null]], self::mcp());
        $this->assertSame(['assets/logo.png' => 'AAAA'], $this->installs[2][1]['assets']);
    }

    /** A project that does not say where it opens keeps where it opens: left out, `home` used to become false and take the app off its address. */
    public function testAWholeProjectThatDoesNotSayWhereItOpensStaysAtTheAppsAddress(): void
    {
        [$tools] = $this->tools();
        $files = ['manifest.json' => '{"main":"ui/main.ui"}', 'ui/main.ui' => '<App/>'];
        $saved = $tools->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 3, 'project' => ['files' => $files]], self::mcp());
        $this->assertTrue($this->installs[0][1]['home']);
        $this->assertSame('https://forms.example/app/notes', $saved['appUrl']);
        // Said, it is as said.
        $tools->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 3, 'project' => ['files' => $files, 'home' => false]], self::mcp());
        $this->assertFalse($this->installs[1][1]['home']);
        // A SoftN app's first version opens at its address; a project a forms app hosts does not take that app's over.
        [$first] = $this->tools(false);
        $first->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 0, 'project' => ['files' => $files]], self::mcp());
        $this->assertTrue(end($this->installs)[1]['home']);
        [$forms] = $this->tools(false, ['settings' => []] + self::APP);
        $forms->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 0, 'project' => ['files' => $files]], self::mcp());
        $this->assertFalse(end($this->installs)[1]['home']);
        // Files that are not an object of path to text are refused in words, before anything reads them by name.
        foreach ([['files' => ['<App/>', '{}']], ['files' => 'manifest.json'], []] as $project) {
            try { $tools->call('publish_native_app_project', ['appId' => 'app-1', 'expectedVersion' => 3, 'project' => $project], self::mcp()); $this->fail('took ' . json_encode($project)); }
            catch (\InvalidArgumentException $e) { $this->assertStringContainsString('project.files is an object', $e->getMessage()); }
        }
    }

    public function testRecordsTakeTheRecordsPermissionsAndAChangeNamesItsRevision(): void
    {
        [$tools] = $this->tools();
        $builder = self::mcp(['apps:read', 'apps:write', 'screens:write']);
        foreach ([['list_native_app_records', ['appId' => 'app-1']], ['get_native_app_record', ['appId' => 'app-1', 'table' => 'items', 'key' => ['id' => '1']]], ['change_native_app_record', ['appId' => 'app-1', 'action' => 'create', 'table' => 'items', 'values' => ['title' => 'x']]], ['list_app_members', ['appId' => 'app-1']]] as [$name, $args]) {
            try { $tools->call($name, $args, $builder); $this->fail($name . ' ran without the records scope'); }
            catch (ChatToolDeniedException $e) { $this->assertSame('scope', $e->getReasonCode(), $name); }
        }
        // Reading alone does not write.
        try { $tools->call('change_native_app_record', ['appId' => 'app-1', 'action' => 'create', 'table' => 'items', 'values' => ['title' => 'x']], self::mcp(['apps:read', 'responses:read'])); $this->fail('wrote with the read scope'); }
        catch (ChatToolDeniedException $e) { $this->assertSame('scope', $e->getReasonCode()); }

        $record = $tools->call('get_native_app_record', ['appId' => 'app-1', 'table' => 'items', 'key' => ['id' => '1']], self::mcp());
        $this->assertSame(['app-1', 'items', 'r1'], [$record['appId'], $record['table'], $record['record']['revision']]);
        foreach ([['action' => 'update', 'key' => ['id' => '1'], 'values' => ['title' => 'y']], ['action' => 'delete', 'key' => ['id' => '1']]] as $change) {
            try { $tools->call('change_native_app_record', ['appId' => 'app-1', 'table' => 'items'] + $change, self::mcp()); $this->fail('changed a record it had not read'); }
            catch (\InvalidArgumentException $e) { $this->assertStringContainsString('get_native_app_record', $e->getMessage()); }
        }
        $saved = $tools->call('change_native_app_record', ['appId' => 'app-1', 'action' => 'update', 'table' => 'items', 'key' => ['id' => '1'], 'revision' => 'r1', 'values' => ['title' => 'y']], self::mcp());
        $this->assertSame(['app-1', true, 'update', 'items'], [$saved['appId'], $saved['saved'], $saved['action'], $saved['table']]);
        $this->assertSame(['action' => 'update', 'table' => 'items', 'key' => ['id' => '1'], 'revision' => 'r1', 'values' => ['title' => 'y']], end($this->recordCalls));
        // deleteMany is the data manager's own: not an action a tool takes.
        $this->expectException(\InvalidArgumentException::class);
        $tools->call('change_native_app_record', ['appId' => 'app-1', 'action' => 'deleteMany', 'table' => 'items', 'rows' => []], self::mcp());
    }

    public function testAPageOfRowsIsCutToWhatWasAskedAndCarriesNoStamps(): void
    {
        [$tools, $native] = $this->tools();
        $rows = array_map(static fn (int $n) => ['id' => $n, 'title' => 'Row ' . $n], range(1, 25));
        $native->method('records')->willReturnCallback(function (string $appId, ?string $table, int $offset, ?int $generation, ?array $options) use ($rows): array {
            $this->recordCalls[] = ['table' => $table, 'offset' => $offset, 'options' => $options];
            return $table === null
                ? ['installed' => true, 'tables' => ['items'], 'summary' => ['tables' => [['name' => 'items', 'rows' => 25, 'columns' => 2]], 'bytes' => 4096, 'hiddenTables' => 0]]
                : ['tables' => ['items'], 'columns' => ['id', 'title'], 'rows' => $rows, 'hasMore' => false, 'end' => 'end', 'keys' => array_map(static fn (array $row) => ['id' => (string) $row['id']], $rows), 'offset' => $offset, 'limit' => 25, 'total' => 25, 'matching' => 25, 'stamps' => array_fill(0, 25, 's'), 'cut' => (object) [1 => ['title'], 20 => ['title']]];
        });
        $tables = $tools->call('list_native_app_records', ['appId' => 'app-1'], self::mcp());
        $this->assertSame([['name' => 'items', 'rows' => 25, 'columns' => 2]], $tables['tables']);

        $page = $tools->call('list_native_app_records', ['appId' => 'app-1', 'table' => 'items', 'limit' => 5, 'search' => 'Row', 'sort' => 'title', 'dir' => 'desc', 'filter' => [['column' => 'title', 'op' => 'starts', 'value' => 'R']]], self::mcp());
        $asked = end($this->recordCalls);
        // The store pages by fixed sizes: the next one up is read…
        $this->assertSame(['q' => 'Row', 'filter' => [['column' => 'title', 'op' => 'starts', 'value' => 'R']], 'sort' => 'title', 'dir' => 'desc', 'limit' => 25], $asked['options']);
        // …and cut to what was asked, with more to come said.
        $this->assertCount(5, $page['rows']);
        $this->assertCount(5, $page['keys']);
        $this->assertSame([5, true, 'more', 25, 'items', 'app-1'], [$page['limit'], $page['hasMore'], $page['end'], $page['total'], $page['table'], $page['appId']]);
        $this->assertArrayNotHasKey('stamps', $page);
        $this->assertSame(['1' => ['title']], (array) $page['cut']);
        $this->assertStringContainsString('get_native_app_record', $page['note']);
    }

    public function testFromChatARecordIsNotDeletedAndAMembersAppIsNotOpened(): void
    {
        [$tools] = $this->tools();
        $chat = new ChatToolsContext('owner');
        try { $tools->callChatTool('change_native_app_record', ['appId' => 'app-1', 'action' => 'delete', 'table' => 'items', 'key' => ['id' => '1'], 'revision' => 'r1'], $chat); $this->fail('chat deleted a record'); }
        catch (ChatToolDeniedException $e) { $this->assertSame('delete_refused', $e->getReasonCode()); }
        try { $tools->callChatTool('update_native_app_files', ['appId' => 'app-1', 'expectedVersion' => 3, 'access' => 'application'], $chat); $this->fail('chat opened a members-only app'); }
        catch (ChatToolDeniedException $e) { $this->assertSame('native_access_refused', $e->getReasonCode()); }
        try { $tools->callChatTool('remove_app_member', ['appId' => 'app-1', 'memberId' => 'm1'], $chat); $this->fail('chat removed a member'); }
        catch (ChatToolDeniedException $e) { $this->assertSame('unknown_tool', $e->getReasonCode()); }
        $this->assertSame([], $this->installs);
        $this->assertSame([], $this->recordCalls);
        // It adds and corrects.
        $this->assertTrue($tools->callChatTool('change_native_app_record', ['appId' => 'app-1', 'action' => 'create', 'table' => 'items', 'values' => ['title' => 'x']], $chat)['saved']);
        // Said in the catalog the model reads, so it tells the person rather than trying.
        $catalog = array_column(ChatToolsService::chatCatalog(), null, 'name');
        $this->assertSame(['create', 'update'], $catalog['change_native_app_record']['inputSchema']['properties']['action']['enum']);
        $this->assertArrayNotHasKey('access', $catalog['update_native_app_files']['inputSchema']['properties']);
        $this->assertStringContainsString('edit_softn_app', $catalog['update_native_app_files']['description']);
        $this->assertArrayNotHasKey('remove_app_member', $catalog);
        // A member is suspended from chat and nothing else, and the schema offers nothing else.
        $this->assertSame(['suspended'], $catalog['update_app_member']['inputSchema']['properties']['status']['enum']);
        $this->assertArrayNotHasKey('roleId', $catalog['update_app_member']['inputSchema']['properties']);
    }

    /**
     * Letting one person in is opening the app to them, and someone waiting for approval chose the
     * name the model has just read in the list. From chat a member is suspended; nobody is let in
     * or given another role.
     */
    public function testFromChatNobodyIsLetInOrGivenAnotherRole(): void
    {
        $users = $this->createMock(AppUserService::class);
        $users->method('appUserBelongsToApp')->willReturn(true);
        $users->method('roleBelongsToApp')->willReturn(true);
        $updates = [];
        $users->method('updateAppUser')->willReturnCallback(static function (string $member, array $data) use (&$updates): bool { $updates[] = [$member, $data]; return true; });
        [$tools] = $this->tools(null, self::APP, $users);
        $chat = new ChatToolsContext('owner');
        foreach ([['status' => 'active'], ['roleId' => 'r-admin'], ['status' => 'suspended', 'roleId' => 'r-admin'], ['status' => 'Active'], ['status' => ['active']], []] as $args) {
            try { $tools->callChatTool('update_app_member', ['appId' => 'app-1', 'memberId' => 'm-2'] + $args, $chat); $this->fail('chat took ' . json_encode($args)); }
            catch (ChatToolDeniedException $e) { $this->assertSame('member_refused', $e->getReasonCode()); }
        }
        $this->assertSame([], $updates);
        $this->assertSame('suspended', $tools->callChatTool('update_app_member', ['appId' => 'app-1', 'memberId' => 'm-2', 'status' => 'suspended'], $chat)['status']);
        $this->assertSame([['m-2', ['status' => 'suspended']]], $updates);
        // Over MCP, with the scope that manages roles, both are the owner's connection's to do.
        $this->assertSame('active', $tools->call('update_app_member', ['appId' => 'app-1', 'memberId' => 'm-2', 'status' => 'active'], self::mcp())['status']);
    }

    /** A database error inside the member service is not put into words for the caller: its text names tables and columns. */
    public function testADatabaseErrorWhileChangingAMemberIsNotMadeAMessage(): void
    {
        $users = $this->createMock(AppUserService::class);
        $users->method('appUserBelongsToApp')->willReturn(true);
        $users->method('updateAppUser')->willThrowException(new \PDOException('SQLSTATE[40001]: Deadlock found on app_users'));
        $users->method('removeAppUser')->willThrowException(new \PDOException('SQLSTATE[HY000]: app_users is gone'));
        [$tools] = $this->tools(null, self::APP, $users);
        foreach ([['update_app_member', ['status' => 'suspended']], ['remove_app_member', []]] as [$name, $args]) {
            try { $tools->call($name, ['appId' => 'app-1', 'memberId' => 'm-2'] + $args, self::mcp()); $this->fail($name . ' answered'); }
            catch (\PDOException $e) { $this->assertStringContainsString('SQLSTATE', $e->getMessage()); }
        }
    }

    public function testAChangeToAnAppIsHandedToAiStudioByTheChatAlone(): void
    {
        [$tools] = $this->tools();
        $audits = [];
        $chat = new ChatToolsContext('owner', audit: static function (string $action, array $detail) use (&$audits): void { $audits[] = [$action, $detail]; });
        $handed = $tools->callChatTool('edit_softn_app', ['appId' => 'app-1', 'request' => ' Add a dark theme. '], $chat);
        $this->assertSame(['id' => 'app-1', 'name' => 'Notes', 'slug' => 'notes'], $handed['app']);
        $this->assertSame(['Add a dark theme.', true, 3, '/apps/app-1/softn'], [$handed['request'], $handed['edit'], $handed['version'], $handed['workspaceUrl']]);
        $this->assertStringContainsString('do not change its files yourself', $handed['next']);
        $this->assertSame([['edit_softn_app', ['appId' => 'app-1']]], $audits);
        $this->assertSame([], $this->installs);
        foreach ([['request' => ''], ['request' => str_repeat('r', 8001)]] as $args) {
            try { $tools->callChatTool('edit_softn_app', ['appId' => 'app-1'] + $args, $chat); $this->fail('took a request of ' . strlen($args['request'])); }
            catch (\InvalidArgumentException $e) { $this->assertStringContainsString('8,000', $e->getMessage()); }
        }
        // An MCP client has no AI Studio to be taken to: it is told to change the files itself, and is not shown the tool.
        try { $tools->call('edit_softn_app', ['appId' => 'app-1', 'request' => 'x'], self::mcp()); $this->fail('MCP was handed to AI Studio'); }
        catch (\InvalidArgumentException $e) { $this->assertStringContainsString('update_native_app_files', $e->getMessage()); }
        $this->assertContains('edit_softn_app', ChatToolsService::CHAT_ONLY_TOOLS);
        // Someone else's app is not theirs to hand over.
        $this->expectException(ChatToolDeniedException::class);
        $tools->callChatTool('edit_softn_app', ['appId' => 'app-1', 'request' => 'x'], new ChatToolsContext('stranger'));
    }

    public function testMembersAreListedWithoutWhatLetsSomeoneInAndChangedByTheirOwner(): void
    {
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUsers')->willReturn([
            ['id' => 'm-owner', 'userId' => 'owner', 'roleId' => 'r-owner', 'status' => 'active', 'joinedAt' => '2026-01-01', 'email' => 'owner@example.com', 'name' => 'Owner', 'roleName' => 'Owner'],
            ['id' => 'm-2', 'userId' => 'u-2', 'roleId' => 'r-member', 'status' => 'pending', 'joinedAt' => null, 'email' => 'sam@example.com', 'name' => 'Sam', 'roleName' => 'Member'],
        ]);
        $invitation = ['id' => 'i-1', 'appId' => 'app-1', 'email' => 'new@example.com', 'roleId' => 'r-member', 'roleName' => 'Member', 'status' => 'pending', 'invitedBy' => 'owner', 'inviterName' => 'Owner', 'token' => 'secret-token', 'expiresAt' => '2999-01-01 00:00:00', 'createdAt' => '2026-11-01 00:00:00'];
        // Beside the open one: one that was accepted, one withdrawn, and one that has run out.
        $users->method('getInvitations')->willReturn([$invitation, ['id' => 'i-2', 'email' => 'joined@example.com', 'status' => 'accepted'] + $invitation, ['id' => 'i-3', 'email' => 'withdrawn@example.com', 'status' => 'revoked'] + $invitation, ['id' => 'i-4', 'email' => 'late@example.com', 'expiresAt' => '2001-01-01 00:00:00'] + $invitation]);
        $users->method('appUserBelongsToApp')->willReturnCallback(static fn (string $member) => in_array($member, ['m-owner', 'm-2'], true));
        $users->method('roleBelongsToApp')->willReturnCallback(static fn (string $role) => $role === 'r-member');
        $updates = [];
        $users->method('updateAppUser')->willReturnCallback(static function (string $member, array $data, ?string $actor, ?string $appId) use (&$updates): bool {
            if ($member === 'm-owner') throw new \RuntimeException('Cannot suspend or deactivate the app owner');
            $updates[] = [$member, $data, $actor, $appId];
            return true;
        });
        $users->expects($this->once())->method('removeAppUser')->with('m-2', 'owner', 'app-1')->willReturn(true);
        [$tools] = $this->tools(null, self::APP, $users);

        $listed = $tools->call('list_app_members', ['appId' => 'app-1'], self::mcp());
        $this->assertSame(2, $listed['total']);
        $this->assertSame(['m-owner', true, 'm-2', false, 'pending'], [$listed['members'][0]['memberId'], $listed['members'][0]['isOwner'], $listed['members'][1]['memberId'], $listed['members'][1]['isOwner'], $listed['members'][1]['status']]);
        // Only the invitations still open: someone whose invitation was withdrawn is not on their way in.
        $this->assertSame(['new@example.com'], array_column($listed['invitations'], 'email'));
        // The invitation's token is what lets someone in: it is never handed to an AI.
        $this->assertStringNotContainsString('secret-token', json_encode($listed));

        $suspended = $tools->call('update_app_member', ['appId' => 'app-1', 'memberId' => 'm-2', 'status' => 'suspended'], self::mcp());
        $this->assertSame(['appId' => 'app-1', 'softnApp' => true, 'memberId' => 'm-2', 'status' => 'suspended'], $suspended);
        $this->assertSame([['m-2', ['status' => 'suspended'], 'owner', 'app-1']], $updates);
        foreach ([['memberId' => 'm-owner', 'status' => 'suspended'], ['memberId' => 'm-2', 'status' => 'banned'], ['memberId' => 'm-2']] as $args) {
            try { $tools->call('update_app_member', ['appId' => 'app-1'] + $args, self::mcp()); $this->fail('took ' . json_encode($args)); }
            catch (\InvalidArgumentException $e) { $this->assertNotSame('', $e->getMessage()); }
        }
        foreach ([['memberId' => 'someone-elses', 'status' => 'suspended'], ['memberId' => 'm-2', 'roleId' => 'r-of-another-app']] as $args) {
            try { $tools->call('update_app_member', ['appId' => 'app-1'] + $args, self::mcp()); $this->fail('took ' . json_encode($args)); }
            catch (ChatToolDeniedException $e) { $this->assertContains($e->getReasonCode(), ['not_found', 'app_scope']); }
        }
        $this->assertSame(['appId' => 'app-1', 'softnApp' => true, 'memberId' => 'm-2', 'removed' => true], $tools->call('remove_app_member', ['appId' => 'app-1', 'memberId' => 'm-2'], self::mcp()));
    }

    public function testAnAppIsToldApartAndLookedOver(): void
    {
        [$tools, $native] = $this->tools();
        $native->method('glance')->willReturn(['version' => 3, 'access' => 'members', 'backend' => true, 'tables' => 1, 'bytes' => 4096]);
        $native->method('records')->willReturn(['installed' => true, 'tables' => ['items'], 'summary' => ['tables' => [['name' => 'items', 'rows' => 7, 'columns' => 2]], 'bytes' => 4096, 'hiddenTables' => 0]]);
        $this->assertSame(['softn', 'forms'], array_column($tools->call('list_apps', [], self::mcp()), 'kind'));
        $this->assertSame('softn', $tools->call('get_app', ['appId' => 'app-1'], self::mcp())['kind']);
        $over = $tools->call('get_softn_app', ['appId' => 'app-1'], self::mcp());
        $this->assertSame([true, 3, 'members', true, 'https://forms.example/app/notes'], [$over['installed'], $over['version'], $over['access'], $over['backend'], $over['appUrl']]);
        $this->assertSame(['GET /api/items'], $over['routes']);
        $this->assertSame(['items' => 7], $over['database']['tableRows']);
        // A connection that may not read records is told the database's size, not how many rows each table holds.
        $builder = $tools->call('get_softn_app', ['appId' => 'app-1'], self::mcp(['apps:read', 'apps:write']));
        $this->assertSame(['tables' => 1, 'bytes' => 4096], $builder['database']);
        $this->assertStringContainsString('Not published', $over['reach']);
        $this->assertSame('off', $over['files']);
        // A token kept to another app does not reach this one.
        $this->expectException(ChatToolDeniedException::class);
        $tools->call('get_softn_app', ['appId' => 'app-1'], new ChatToolsContext('owner', scopedAppId: 'app-2', source: 'mcp'));
    }

    public function testTheGuideIsServedWholeOverMcpAndBySectionInChat(): void
    {
        [$tools] = $this->tools();
        $this->assertStringStartsWith('# SoftN apps on FormLogic', $tools->call('get_softn_guide', [], self::mcp())['guide']);
        $this->assertStringStartsWith('# How to build a SoftN app', $tools->call('get_softn_guide', ['topic' => 'language'], self::mcp())['guide']);
        $this->assertStringStartsWith('## Files', $tools->callChatTool('get_softn_guide', ['topic' => 'language#files'], new ChatToolsContext('owner'))['guide']);
        $this->assertStringContainsString('## Button', $tools->call('lookup_softn_components', ['names' => ['button']], self::mcp())['components']);
        foreach ([['get_softn_guide', ['topic' => 'no-such-topic']], ['lookup_softn_components', ['names' => 'Button']], ['lookup_softn_components', ['names' => ['Nope']]]] as [$name, $args]) {
            try { $tools->call($name, $args, self::mcp()); $this->fail($name . ' answered ' . json_encode($args)); }
            catch (\InvalidArgumentException $e) { $this->assertNotSame('', $e->getMessage()); }
        }
    }
}
