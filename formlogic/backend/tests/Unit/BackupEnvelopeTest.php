<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\DataEncryption;
use FormLogic\Support\DataEncryptionException;
use PHPUnit\Framework\TestCase;

final class BackupEnvelopeTest extends TestCase
{
    private const PLANTED = 'planted-backup-contents';
    private string $dir = '';
    /** @var array<string, mixed> */
    private array $saved = [];

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-envelope-' . bin2hex(random_bytes(6));
        mkdir($this->dir);
        foreach ([DataEncryption::KEY_ENV, DataEncryption::PREVIOUS_KEYS_ENV] as $name) {
            $this->saved[$name] = $_ENV[$name] ?? null;
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dir);
        foreach ($this->saved as $name => $value) {
            unset($_ENV[$name]);
            if ($value !== null) {
                $_ENV[$name] = $value;
            }
        }
    }

    private function source(string $contents = self::PLANTED): string
    {
        $path = $this->dir . '/plain.zip';
        file_put_contents($path, $contents);
        return $path;
    }

    private function server(string $key = 'aa'): DataEncryption
    {
        $_ENV[DataEncryption::KEY_ENV] = str_repeat($key, 32);
        return DataEncryption::fromEnvironment();
    }

    /** @return array{0: string, 1: string} public, secret */
    private function keys(): array
    {
        [$public, $secret] = BackupEnvelope::generateKeyPair();
        return [base64_decode($public), base64_decode($secret)];
    }

    public function testAPublicKeyRecipientCanOpenWhatTheServerCannot(): void
    {
        [$public, $secret] = $this->keys();
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(), $sealed, ['publicKey' => $public]);

        self::assertTrue(BackupEnvelope::isSealed($sealed));
        self::assertStringNotContainsString(self::PLANTED, (string) file_get_contents($sealed));
        self::assertFileExists($this->dir . '/plain.zip', 'the original is the caller\'s to remove');

        BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['secretKey' => $secret]);
        self::assertSame(self::PLANTED, file_get_contents($this->dir . '/opened.zip'));

        $this->expectException(DataEncryptionException::class);
        BackupEnvelope::open($sealed, $this->dir . '/nope.zip', ['server' => $this->server()]);
    }

    public function testTheWrongSecretKeyOpensNothing(): void
    {
        [$public] = $this->keys();
        [, $other] = $this->keys();
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(), $sealed, ['publicKey' => $public]);

        try {
            BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['secretKey' => $other]);
            self::fail('another key opened it');
        } catch (DataEncryptionException) {
            self::assertFileDoesNotExist($this->dir . '/opened.zip');
        }
    }

    public function testAPassphraseOpensItAndAWrongOneDoesNot(): void
    {
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(), $sealed, ['passphrase' => 'correct horse battery']);

        BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['passphrase' => 'correct horse battery']);
        self::assertSame(self::PLANTED, file_get_contents($this->dir . '/opened.zip'));

        $this->expectExceptionMessage('That does not open this backup');
        BackupEnvelope::open($sealed, $this->dir . '/nope.zip', ['passphrase' => 'wrong horse battery']);
    }

    public function testAFileCanHaveSeveralWaysIn(): void
    {
        [$public, $secret] = $this->keys();
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(), $sealed, ['publicKey' => $public, 'passphrase' => 'correct horse battery']);

        BackupEnvelope::open($sealed, $this->dir . '/a.zip', ['secretKey' => $secret]);
        BackupEnvelope::open($sealed, $this->dir . '/b.zip', ['passphrase' => 'correct horse battery']);
        self::assertSame(self::PLANTED, file_get_contents($this->dir . '/b.zip'));
    }

    public function testTheServerCanOpenWhatItSealedForItself(): void
    {
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(), $sealed, ['server' => $this->server()]);

        BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['server' => DataEncryption::fromEnvironment()]);
        self::assertSame(self::PLANTED, file_get_contents($this->dir . '/opened.zip'));

        $this->expectException(DataEncryptionException::class);
        BackupEnvelope::open($sealed, $this->dir . '/nope.zip', ['server' => $this->server('bb')]);
    }

    public function testTheServerCannotSealForItselfWithNoKey(): void
    {
        $this->expectExceptionMessage('DATA_ENCRYPTION_KEY');
        BackupEnvelope::seal($this->source(), $this->dir . '/sealed.flbk', ['server' => DataEncryption::fromEnvironment()]);
    }

    public function testSealingForNobodyIsRefused(): void
    {
        $this->expectExceptionMessage('someone who can open it');
        BackupEnvelope::seal($this->source(), $this->dir . '/sealed.flbk', []);
    }

    public function testRewrappingMovesTheFileToANewKeyWithoutTouchingItsChunks(): void
    {
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(str_repeat('x', 5_000_000)), $sealed, ['server' => $this->server()]);
        $old = (string) file_get_contents($sealed);

        $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] = str_repeat('aa', 32);
        self::assertTrue(BackupEnvelope::rewrap($sealed, $this->server('bb')));
        self::assertStringEndsWith(substr($old, -5_000_000), (string) file_get_contents($sealed));
        self::assertFalse(BackupEnvelope::rewrap($sealed, DataEncryption::fromEnvironment()), 'already on the current key');

        unset($_ENV[DataEncryption::PREVIOUS_KEYS_ENV]);
        BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['server' => $this->server('bb')]);
        self::assertSame(5_000_000, filesize($this->dir . '/opened.zip'));
    }

    public function testAFileLargerThanAChunkComesBackWhole(): void
    {
        [$public, $secret] = $this->keys();
        $contents = random_bytes(BackupEnvelope::CHUNK_BYTES + 1234);
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source($contents), $sealed, ['publicKey' => $public]);

        BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['secretKey' => $secret]);
        self::assertSame(hash('sha256', $contents), hash_file('sha256', $this->dir . '/opened.zip'));
    }

    /** @return array<string, array{callable(string): string}> */
    public static function damage(): array
    {
        return [
            'a byte changed' => [static function (string $file): string {
                $file[strlen($file) - 40] = chr(ord($file[strlen($file) - 40]) ^ 1);
                return $file;
            }],
            'the last chunk dropped' => [static fn (string $file): string => substr($file, 0, -(4 + 1000 + 16))],
            'cut short inside a chunk' => [static fn (string $file): string => substr($file, 0, -10)],
            'something added' => [static fn (string $file): string => $file . 'x'],
        ];
    }

    /** @dataProvider damage */
    public function testADamagedFileOpensNothing(callable $damage): void
    {
        [$public, $secret] = $this->keys();
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(random_bytes(BackupEnvelope::CHUNK_BYTES + 1000)), $sealed, ['publicKey' => $public]);
        file_put_contents($sealed, $damage((string) file_get_contents($sealed)));

        try {
            BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['secretKey' => $secret]);
            self::fail('a damaged file opened');
        } catch (DataEncryptionException) {
            self::assertSame([], glob($this->dir . '/opened.zip*'), 'nothing half-restored is left behind');
        }
    }

    public function testChunksCannotBeSwapped(): void
    {
        [$public, $secret] = $this->keys();
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(random_bytes(BackupEnvelope::CHUNK_BYTES * 2)), $sealed, ['publicKey' => $public]);
        $file = (string) file_get_contents($sealed);
        $headerEnd = strlen(BackupEnvelope::MAGIC) + 4 + unpack('N', substr($file, strlen(BackupEnvelope::MAGIC), 4))[1];
        $chunk = 4 + BackupEnvelope::CHUNK_BYTES + 16;
        file_put_contents($sealed, substr($file, 0, $headerEnd) . substr($file, $headerEnd + $chunk, $chunk) . substr($file, $headerEnd, $chunk));

        $this->expectExceptionMessage('This backup is damaged');
        BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['secretKey' => $secret]);
    }

    public function testAnUploadCannotAskForUnlimitedMemory(): void
    {
        $sealed = $this->dir . '/sealed.flbk';
        BackupEnvelope::seal($this->source(), $sealed, ['passphrase' => 'correct horse battery']);
        $file = (string) file_get_contents($sealed);
        $magic = strlen(BackupEnvelope::MAGIC);
        $length = unpack('N', substr($file, $magic, 4))[1];
        $header = json_decode(substr($file, $magic + 4, $length), true);
        $header['recipients'][0]['memLimit'] = 1 << 40;
        $json = json_encode($header);
        file_put_contents($sealed, BackupEnvelope::MAGIC . pack('N', strlen($json)) . $json . substr($file, $magic + 4 + $length));

        $this->expectExceptionMessage('This backup is damaged');
        BackupEnvelope::open($sealed, $this->dir . '/opened.zip', ['passphrase' => 'correct horse battery']);
    }

    public function testAPlainFileIsNotSealed(): void
    {
        self::assertFalse(BackupEnvelope::isSealed($this->source()));
        self::assertFalse(BackupEnvelope::isSealed($this->dir . '/missing'));
    }

    public function testOnlyAProperPublicKeyIsAccepted(): void
    {
        [$public] = BackupEnvelope::generateKeyPair();
        self::assertSame(32, strlen((string) BackupEnvelope::parseKey($public)));
        self::assertNull(BackupEnvelope::parseKey('short'));
        self::assertNull(BackupEnvelope::parseKey(null));
    }
}
