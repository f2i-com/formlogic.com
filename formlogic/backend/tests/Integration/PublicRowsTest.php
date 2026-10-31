<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use PDO;

/** What a public records page may draw from. */
final class PublicRowsTest extends E2eeTestCase
{
    private function setStatus(string $formId, string $responseId, string $status): void
    {
        $db = new PDO('sqlite:' . self::$sqlite->getFormDbPath($formId));
        $db->prepare('UPDATE responses SET status = ? WHERE id = ?')->execute([$status, $responseId]);
    }

    public function testADraftOrArchivedRowIsNeverPublic(): void
    {
        $form = (string) $this->makeDraftForm()['id'];
        $shown = self::$responses->createResponse($form, ['answers' => ['name' => 'shown']]);
        $draft = self::$responses->createResponse($form, ['answers' => ['name' => 'draft']]);
        $archived = self::$responses->createResponse($form, ['answers' => ['name' => 'archived']]);
        $this->setStatus($form, (string) $draft['id'], 'draft');
        $this->setStatus($form, (string) $archived['id'], 'archived');

        $ids = array_column(self::$responses->publicRows($form, 50), 'id');

        self::assertSame([(string) $shown['id']], $ids);
    }
}
