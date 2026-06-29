<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AuthService;
use PHPUnit\Framework\TestCase;

/**
 * Password strength rules (register / reset / change all route through
 * AuthService::passwordError, so testing it here covers every entry point).
 */
class PasswordPolicyTest extends TestCase
{
    public function testRejectsTooShort(): void
    {
        $this->assertNotNull(AuthService::passwordError('short12'));      // 7
        $this->assertNotNull(AuthService::passwordError('123456789'));    // 9
    }

    public function testRejectsCommonPasswords(): void
    {
        $this->assertNotNull(AuthService::passwordError('1234567890'));   // common + 10 chars
        $this->assertNotNull(AuthService::passwordError('QWERTYUIOP'));   // case-insensitive match
        $this->assertNotNull(AuthService::passwordError('changeme'));
    }

    public function testAcceptsStrongPasswords(): void
    {
        $this->assertNull(AuthService::passwordError('correct horse battery'));
        $this->assertNull(AuthService::passwordError('Tr0ub4dour&3xtra'));
    }

    public function testMinimumLengthIsTen(): void
    {
        $this->assertSame(10, AuthService::MIN_PASSWORD_LENGTH);
        $this->assertNull(AuthService::passwordError('abcdef1234')); // exactly 10, not common
    }
}
