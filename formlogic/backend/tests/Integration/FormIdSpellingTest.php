<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AccountBackupService;
use FormLogic\Services\TrashService;

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
            'a space' => ['abc def'], 'a slash' => ['abc/def'], 'too long' => [str_repeat('a', 65)],
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

    public function testAFormFromBeforeIdsHadAFormatStillOpens(): void
    {
        $id = 'survey.2026';
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status, settings, theme) VALUES (?, ?, 'Old', 'published', '{}', '{}')")->execute([$id, $this->userId]);

        $this->assertInstanceOf(\PDO::class, self::$sqlite->getFormDatabase($id));
        $this->assertTrue(self::$sqlite->formDatabaseExists($id));
    }

    /** @return array<string, array{0: string}> */
    public static function olderIds(): array
    {
        return ['a dot' => ['survey.2026-'], 'a space' => ['old form '], 'a plus' => ['old+form-'], 'an accent' => ["caf\u{00E9}-"]];
    }

    /** A form as older versions left it: its row, and the fields its owner saved. */
    private function anOlderForm(string $prefix): string
    {
        $id = $prefix . bin2hex(random_bytes(4));
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status, settings, theme) VALUES (?, ?, 'Old', 'published', '{}', '{}')")->execute([$id, $this->userId]);
        self::$forms->updateForm($id, ['fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => true]]]);
        // A new connection, as the next request would have.
        self::$sqlite->closeAll();
        return $id;
    }

    private function backup(): AccountBackupService
    {
        return new AccountBackupService(self::$mysql, self::$sqlite, self::$forms, self::$apps, self::$appUsers, self::$flows, self::$responses, [], self::$tmpRoot . '/sqlite', self::$uploadsPath);
    }

    private function trash(): TrashService
    {
        $dir = self::$tmpRoot . '/trash';
        if (!is_dir($dir)) {
            mkdir($dir, 0777, true);
        }
        return new TrashService(self::$mysql, self::$sqlite, $this->backup(), self::$forms, self::$apps, self::$flows, ['retentionDays' => 30, 'dir' => $dir]);
    }

    /** @dataProvider olderIds */
    public function testAnOlderIdOpensAndTakesAnswers(string $prefix): void
    {
        $id = $this->anOlderForm($prefix);

        $this->assertSame('name', self::$forms->getForm($id)['fields'][0]['id'] ?? null);
        $this->assertNotEmpty(self::$responses->createResponse($id, ['answers' => ['name' => 'Ada']], null)['id']);
    }

    /** @dataProvider olderIds */
    public function testTheOwnerStillSavesAnOlderIdThroughCreate(string $prefix): void
    {
        $id = $this->anOlderForm($prefix);

        $saved = self::$forms->createForm(['id' => $id, 'userId' => $this->userId, 'title' => 'Renamed']);
        $this->assertSame($id, $saved['id']);
        $this->assertSame('Renamed', self::$forms->getForm($id)['title']);

        $this->expectExceptionMessage('A form with this ID already exists');
        self::$forms->createForm(['id' => $id, 'userId' => $this->makeUser(), 'title' => 'Theirs']);
    }

    /** @dataProvider olderIds */
    public function testAnOlderIdIsNotNewlyAvailable(string $prefix): void
    {
        $this->expectExceptionMessage('Invalid form id');
        self::$forms->createForm(['id' => $prefix . bin2hex(random_bytes(4)), 'userId' => $this->userId, 'title' => 'New']);
    }

    /** @dataProvider olderIds */
    public function testAnOlderIdComesBackFromTheBin(string $prefix): void
    {
        $id = $this->anOlderForm($prefix);
        self::$responses->createResponse($id, ['answers' => ['name' => 'Ada']], null);
        $trash = $this->trash();
        $this->assertTrue($trash->trashForm($id, $this->userId)['trashed'] ?? false);
        $this->assertNull(self::$forms->getForm($id));
        $this->assertFalse(self::$sqlite->formDatabaseExists($id));

        $item = $this->row('SELECT id FROM trash_items WHERE original_id = ? AND user_id = ?', [$id, $this->userId]);
        $restored = $trash->restore((string) $item['id'], $this->userId);

        $this->assertSame($id, $restored['restored']['forms'][0]['id'] ?? null);
        $this->assertSame($id, self::$forms->getForm($id)['id']);
        $this->assertSame(1, self::$responses->getResponseCount($id));
        self::$sqlite->closeAll();
    }

    /** What the bin may bring back, an upload may not: an archive says what it likes. */
    public function testAnUploadedArchiveIsStillHeldToTheFormat(): void
    {
        $id = $this->anOlderForm('old form ');
        $this->assertTrue($this->trash()->trashForm($id, $this->userId)['trashed'] ?? false);
        $snapshot = self::$tmpRoot . '/trash/' . $this->row('SELECT zip_path FROM trash_items WHERE original_id = ?', [$id])['zip_path'];

        try {
            $this->backup()->importAccount($snapshot, $this->userId, ['preserveIds' => true]);
            $this->fail('an archive chose an id');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('Invalid form id', $e->getMessage());
        }
        $this->assertNull(self::$forms->getForm($id));
    }

    public function testASpellingOfAnOlderIdIsNotTheForm(): void
    {
        $id = $this->anOlderForm('old form ');
        $before = $this->databases();
        try {
            self::$sqlite->getFormDatabase($id . ' ');
            $this->fail('a trailing space found its way to a file');
        } catch (\InvalidArgumentException $e) {
            $this->assertSame('Invalid form id', $e->getMessage());
        }
        $this->assertSame($before, $this->databases());
    }
}
