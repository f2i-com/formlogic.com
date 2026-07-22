<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * Legacy field-type aliases (text/textarea) must map onto the canonical types so older
 * or imported schemas never reach the renderer with an unknown type ("Field type not
 * supported"). Mirrors the UI normalizeFieldType() in ui/src/types/form.ts.
 */
class FieldTypeAliasTest extends TestCase
{
    /** @return array<string, array{string, string}> */
    public static function aliases(): array
    {
        return [
            'text → short_text' => ['text', 'short_text'],
            'textarea → long_text' => ['textarea', 'long_text'],
        ];
    }

    /** @dataProvider aliases */
    public function testLegacyAliasesMapToCanonicalTypes(string $legacy, string $canonical): void
    {
        $this->assertSame($canonical, FormService::normalizeFieldType($legacy));
    }

    /** @return array<string, array{string}> */
    public static function canonicalAndUnknown(): array
    {
        return [
            'short_text' => ['short_text'],
            'long_text' => ['long_text'],
            'file_upload' => ['file_upload'],
            'unknown passes through' => ['hologram'],
            'empty passes through' => [''],
        ];
    }

    /** @dataProvider canonicalAndUnknown */
    public function testCanonicalAndUnknownTypesPassThrough(string $type): void
    {
        $this->assertSame($type, FormService::normalizeFieldType($type));
    }
}
