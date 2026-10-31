<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

/**
 * MySQL's collation finds a form under spellings of its id that aren't its id: a trailing space, an
 * accent, another case. To the file store each is another database, with no fields in it, so an
 * answer sent to one passed every check and went nowhere the owner would look.
 */
final class FormIdSpellingTest extends E2eeTestCase
{
    private function aForm(?string $id = null): array
    {
        return self::$forms->createForm(array_filter([
            'id' => $id,
            'title' => 'Spellings',
            'userId' => $this->userId,
            'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => true]],
        ], static fn ($value) => $value !== null));
    }

    private function databases(): int
    {
        return count(glob(dirname(self::$sqlite->getFormDbPath('x')) . '/*.sqlite') ?: []);
    }

    /** @return array<string, array{0: callable(string): string}> */
    public static function spellings(): array
    {
        return [
            'a trailing space' => [static fn (string $id): string => $id . ' '],
            'an accent' => [static fn (string $id): string => "\u{00E1}" . substr($id, 1)],
            'another case' => [static fn (string $id): string => strtoupper($id)],
        ];
    }

    /** @dataProvider spellings */
    public function testAnotherSpellingIsNotTheForm(callable $spell): void
    {
        $form = $this->aForm('team_intake_' . substr(bin2hex(random_bytes(6)), 0, 8));
        $spelled = $spell((string) $form['id']);
        $this->assertNotSame($form['id'], $spelled);

        $this->assertNull(self::$forms->getForm($spelled));
        $before = $this->databases();
        try {
            self::$responses->createResponse($spelled, ['answers' => []], null);
            $this->fail('an answer was taken for a form that is not there');
        } catch (\Throwable $e) {
            $this->assertStringContainsStringIgnoringCase('not found', $e->getMessage());
        }
        $this->assertSame($before, $this->databases(), 'no second database');
    }

    public function testAFormKeepsWorkingUnderItsOwnId(): void
    {
        foreach ([null, 'team_intake-' . substr(bin2hex(random_bytes(6)), 0, 8)] as $id) {
            $form = $this->aForm($id);
            $this->assertSame($form['id'], self::$forms->getForm((string) $form['id'])['id']);
            $created = self::$responses->createResponse((string) $form['id'], ['answers' => ['name' => 'Ada']], null);
            $this->assertNotEmpty($created['id']);
        }
    }

    /** @return array<string, array{0: string}> */
    public static function notFormIds(): array
    {
        return [
            'a space' => ['abc def'], 'a dot' => ['abc.def'], 'a slash' => ['abc/def'], 'too long' => [str_repeat('a', 37)],
            'a line break' => ["abc\n"], 'empty' => [''], 'an accent' => ["\u{00E1}bc"],
        ];
    }

    /** @dataProvider notFormIds */
    public function testNothingElseBecomesAFile(string $id): void
    {
        $this->assertFalse(self::$sqlite->formDatabaseExists($id));
        $before = $this->databases();
        try {
            self::$sqlite->getFormDatabase($id);
            $this->fail('a database was opened');
        } catch (\InvalidArgumentException $e) {
            $this->assertSame('Invalid form id', $e->getMessage());
        }
        $this->assertSame($before, $this->databases());
    }
}
