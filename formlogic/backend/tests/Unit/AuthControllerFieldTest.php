<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AuthController;
use PHPUnit\Framework\TestCase;

/**
 * A field of a request's body as the sign-in and password routes read it (AuthController::field): its text, or a number
 * as written; anything else as a field left out. Cast, an array said "Array to string conversion" into the answer where
 * PHP shows its warnings (a DELETE /api/auth/me whose password was a list), and into the log where it does not.
 */
final class AuthControllerFieldTest extends TestCase
{
    public function testAFieldIsItsTextAndAnythingElseIsNone(): void
    {
        $field = new \ReflectionMethod(AuthController::class, 'field');
        $this->assertSame('hunter2', $field->invoke(null, ['password' => 'hunter2'], 'password'));
        $this->assertSame('123456', $field->invoke(null, ['code' => 123456], 'code'));
        $said = [];
        set_error_handler(static function (int $level, string $message) use (&$said): bool { $said[] = $message; return true; });
        try {
            foreach ([['password' => ['a', 'b']], ['password' => ['nested' => ['x']]], ['password' => null], ['password' => true], [], null, 'text'] as $data) {
                $this->assertSame('', $field->invoke(null, $data, 'password'), (string) json_encode($data));
            }
        } finally {
            restore_error_handler();
        }
        $this->assertSame([], $said, 'no warning');
    }
}
