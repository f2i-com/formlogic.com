<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\McpController;
use FormLogic\Services\ChatToolsService;
use PHPUnit\Framework\TestCase;

/**
 * What the MCP server and the chat catalogs tell an AI about a form's onSubmit script is what that
 * AI writes. The get_started guide once listed `ctx.setField`, `ctx.reject`, `ctx.setStatus` and
 * `ctx.addTag`, none of which the sandbox defines (they live under ctx.db, and a refusal is a
 * return value): a script written from it throws, and every submission to the form is refused.
 *
 * Every text that describes the script is held here to the guest that builds ctx
 * (formlogic/runtime/guest/src/main.rs), and so are the scripts the sample apps ship. These are
 * text checks and need no sandbox; McpOnSubmitScriptGuideTest runs the guide's example in one.
 */
class McpOnSubmitGuideTextTest extends TestCase
{
    /** One of McpController's private texts (it is built without its services: the texts use none). */
    private static function controllerText(string $method): string
    {
        $controller = (new \ReflectionClass(McpController::class))->newInstanceWithoutConstructor();
        $m = new \ReflectionMethod(McpController::class, $method);
        $m->setAccessible(true);
        return (string) $m->invoke($controller);
    }

    /**
     * The guide's "## onSubmit script" section, with Unix line ends: the guide is a
     * nowdoc in McpController.php, which a checkout with core.autocrlf (a Windows
     * clone) writes with CRLF, and the example script is matched line by line.
     */
    public static function onSubmitSection(string $guide): string
    {
        $guide = str_replace("\r\n", "\n", $guide);
        self::assertSame(1, preg_match('/^## onSubmit script.*?(?=^## )/ms', $guide, $m), 'the guide has an onSubmit section');
        return $m[0];
    }

    /**
     * What the sandbox puts on ctx, read from the guest that builds it: plain keys (answers,
     * meta) map to [], modules (db, utils, http, flows) to their methods.
     *
     * @return array<string, list<string>>
     */
    private static function sandboxContext(): array
    {
        $guest = dirname(__DIR__, 3) . '/runtime/guest/src/main.rs';
        if (!is_file($guest)) {
            self::markTestSkipped('The sandbox guest source is not in this checkout');
        }
        $src = (string) file_get_contents($guest);
        $ctx = [];
        preg_match_all('/^\s*(\w+): __ctxRaw\.\w+/m', $src, $plain);
        foreach ($plain[1] as $key) {
            $ctx[$key] = [];
        }
        preg_match_all('/^\s*(\w+): __module\("\w+", \[([^\]]*)\]\)/m', $src, $mods, PREG_SET_ORDER);
        foreach ($mods as $mod) {
            preg_match_all('/"(\w+)"/', $mod[2], $methods);
            $ctx[$mod[1]] = $methods[1];
        }
        self::assertArrayHasKey('answers', $ctx, 'read ctx from the guest');
        self::assertContains('setField', $ctx['db'] ?? [], 'read ctx.db from the guest');
        return $ctx;
    }

    /** @return list<string> every ctx.<name>[.<method>] the text names that the sandbox does not define */
    private static function unknownContextNames(string $text): array
    {
        $ctx = self::sandboxContext();
        preg_match_all('/\bctx\.(\w+)(?:\.(\w+))?/', $text, $refs, PREG_SET_ORDER);
        $unknown = [];
        foreach ($refs as $ref) {
            $top = $ref[1];
            $method = $ref[2] ?? '';
            if (!array_key_exists($top, $ctx)) {
                $unknown[] = 'ctx.' . $top;
            } elseif ($ctx[$top] !== [] && $method !== '' && !in_array($method, $ctx[$top], true)) {
                $unknown[] = 'ctx.' . $top . '.' . $method;
            }
        }
        return array_values(array_unique($unknown));
    }

    public function testTheGuideNamesOnlyWhatTheSandboxPutsOnCtx(): void
    {
        $section = self::onSubmitSection(self::controllerText('guide'));
        $this->assertSame([], self::unknownContextNames($section), "the guide's onSubmit section names ctx members the sandbox does not define");
        foreach (['ctx.db.setField', 'ctx.db.setStatus', 'ctx.db.addTag', 'ctx.answers', 'reject: true'] as $needed) {
            $this->assertStringContainsString($needed, $section);
        }
        $this->assertSame(1, preg_match('/^function onSubmit\(ctx\) \{\n.*?^\}$/ms', $section), 'the section carries an example script');
    }

    public function testTheInitializeInstructionsNameOnlyWhatTheSandboxDefines(): void
    {
        $this->assertSame([], self::unknownContextNames(self::controllerText('serverInstructions')));
    }

    /**
     * Every tool that takes an onSubmit script (MCP and chat catalogs alike) says in its schema
     * what the script may call, and names nothing else. (A hosted app's private actions have a ctx
     * of their own, described on publish_app_project; that is not this one.)
     */
    public function testEveryToolThatTakesAScriptDescribesTheRealApi(): void
    {
        $seen = 0;
        foreach (array_merge(ChatToolsService::toolDefinitions(), ChatToolsService::chatCatalog()) as $tool) {
            if (!isset($tool['inputSchema']['properties']['logicScript'])) {
                continue;
            }
            $seen++;
            $text = $tool['description'] . "\n" . ($tool['inputSchema']['properties']['logicScript']['description'] ?? '');
            $this->assertSame([], self::unknownContextNames($text), $tool['name']);
            $this->assertStringContainsString('ctx.db.setField', $text, $tool['name']);
        }
        $this->assertGreaterThanOrEqual(6, $seen, 'create_form, create_app_form and update_form in both catalogs');
    }

    /**
     * The "Try a sample app" packs carry onSubmit scripts too, and the Expense sample's called a
     * top-level ctx.addTag: every expense over 500 was refused.
     */
    public function testTheShippedSampleAppsScriptsCallOnlyWhatTheSandboxDefines(): void
    {
        $scripts = 0;
        foreach (glob(dirname(__DIR__, 2) . '/resources/sample-apps/*.json') ?: [] as $file) {
            $pack = json_decode((string) file_get_contents($file), true);
            foreach ((array) ($pack['forms'] ?? []) as $form) {
                $script = (string) ($form['logicScript'] ?? '');
                if (trim($script) === '') {
                    continue;
                }
                $scripts++;
                $this->assertSame([], self::unknownContextNames($script), basename($file) . ': ' . ($form['title'] ?? ''));
            }
        }
        $this->assertGreaterThan(0, $scripts);
    }
}
