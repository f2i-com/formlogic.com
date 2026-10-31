<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\StorageAccess;
use PHPUnit\Framework\TestCase;

final class StorageAccessTest extends TestCase
{
    private string $dir = '';

    protected function setUp(): void
    {
        if (DIRECTORY_SEPARATOR !== '/') {
            $this->markTestSkipped('Windows has no such bits');
        }
        $this->dir = sys_get_temp_dir() . '/fl-storage-access-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        if ($this->dir !== '') {
            @rmdir($this->dir);
        }
    }

    private function mode(): int
    {
        clearstatcache();
        return fileperms($this->dir) & 07777;
    }

    public function testTakesAwayOnlyWhatOthersMayDo(): void
    {
        chmod($this->dir, 0775);
        StorageAccess::closeToOthers($this->dir);
        self::assertSame(0770, $this->mode());
    }

    public function testKeepsAGroupsSetgidBit(): void
    {
        chmod($this->dir, 02755);
        StorageAccess::closeToOthers($this->dir);
        self::assertSame(02750, $this->mode());
    }

    public function testLeavesAClosedFolderAlone(): void
    {
        chmod($this->dir, 0700);
        StorageAccess::closeToOthers($this->dir);
        self::assertSame(0700, $this->mode());
    }

    public function testAMissingFolderIsNoFailure(): void
    {
        StorageAccess::closeToOthers($this->dir . '/nowhere');
        self::assertTrue(true);
    }
}
