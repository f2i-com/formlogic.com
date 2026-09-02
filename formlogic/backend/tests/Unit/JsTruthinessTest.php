<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\ResponseService;
use PHPUnit\Framework\TestCase;

/**
 * A condition's result is coerced with JavaScript's rules on BOTH sides.
 *
 * The browser does `Boolean(result)`. The server used to do `(bool)`, which
 * disagrees on exactly the values a form produces: `"0"` (a text answer) is
 * truthy in JS and falsy in PHP; an emptied checkbox decodes to `[]` — truthy in
 * JS (an object), falsy in PHP. Each disagreement made the client hide a field
 * the server then required, or the reverse.
 */
class JsTruthinessTest extends TestCase
{
    /** @return iterable<string, array{mixed, bool}> */
    public static function values(): iterable
    {
        yield 'null' => [null, false];
        yield 'false' => [false, false];
        yield 'true' => [true, true];
        yield 'zero int' => [0, false];
        yield 'zero float' => [0.0, false];
        yield 'negative zero' => [-0.0, false];
        yield 'NaN' => [NAN, false];
        yield 'one' => [1, true];
        yield 'negative' => [-3, true];
        yield 'empty string' => ['', false];
        yield 'the string "0" — truthy in JS, falsy under (bool)' => ['0', true];
        yield 'the string "false"' => ['false', true];
        yield 'whitespace' => [' ', true];
        yield 'empty array/object from JSON — truthy in JS, falsy under (bool)' => [[], true];
        yield 'non-empty array' => [[1], true];
        yield 'object' => [['a' => 1], true];
    }

    /** @dataProvider values */
    public function testMatchesJavaScript(mixed $value, bool $expected): void
    {
        self::assertSame($expected, ResponseService::jsTruthy($value));
    }
}
