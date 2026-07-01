<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\RecordLabel;
use PHPUnit\Framework\TestCase;

/**
 * Smart record-label detection used to render linked_record fields when no explicit
 * displayFieldIds are configured. Order: full-name → first+last → any name-ish → first text.
 */
class RecordLabelTest extends TestCase
{
    private function field(string $id, string $type = 'short_text', ?string $label = null): array
    {
        return ['id' => $id, 'type' => $type, 'label' => $label ?? $id];
    }

    public function testPrefersSingleFullNameField(): void
    {
        $fields = [$this->field('email', 'email'), $this->field('full_name')];
        $answers = ['email' => 'ada@x.io', 'full_name' => 'Ada Lovelace'];
        $this->assertSame('Ada Lovelace', RecordLabel::guess($fields, $answers));
    }

    public function testPlainNameField(): void
    {
        $fields = [$this->field('name'), $this->field('company')];
        $answers = ['name' => 'Grace Hopper', 'company' => 'Navy'];
        $this->assertSame('Grace Hopper', RecordLabel::guess($fields, $answers));
    }

    public function testConcatenatesFirstAndLast(): void
    {
        $fields = [$this->field('first_name'), $this->field('last_name'), $this->field('email', 'email')];
        $answers = ['first_name' => 'Alan', 'last_name' => 'Turing', 'email' => 'alan@x.io'];
        $this->assertSame('Alan Turing', RecordLabel::guess($fields, $answers));
    }

    public function testFirstNameSurnamePattern(): void
    {
        // Different naming conventions on both id and label.
        $fields = [
            ['id' => 'given', 'type' => 'short_text', 'label' => 'Given name'],
            ['id' => 'surname', 'type' => 'short_text', 'label' => 'Surname'],
        ];
        $answers = ['given' => 'Katherine', 'surname' => 'Johnson'];
        $this->assertSame('Katherine Johnson', RecordLabel::guess($fields, $answers));
    }

    public function testLabelDrivenDetectionWhenIdIsOpaque(): void
    {
        // ids are opaque uuids; the human label carries the pattern.
        $fields = [
            ['id' => 'f_9a1', 'type' => 'short_text', 'label' => 'First Name'],
            ['id' => 'f_9a2', 'type' => 'short_text', 'label' => 'Last Name'],
        ];
        $answers = ['f_9a1' => 'Rosalind', 'f_9a2' => 'Franklin'];
        $this->assertSame('Rosalind Franklin', RecordLabel::guess($fields, $answers));
    }

    public function testOnlyOneOfFirstLastPresent(): void
    {
        $fields = [$this->field('first_name'), $this->field('last_name')];
        $answers = ['first_name' => 'Cher', 'last_name' => ''];
        $this->assertSame('Cher', RecordLabel::guess($fields, $answers));
    }

    public function testContainsNameFallback(): void
    {
        $fields = [$this->field('id_code'), $this->field('contact_name'), $this->field('notes', 'long_text')];
        $answers = ['id_code' => 'X-1', 'contact_name' => 'Acme Buyer', 'notes' => 'hello'];
        $this->assertSame('Acme Buyer', RecordLabel::guess($fields, $answers));
    }

    public function testIgnoresUsernameAsName(): void
    {
        // "username" contains "name" but must not win over a real first-text fallback… and here
        // there is no true name, so it falls through to the first text-ish field (username itself).
        $fields = [$this->field('username'), $this->field('bio', 'long_text')];
        $answers = ['username' => 'ada99', 'bio' => 'engineer'];
        // No name-ish match (username excluded); first text-ish field is username.
        $this->assertSame('ada99', RecordLabel::guess($fields, $answers));
    }

    public function testFallsBackToFirstTextField(): void
    {
        $fields = [$this->field('sku'), $this->field('qty', 'number')];
        $answers = ['sku' => 'ABC-123', 'qty' => 5];
        $this->assertSame('ABC-123', RecordLabel::guess($fields, $answers));
    }

    public function testSkipsEmptyNameAndUsesNext(): void
    {
        $fields = [$this->field('full_name'), $this->field('title')];
        $answers = ['full_name' => '  ', 'title' => 'Widget'];
        $this->assertSame('Widget', RecordLabel::guess($fields, $answers));
    }

    public function testReturnsNullWhenNothingUsable(): void
    {
        $fields = [$this->field('sig', 'signature'), $this->field('file', 'file_upload')];
        $answers = ['sig' => 'typed:x', 'file' => []];
        $this->assertNull(RecordLabel::guess($fields, $answers));
    }
}
