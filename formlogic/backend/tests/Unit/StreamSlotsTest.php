<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\StreamSlots;
use PHPUnit\Framework\TestCase;

final class StreamSlotsTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-stream-slots-' . bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->dir);
    }

    public function testAnAccountHasItsSlotsAndGetsThemBack(): void
    {
        $first = StreamSlots::take('a', 2, $this->dir);
        $second = StreamSlots::take('a', 2, $this->dir);
        $this->assertIsResource($first);
        $this->assertIsResource($second);
        $this->assertNull(StreamSlots::take('a', 2, $this->dir));
        $this->assertIsResource(StreamSlots::take('b', 2, $this->dir), 'another account has its own');
        fclose($first);
        $this->assertIsResource(StreamSlots::take('a', 2, $this->dir));
    }

    public function testStorageThatCannotHoldSlotsRefusesNobody(): void
    {
        file_put_contents($this->dir, 'a file where the folder goes');
        try {
            $this->assertFalse(StreamSlots::take('a', 2, $this->dir));
        } finally {
            unlink($this->dir);
        }
    }
}
