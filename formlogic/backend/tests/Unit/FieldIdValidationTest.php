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

    /**
     * A field id becomes a global inside the sandbox. One that shadows a
     * JavaScript global or a wrapper name breaks every expression on that form:
     * `Object` as a field id makes the context installer itself throw, and a
     * `__`-prefixed id could replace the wrapper's reply channel.
     */
    public function testRejectsIdsThatWouldBreakTheSandbox(): void
    {
        foreach (['Object', 'Array', 'JSON', 'Math', 'Date', 'globalThis', 'undefined', 'eval', 'ctx', 'console'] as $id) {
            $this->assertNotNull(FormService::fieldIdError($id), "expected '$id' (a JS global) to be rejected");
        }
        foreach (['__replies', '__jobs', '__emit', '__anything'] as $id) {
            $this->assertNotNull(FormService::fieldIdError($id), "expected '$id' (runtime prefix) to be rejected");
        }
        $this->assertNull(FormService::fieldIdError('_private_ok'), 'a single leading underscore is an ordinary id');
        $this->assertNull(FormService::fieldIdError('date_of_birth'));
    }

    /** @dataProvider invalidIds */
    public function testRejectsUnsafeIds(string $id): void
    {
        $this->assertNotNull(FormService::fieldIdError($id), "expected '$id' to be rejected");
    }
}
