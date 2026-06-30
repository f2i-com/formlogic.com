<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\DbContextCapture;
use PHPUnit\Framework\TestCase;

/**
 * ctx.db read/write semantics for onSubmit scripts: getField reads the record (submitted
 * answers, with script-set values taking precedence); setField/addTag/setStatus capture
 * writes that ResponseService later persists.
 */
class DbContextCaptureTest extends TestCase
{
    public function testGetFieldReadsSubmittedAnswers(): void
    {
        $c = new DbContextCapture(['amount' => 7, 'name' => 'Lance']);
        $this->assertSame(7, $c->getField('amount'));
        $this->assertSame('Lance', $c->getField('name'));
        $this->assertNull($c->getField('missing'));
    }

    public function testSetFieldPersistsAndOverridesSubmitted(): void
    {
        $c = new DbContextCapture(['amount' => 7]);
        $this->assertTrue($c->setField('doubled', 14));
        $this->assertSame(14, $c->getField('doubled'));      // read back a script-set field
        $this->assertTrue($c->setField('amount', 99));       // script overrides a submitted field
        $this->assertSame(99, $c->getField('amount'));
        $this->assertSame(['doubled' => 14, 'amount' => 99], $c->getFields());
    }

    public function testSetFieldRejectsInvalidNames(): void
    {
        $c = new DbContextCapture();
        $this->assertFalse($c->setField('1bad', 1));          // can't start with a digit
        $this->assertFalse($c->setField('has space', 1));
        $this->assertFalse($c->setField(str_repeat('a', 65), 1)); // > 64 chars
        $this->assertSame([], $c->getFields());
    }

    public function testSetFieldEnforcesValueSizeCap(): void
    {
        $c = new DbContextCapture();
        $this->assertFalse($c->setField('big', str_repeat('x', 70000))); // > 64 KB per value
        $this->assertTrue($c->setField('ok', 'small'));
    }

    public function testAddTagDedupesValidatesAndCaps(): void
    {
        $c = new DbContextCapture();
        $this->assertTrue($c->addTag('processed'));
        $this->assertTrue($c->addTag('processed')); // dedup -> still one
        $this->assertFalse($c->addTag('has space'));
        $this->assertFalse($c->addTag(''));
        $this->assertSame(['processed'], $c->getTags());
    }

    public function testSetStatusAllowlist(): void
    {
        $c = new DbContextCapture();
        $this->assertTrue($c->setStatus('reviewed'));
        $this->assertSame('reviewed', $c->getStatus());
        $this->assertFalse($c->setStatus('not-a-status'));
        $this->assertSame('reviewed', $c->getStatus()); // unchanged on invalid
    }
}
