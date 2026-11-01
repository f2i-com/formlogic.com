<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\FormVersionService;

/**
 * Every save of a form used to add a row, each holding the whole form, however little changed. A
 * save that changes nothing adds none now, and a form keeps its newest two hundred.
 */
final class FormVersionHistoryTest extends E2eeTestCase
{
    private function versions(): FormVersionService
    {
        return new FormVersionService(self::$mysql, self::$forms);
    }

    private function aForm(): string
    {
        return (string) self::$forms->createForm([
            'title' => 'History',
            'userId' => $this->userId,
            'settings' => ['z' => 1, 'a' => ['y' => true, 'b' => 'text']],
            'theme' => ['primaryColor' => '#000000', 'logo' => 'data:image/png;base64,AAA/'],
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ])['id'];
    }

    private function rows(string $formId): int
    {
        return (int) $this->row('SELECT COUNT(*) AS n FROM form_versions WHERE form_id = ?', [$formId])['n'];
    }

    /** Versions $from to $to, as older saves left them. */
    private function seed(string $formId, int $from, int $to): void
    {
        $insert = self::$pdo->prepare('INSERT INTO form_versions (id, form_id, version, data, created_by) VALUES (UUID(), ?, ?, ?, ?)');
        for ($version = $from; $version <= $to; $version++) {
            $insert->execute([$formId, $version, json_encode(['title' => "Title {$version}", 'description' => null, 'fields' => [], 'settings' => [], 'theme' => []]), $this->userId]);
        }
    }

    public function testASaveThatChangedNothingAddsNoRowAndGivesTheNewestBack(): void
    {
        $formId = $this->aForm();
        $first = $this->versions()->createVersion($formId, $this->userId);

        $again = $this->versions()->createVersion($formId, $this->userId);

        $this->assertSame(1, $this->rows($formId), 'MySQL keeps JSON keys in an order of its own: this needs more than the text to match');
        $this->assertSame($first['id'], $again['id']);
        $this->assertSame($first['version'], $again['version']);
        $this->assertSame($this->userId, $again['createdBy']);
    }

    public function testAnEmptyChangelogIsNoChangelog(): void
    {
        $formId = $this->aForm();
        $this->versions()->createVersion($formId, $this->userId);

        $this->versions()->createVersion($formId, $this->userId, '');
        $this->versions()->createVersion($formId, $this->userId, '   ');

        $this->assertSame(1, $this->rows($formId));
    }

    public function testAChangeAddsARow(): void
    {
        $formId = $this->aForm();
        $this->versions()->createVersion($formId, $this->userId);

        self::$forms->updateForm($formId, ['title' => 'Renamed']);

        $this->assertSame(2, $this->versions()->createVersion($formId, $this->userId)['version']);
        $this->assertSame(2, $this->rows($formId));
    }

    public function testAValueOfAnotherTypeIsAChange(): void
    {
        $formId = $this->aForm();
        self::$forms->updateForm($formId, ['settings' => ['flag' => true]]);
        $this->versions()->createVersion($formId, $this->userId);

        self::$forms->updateForm($formId, ['settings' => ['flag' => 'yes']]);
        $this->versions()->createVersion($formId, $this->userId);

        $this->assertSame(2, $this->rows($formId), 'true and "yes" are equal only to a loose comparison');
    }

    public function testComparingIsAgainstTheNewestRowOnly(): void
    {
        $formId = $this->aForm();
        $this->versions()->createVersion($formId, $this->userId);
        self::$forms->updateForm($formId, ['title' => 'Renamed']);
        $this->versions()->createVersion($formId, $this->userId);
        self::$forms->updateForm($formId, ['title' => 'History']);

        $this->assertSame(3, $this->versions()->createVersion($formId, $this->userId)['version'], 'back to how it was two saves ago');
    }

    public function testAChangelogAlwaysAddsARow(): void
    {
        $formId = $this->aForm();
        $this->versions()->createVersion($formId, $this->userId, 'Before the upgrade');

        $marked = $this->versions()->createVersion($formId, $this->userId, 'Before the upgrade');

        $this->assertSame(2, $marked['version'], 'a snapshot someone named is the one they will look for');
        $this->assertSame(2, $this->rows($formId));
    }

    public function testAFormKeepsItsNewestTwoHundred(): void
    {
        $formId = $this->aForm();
        $this->seed($formId, 1, 205);

        $version = $this->versions()->createVersion($formId, $this->userId, 'After the seed');

        $this->assertSame(206, $version['version'], 'numbers keep rising, so one is never used twice');
        $this->assertSame(200, $this->rows($formId));
        $this->assertNull($this->versions()->getVersion($formId, 6));
        $this->assertNotNull($this->versions()->getVersion($formId, 7));
        $this->assertSame(7, $this->versions()->getVersions($formId, 1, 199)[0]['version']);
    }

    public function testTwoHundredIsNotYetTooMany(): void
    {
        $formId = $this->aForm();
        $this->seed($formId, 1, 199);

        $this->versions()->createVersion($formId, $this->userId, 'The two hundredth');

        $this->assertNotNull($this->versions()->getVersion($formId, 1));
        $this->assertSame(200, $this->rows($formId));
    }

    public function testAGapInTheNumbersDoesNotCostARow(): void
    {
        $formId = $this->aForm();
        $this->seed($formId, 1, 100);
        $this->seed($formId, 151, 250);

        $this->versions()->createVersion($formId, $this->userId, 'After the gap');

        $this->assertSame(200, $this->rows($formId), 'two hundred rows, however they are numbered');
        $this->assertNull($this->versions()->getVersion($formId, 1));
        $this->assertNotNull($this->versions()->getVersion($formId, 2));
    }

    public function testAnotherFormsRowsAreLeftAlone(): void
    {
        $formId = $this->aForm();
        $other = $this->aForm();
        $this->seed($formId, 1, 205);
        $this->seed($other, 1, 3);

        $this->versions()->createVersion($formId, $this->userId, 'After the seed');

        $this->assertSame(3, $this->rows($other));
    }

    public function testARestoreStillWorks(): void
    {
        $formId = $this->aForm();
        $version = $this->versions()->createVersion($formId, $this->userId);
        self::$forms->updateForm($formId, ['title' => 'Renamed']);

        $restored = $this->versions()->restoreVersion($formId, $version['version'], $this->userId);

        $this->assertSame('History', $restored['title']);
        $this->assertSame(2, $this->rows($formId), 'the snapshot taken before it, which has a changelog');
    }

    public function testRestoringTheOldestRowWorksThoughItsOwnSnapshotPushesItOut(): void
    {
        $formId = $this->aForm();
        $this->seed($formId, 1, 200);

        $restored = $this->versions()->restoreVersion($formId, 1, $this->userId);

        $this->assertSame('Title 1', $restored['title']);
        $this->assertSame(200, $this->rows($formId));
        $this->assertNull($this->versions()->restoreVersion($formId, 1, $this->userId), 'a version that has gone is a 404 at the route');
    }
}
