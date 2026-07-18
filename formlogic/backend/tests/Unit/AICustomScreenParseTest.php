<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AIService;
use PHPUnit\Framework\TestCase;

/**
 * Locks the AI screen-reply parser: the preferred multi-file TSX format (fences tagged
 * `file=path`), the un-tagged lone-tsx tolerance, path sanitization, and the legacy
 * html/css/js triple + JSON fallbacks staying intact.
 */
final class AICustomScreenParseTest extends TestCase
{
    private AIService $ai;

    protected function setUp(): void
    {
        $this->ai = new AIService();
    }

    public function testNamedFileFencesBecomeAFilesProject(): void
    {
        $reply = "```tsx file=index.tsx\nimport { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')!).render(<h1>hi</h1>);\n```\n"
            . "```css file=styles.css\nbody { margin: 0; }\n```\n"
            . "```tsx file=components/Card.tsx\nexport const Card = () => <div class=\"card\" />;\n```\n";
        $out = $this->ai->parseCustomScreen($reply);
        $paths = array_column($out['files'] ?? [], 'path');
        $this->assertSame(['index.tsx', 'styles.css', 'components/Card.tsx'], $paths);
        $this->assertStringContainsString('createRoot', $out['files'][0]['content']);
        $this->assertSame('', $out['js']);
    }

    public function testUntaggedCssAndHtmlBlocksJoinANamedFenceProject(): void
    {
        // Real-model behavior: a tagged index.tsx plus an UNTAGGED css block.
        $reply = "```tsx file=index.tsx\nimport './styles.css';\nconst a = 1;\n```\n"
            . "```css\n.counter { color: red; }\n```\n";
        $out = $this->ai->parseCustomScreen($reply);
        $this->assertSame(['index.tsx', 'styles.css'], array_column($out['files'] ?? [], 'path'));
        $this->assertStringContainsString('.counter', $out['files'][1]['content']);
    }

    public function testTraversalAndBadExtensionPathsAreDropped(): void
    {
        $reply = "```tsx file=index.tsx\nconst a = 1;\n```\n"
            . "```tsx file=../../evil.tsx\nconst b = 2;\n```\n"
            . "```js file=run.exe\nconst c = 3;\n```\n";
        $out = $this->ai->parseCustomScreen($reply);
        $this->assertSame(['index.tsx'], array_column($out['files'] ?? [], 'path'));
    }

    public function testNamedFencesWithoutAnEntryFallThroughToLegacyParsing(): void
    {
        // Only a helper file, no index.* — not a runnable project; the legacy triple wins.
        $reply = "```tsx file=components/Card.tsx\nexport const Card = () => null;\n```\n"
            . "```html\n<div id=\"app\"></div>\n```\n```css\nbody{}\n```\n```js\nconsole.log(1);\n```\n";
        $out = $this->ai->parseCustomScreen($reply);
        $this->assertArrayNotHasKey('files', $out);
        $this->assertSame('<div id="app"></div>', $out['html']);
        $this->assertSame('console.log(1);', $out['js']);
    }

    public function testLoneUntaggedTsxFenceBecomesTheEntry(): void
    {
        $reply = "```tsx\nimport { render } from 'preact';\nrender(<p>x</p>, document.getElementById('root')!);\n```\n```css\nbody { margin: 0 }\n```\n";
        $out = $this->ai->parseCustomScreen($reply);
        $this->assertSame(['index.tsx', 'styles.css'], array_column($out['files'] ?? [], 'path'));
    }

    public function testLegacyTripleStillParses(): void
    {
        $reply = "```html\n<main></main>\n```\n```css\nmain{display:block}\n```\n```javascript\ndocument.title='x';\n```\n";
        $out = $this->ai->parseCustomScreen($reply);
        $this->assertArrayNotHasKey('files', $out);
        $this->assertSame('<main></main>', $out['html']);
        $this->assertSame("document.title='x';", $out['js']);
    }

    public function testJsonFallbackStillParses(): void
    {
        $reply = 'Here you go: {"html":"<div></div>","css":"","js":"console.log(2);"}';
        $out = $this->ai->parseCustomScreen($reply);
        $this->assertSame('<div></div>', $out['html']);
        $this->assertSame('console.log(2);', $out['js']);
    }

    public function testEmptyReplyThrows(): void
    {
        $this->expectExceptionMessage('No screen content found');
        $this->ai->parseCustomScreen('sorry, I cannot do that');
    }
}
