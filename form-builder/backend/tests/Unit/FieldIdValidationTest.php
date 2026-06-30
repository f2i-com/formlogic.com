<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * Backend field-id validation must match the frontend rules so API-created / imported forms can't
 * introduce ids that break scripting, json_extract paths, search, or exports.
 */
class FieldIdValidationTest extends TestCase
{
    /** @return array<string, array{string}> */
    public static function validIds(): array
    {
        return [
            'simple' => ['full_name'],
            'leading underscore' => ['_internal'],
            'with digits' => ['answer_2'],
            'mixed case' => ['FullName'],
            'empty (server generates)' => [''],
        ];
    }

    /** @dataProvider validIds */
    public function testAcceptsValidIds(string $id): void
    {
        $this->assertNull(FormService::fieldIdError($id));
    }

    /** @return array<string, array{string}> */
    public static function invalidIds(): array
    {
        return [
            'leading digit' => ['401k'],
            'space' => ['full name'],
            'dot (json path)' => ['user.name'],
            'dollar (json path)' => ['$.evil'],
            'bracket' => ['a[0]'],
            'quote' => ["a'b"],
            'hyphen' => ['full-name'],
            'reserved sum' => ['sum'],
            'reserved count' => ['count'],
            'reserved format' => ['format'],
            'too long' => [str_repeat('a', 65)],
        ];
    }

    /** @dataProvider invalidIds */
    public function testRejectsUnsafeIds(string $id): void
    {
        $this->assertNotNull(FormService::fieldIdError($id), "expected '$id' to be rejected");
    }
}
