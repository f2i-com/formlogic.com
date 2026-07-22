<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\PrivateFormEncryptedException;

/**
 * Irreversibility (plan D8 + P3 gate: "no code path — API, import, clone, stale
 * client, admin — can flip a private form back to plaintext or store a plaintext
 * answer on it").
 */
class E2eeIrreversibilityTest extends E2eeTestCase
{
    public function testNoDisablePathExistsInCode(): void
    {
        // No service method may turn encryption off.
        $methods = array_map(
            static fn (\ReflectionMethod $m) => strtolower($m->getName()),
            (new \ReflectionClass(FormEncryptionService::class))->getMethods(\ReflectionMethod::IS_PUBLIC)
        );
        foreach ($methods as $m) {
            $this->assertDoesNotMatchRegularExpression('/disable|deactivate|revert|decrypt|unwrap/', $m);
        }

        // No DELETE/disable route for the encryption resource in the router.
        $router = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        $this->assertIsString($router);
        $this->assertDoesNotMatchRegularExpression('/->delete\([^\n]*encryption/i', $router);
        $this->assertDoesNotMatchRegularExpression('/encryption\/disable/i', $router);
    }

    public function testModeEnumHasNoWayBack(): void
    {
        // The DB itself refuses any mode other than 'private' — strict sql_mode
        // throws; a lenient session coerces to the empty enum slot (never 'plain').
        $form = $this->makeDraftForm();
        try {
            self::$pdo->prepare("INSERT INTO form_encryption (form_id, mode, state, enabled_by, enabled_at) VALUES (?, 'plain', 'active', ?, NOW())")
                ->execute([$form['id'], $this->userId]);
        } catch (\PDOException) {
            $this->addToAssertionCount(1); // strict mode: refused at the DB layer
        }
        $row = $this->row('SELECT mode FROM form_encryption WHERE form_id = ?', [$form['id']]);
        if ($row !== null) {
            $this->assertNotSame('plain', $row['mode']);
        }
    }

    public function testCloneYieldsAPlainFormOriginalStaysPrivate(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);

        $clone = self::$forms->duplicateForm($formId);
        $this->assertNotNull($clone);
        $cloneId = (string) $clone['id'];

        // The clone is a schema-only PLAIN form (plan D8): fresh draft, no
        // encryption rows, eligible to make its own choice later.
        $this->assertFalse(self::$encryption->isPrivate($cloneId));
        $this->assertNull($this->row('SELECT 1 AS x FROM form_encryption WHERE form_id = ?', [$cloneId]));
        $this->assertSame('draft', $clone['status']);
        $this->assertNull($this->row('SELECT ever_published_at FROM forms WHERE id = ?', [$cloneId])['ever_published_at']);

        // The original is untouched.
        $this->assertTrue(self::$encryption->isPrivate($formId));
    }

    public function testStatusTogglesCannotStripPrivacy(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);

        foreach (['published', 'draft', 'archived'] as $status) {
            self::$forms->updateForm($formId, ['status' => $status]);
            $this->assertTrue(self::$encryption->isPrivate($formId), "status {$status} must not strip privacy");
            $this->assertSame('private', $this->row('SELECT mode FROM form_encryption WHERE form_id = ?', [$formId])['mode']);
        }
    }

    public function testStaleClientPlaintextWriteIsRefused(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);

        // A stale (pre-private) client posting plaintext answers hits the service
        // funnel gate — every write path funnels through createResponse.
        try {
            self::$responses->createResponse($formId, ['answers' => ['name' => 'stale client']], null);
            $this->fail('plaintext write to a private form must throw');
        } catch (PrivateFormEncryptedException $e) {
            $this->assertStringContainsString('private_form_encrypted', $e->getMessage());
        }
        $this->assertSame(0, (int) self::$sqlite->getFormDatabase($formId)->query('SELECT COUNT(*) FROM responses')->fetchColumn());
    }

    public function testTrashedPrivateFormStaysGated(): void
    {
        // Even 'trashed' state keeps every gate closed — state drives the bin
        // lifecycle, never a plaintext re-opening.
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$encryption->markFormTrashed($formId);
        \FormLogic\Services\FormEncryptionService::invalidateCache();

        $this->assertTrue(self::$encryption->isPrivate($formId));
        try {
            self::$responses->createResponse($formId, ['answers' => ['name' => 'x']], null);
            $this->fail('trashed private form must stay gated');
        } catch (PrivateFormEncryptedException) {
            // expected
        }
    }
}
