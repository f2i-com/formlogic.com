<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\ApplicationPackageV2Validator;
use PHPUnit\Framework\TestCase;

/**
 * DOC-704: the authoring guide's acceptance criterion is that a third-party author can build a
 * package "from docs alone". A worked example that no longer validates fails that silently —
 * the author follows it, gets a refusal, and has no way to know the doc was the problem.
 *
 * So every Application Package v2 example in docs/EXTENSIONS.md is parsed and run through the
 * REAL validator here. Examples are `jsonc` (commented) for readability; comments are stripped
 * the same way a reader mentally does, taking care not to cut a `//` that lives inside a string.
 */
class ExtensionDocsExamplesTest extends TestCase
{
    private const DOC = __DIR__ . '/../../../../docs/EXTENSIONS.md';

    /** Strip `// …` line comments that are NOT inside a JSON string. */
    private function stripLineComments(string $jsonc): string
    {
        $out = [];
        foreach (explode("\n", $jsonc) as $line) {
            $inString = false;
            $escaped = false;
            $cut = null;
            $length = strlen($line);
            for ($i = 0; $i < $length; $i++) {
                $c = $line[$i];
                if ($escaped) {
                    $escaped = false;
                    continue;
                }
                if ($c === '\\') {
                    $escaped = true;
                    continue;
                }
                if ($c === '"') {
                    $inString = !$inString;
                    continue;
                }
                if (!$inString && $c === '/' && $i + 1 < $length && $line[$i + 1] === '/') {
                    $cut = $i;
                    break;
                }
            }
            $out[] = $cut === null ? $line : rtrim(substr($line, 0, $cut));
        }
        // Trailing commas left by a removed trailing entry would be invalid JSON; the examples
        // do not use them, so anything failing here is a genuine doc defect worth surfacing.
        return implode("\n", $out);
    }

    /** @return list<array{0:int,1:array<string,mixed>}> [blockIndex, decoded] */
    private function jsoncBlocks(): array
    {
        $doc = file_get_contents(self::DOC);
        $this->assertIsString($doc, 'docs/EXTENSIONS.md must be readable');
        preg_match_all('/```jsonc\n(.*?)```/s', $doc, $matches);
        $blocks = [];
        foreach ($matches[1] as $index => $raw) {
            $stripped = trim($this->stripLineComments($raw));
            // A block that does not open with `{` is a deliberate EXCERPT (one field shown in
            // context) — not something a reader would paste whole. Only complete documents are
            // held to parsing, so an excerpt cannot silently exempt a broken full example.
            if (!str_starts_with($stripped, '{')) {
                continue;
            }
            $decoded = json_decode($stripped, true);
            $this->assertIsArray(
                $decoded,
                "docs/EXTENSIONS.md jsonc block #$index is not parseable JSON once comments are stripped: " . json_last_error_msg()
            );
            $blocks[] = [$index, $decoded];
        }
        return $blocks;
    }

    public function testEveryDocumentedV2AggregateValidates(): void
    {
        $checked = 0;
        foreach ($this->jsoncBlocks() as [$index, $decoded]) {
            if (($decoded['formatVersion'] ?? null) !== 2) {
                continue; // a plugin manifest / definition / fragment, not an aggregate
            }
            $issues = ApplicationPackageV2Validator::validatePackage($decoded);
            $this->assertSame(
                [],
                $issues,
                "docs/EXTENSIONS.md jsonc block #$index does not validate: " . json_encode($issues)
            );
            $checked++;
        }
        // Both quickstarts (node-only and service-backed) are full aggregates; if this drops,
        // an example was removed or silently reshaped into something no longer checked.
        $this->assertGreaterThanOrEqual(2, $checked, 'expected at least the two quickstart aggregates');
    }

    public function testDocumentedPluginServiceDefinitionsMatchTheHostRules(): void
    {
        // SRV-401 namespace rule, mirrored here so the doc example cannot drift from the
        // Desktop registry's actual requirement (id == plugin id, or "<plugin-id>." prefix).
        $pluginIds = [];
        $definitions = [];
        foreach ($this->jsoncBlocks() as [, $decoded]) {
            if (isset($decoded['serviceDefinitions']) && is_string($decoded['id'] ?? null)) {
                $pluginIds[] = $decoded['id'];
            }
            if (($decoded['schemaVersion'] ?? null) === 3 && isset($decoded['actions'])) {
                $definitions[] = $decoded;
            }
        }
        $this->assertNotEmpty($pluginIds, 'the guide documents a v3 plugin manifest');
        $this->assertNotEmpty($definitions, 'the guide documents a service definition');

        foreach ($definitions as $definition) {
            $id = (string) $definition['id'];
            $owned = false;
            foreach ($pluginIds as $pluginId) {
                if ($id === $pluginId || str_starts_with($id, $pluginId . '.')) {
                    $owned = true;
                }
            }
            $this->assertTrue($owned, "documented definition id {$id} is outside every documented plugin's namespace");
            $this->assertNotEmpty($definition['actions'], "documented definition {$id} declares no actions");
            foreach ($definition['actions'] as $action) {
                // The host only executes /v1/* over the credential-holding gateway.
                $path = (string) ($action['transport']['path'] ?? '');
                $this->assertStringStartsWith('/v1/', $path, "documented action path {$path} is outside the executable surface");
            }
        }
    }
}
