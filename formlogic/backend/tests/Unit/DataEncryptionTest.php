<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\DataEncryption;
use FormLogic\Support\DataEncryptionException;
use PHPUnit\Framework\TestCase;

final class DataEncryptionTest extends TestCase
{
    private const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    private const OTHER = 'ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

    /** @var array<string, mixed> */
    private array $saved = [];

    protected function setUp(): void
    {
        foreach ([DataEncryption::KEY_ENV, DataEncryption::PREVIOUS_KEYS_ENV] as $name) {
            $this->saved[$name] = $_ENV[$name] ?? null;
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->saved as $name => $value) {
            unset($_ENV[$name]);
            if ($value !== null) {
                $_ENV[$name] = $value;
            }
        }
    }

    private function crypto(?string $key = self::KEY, ?string $previous = null): DataEncryption
    {
        unset($_ENV[DataEncryption::KEY_ENV], $_ENV[DataEncryption::PREVIOUS_KEYS_ENV]);
        if ($key !== null) {
            $_ENV[DataEncryption::KEY_ENV] = $key;
        }
        if ($previous !== null) {
            $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] = $previous;
        }
        return DataEncryption::fromEnvironment();
    }

    public function testAValueReadsBackOnlyFromWhereItWasStored(): void
    {
        $crypto = $this->crypto();
        $sealed = $crypto->seal('JBSWY3DPEHPK3PXP', 'users.mfa_secret:a');

        self::assertTrue(DataEncryption::isSealed($sealed));
        self::assertStringNotContainsString('JBSWY3DPEHPK3PXP', $sealed);
        self::assertSame('JBSWY3DPEHPK3PXP', $crypto->open($sealed, 'users.mfa_secret:a'));

        $this->expectException(DataEncryptionException::class);
        $crypto->open($sealed, 'users.mfa_secret:b');
    }

    public function testSealingTwiceGivesDifferentText(): void
    {
        $crypto = $this->crypto();
        self::assertNotSame($crypto->seal('same', 'c'), $crypto->seal('same', 'c'));
    }

    public function testAChangedValueIsRefused(): void
    {
        $crypto = $this->crypto();
        $sealed = $crypto->seal('secret', 'c');
        $body = DataEncryption::decode(explode('.', $sealed, 3)[2]);
        $body[30] = chr(ord($body[30]) ^ 1);

        $this->expectException(DataEncryptionException::class);
        $crypto->open('fle1.' . $crypto->currentKeyId() . '.' . DataEncryption::encode($body), 'c');
    }

    public function testAValueFromBeforeTheKeyReadsAsItself(): void
    {
        self::assertSame('{"a":1}', $this->crypto()->open('{"a":1}', 'c'));
        self::assertSame('JBSWY3DPEHPK3PXP', $this->crypto(null)->open('JBSWY3DPEHPK3PXP', 'c'));
    }

    public function testWithNoKeyNothingChanges(): void
    {
        $crypto = $this->crypto(null);
        self::assertFalse($crypto->enabled());
        self::assertTrue($crypto->usable());
        self::assertSame('plain', $crypto->seal('plain', 'c'));
    }

    public function testAKeyThatCannotBeUsedNeverStoresPlainText(): void
    {
        $crypto = $this->crypto('too-short');
        self::assertFalse($crypto->enabled());
        self::assertFalse($crypto->usable());

        $this->expectException(DataEncryptionException::class);
        $crypto->seal('plain', 'c');
    }

    public function testALostKeyMeansNoReadingNotAWrongAnswer(): void
    {
        $sealed = $this->crypto()->seal('secret', 'c');

        $this->expectException(DataEncryptionException::class);
        $this->crypto(null)->open($sealed, 'c');
    }

    public function testAnotherServersKeyCannotRead(): void
    {
        $sealed = $this->crypto()->seal('secret', 'c');

        $this->expectException(DataEncryptionException::class);
        $this->crypto(self::OTHER)->open($sealed, 'c');
    }

    public function testBase64KeysWork(): void
    {
        $crypto = $this->crypto('base64:' . base64_encode(hex2bin(self::KEY)));
        self::assertTrue($crypto->enabled());
        self::assertSame($this->crypto()->currentKeyId(), $crypto->currentKeyId());
        self::assertSame('v', $this->crypto()->open($crypto->seal('v', 'c'), 'c'));
    }

    public function testRotationReadsTheOldKeyAndMovesValuesOntoTheNewOne(): void
    {
        $old = $this->crypto()->seal('secret', 'c');
        $rotated = $this->crypto(self::OTHER, self::KEY);

        self::assertSame('secret', $rotated->open($old, 'c'));
        $moved = $rotated->resealed($old, 'c');
        self::assertNotSame($old, $moved);
        self::assertSame($moved, $rotated->resealed($moved, 'c'), 'a value on the current key is left alone');
        self::assertSame('secret', $this->crypto(self::OTHER)->open($moved, 'c'), 'the old key is no longer needed');
    }

    public function testResealingEncryptsAPlainValue(): void
    {
        $crypto = $this->crypto();
        self::assertSame('plain', $crypto->open($crypto->resealed('plain', 'c'), 'c'));
        self::assertTrue(DataEncryption::isSealed($crypto->resealed('plain', 'c')));
    }

    public function testALongSecretFitsItsColumn(): void
    {
        self::assertLessThanOrEqual(255, strlen($this->crypto()->seal(str_repeat('f', 64), 'webhooks.secret:' . str_repeat('a', 36))));
    }

    public function testGeneratedKeysAreUsable(): void
    {
        self::assertTrue($this->crypto(DataEncryption::generateKey())->enabled());
    }
}
