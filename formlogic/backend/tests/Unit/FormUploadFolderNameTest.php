<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FileStorageService;
use PHPUnit\Framework\TestCase;

/**
 * A form's uploads are kept in a folder named by its id's letters, digits and hyphens. Two ids
 * that come to one name share that folder, so FormService::createForm refuses a new id whose
 * folder another form has, and compares ids by this same rule (in SQL, IdentityFormatTest). It
 * used to compare them without their underscores only, which is the rule for the ids a form may
 * be given today and not for the ones older versions let the API choose.
 */
final class FormUploadFolderNameTest extends TestCase
{
    public function testAnOlderIdAndTheNewIdThatWouldTakeItsFolder(): void
    {
        $this->assertSame('survey2026-ab12', FileStorageService::folderName('survey.2026-ab12'));
        $this->assertSame('survey2026-ab12', FileStorageService::folderName('survey2026-ab12'));
        $this->assertSame('survey2026-ab12', FileStorageService::folderName('survey:2026 -ab12'));
        // Comparing without underscores alone told these two apart.
        $this->assertNotSame(str_replace('_', '', 'survey.2026-ab12'), str_replace('_', '', 'survey2026-ab12'));
    }

    public function testAnIdOfTodaysFormatLosesItsUnderscoresAndNothingElse(): void
    {
        foreach (['team_intake', '_a_b_', 'l9x4f2a', '0b1c2d3e-7a44-4d21-9f0e-1c2d3e4f5a6b', 'Mixed-Case_9'] as $id) {
            $this->assertSame(str_replace('_', '', $id), FileStorageService::folderName($id), $id);
        }
    }

    public function testTheGuardComparesByTheFolderNameRule(): void
    {
        // The SQL side of the comparison strips what folderName() strips.
        $source = (string) file_get_contents(dirname(__DIR__, 2) . '/src/Services/FormService.php');
        $this->assertStringContainsString("REGEXP_REPLACE(id, '[^a-zA-Z0-9-]', '') = :folder", $source);
        $this->assertStringContainsString("'folder' => FileStorageService::folderName(\$id)", $source);
    }
}
