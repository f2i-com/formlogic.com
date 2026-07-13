<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\ResponseService;
use PHPUnit\Framework\TestCase;

/**
 * Phone-normalized equality behind the flow filter op `phone_eq`
 * (answersPhoneEq pushdown): both sides reduced to digits and compared on the
 * last-9-digit suffix, so '+61 491 570 156' matches '0491570156' regardless of
 * stored formatting. The exact rule is mirrored in the browser executor
 * (nodes.ts phoneDigitsMatch) and the desktop Rust runner (phone_digits_match)
 * — change one, change all three.
 */
class PhoneDigitsMatchTest extends TestCase
{
    public function testMatchesAcrossFormats(): void
    {
        $this->assertTrue(ResponseService::phoneDigitsMatch('0491 570 156', '+61491570156'));
        $this->assertTrue(ResponseService::phoneDigitsMatch('+61 491 570 156', '0491570156'));
        $this->assertTrue(ResponseService::phoneDigitsMatch('(04) 9157-0156', '0491570156'));
    }

    public function testDifferentNumbersDoNotMatch(): void
    {
        $this->assertFalse(ResponseService::phoneDigitsMatch('0491570156', '0432602110'));
    }

    public function testShortFragmentsNeverMatch(): void
    {
        // A short fragment matching everything would be worse than no filter.
        $this->assertFalse(ResponseService::phoneDigitsMatch('243', '0491570156'));
        $this->assertFalse(ResponseService::phoneDigitsMatch('0491570156', '5243'));
        $this->assertFalse(ResponseService::phoneDigitsMatch('', '0491570156'));
        $this->assertFalse(ResponseService::phoneDigitsMatch('no digits here', '0491570156'));
    }

    public function testLongInternationalFormsCompareOnLastNine(): void
    {
        // Country code differences beyond the last 9 digits are ignored — the
        // same convention every Aokie caller lookup has used since day one.
        $this->assertTrue(ResponseService::phoneDigitsMatch('61491570156', '0061491570156'));
    }
}
