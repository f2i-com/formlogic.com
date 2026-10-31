<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FormReportController;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\ReportService;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * What a report shows and costs, and the accounts round of the whole-repo review.
 */
final class ReportsAndAccountsTest extends E2eeTestCase
{
    private function publicForm(array $whitelist): string
    {
        $form = self::$forms->createForm([
            'title' => 'Public report',
            'userId' => $this->userId,
            'status' => 'published',
            'fields' => [
                ['id' => 'secret', 'type' => 'short_text', 'label' => 'Secret', 'required' => false],
                ['id' => 'shown', 'type' => 'short_text', 'label' => 'Shown', 'required' => false],
            ],
        ]);
        self::$forms->updateForm((string) $form['id'], ['customScreen' => ['html' => '<p>x</p>', 'publicRecords' => true, 'publicRecordFields' => $whitelist]]);
        self::$responses->createResponse((string) $form['id'], ['answers' => ['secret' => 'hidden-value', 'shown' => 'open-value']], null);
        return (string) $form['id'];
    }

    private function runPublic(string $formId, array $spec): array
    {
        $reports = (new \ReflectionClass(AppReportService::class))->newInstanceWithoutConstructor();
        $controller = new FormReportController(self::$forms, self::$sqlite, self::$apps, $reports);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/x')->withParsedBody(['spec' => $spec]);
        $response = $controller->runPublic($request, (new ResponseFactory())->createResponse(), ['id' => $formId]);
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true);
    }

    public function testAPublicTableNamingNoColumnsStaysInsideTheWhitelist(): void
    {
        $id = $this->publicForm(['shown']);
        foreach ([['viz' => 'table', 'limit' => 1000], ['viz' => 'bar']] as $spec) {
            $body = json_encode($this->runPublic($id, $spec));
            $this->assertStringContainsString('open-value', $body);
            $this->assertStringNotContainsString('hidden-value', $body);
            $this->assertStringNotContainsString('Secret', $body);
        }
    }

    public function testAPublicReportWithNothingWhitelistedShowsNoAnswers(): void
    {
        $result = $this->runPublic($this->publicForm([]), ['viz' => 'table', 'limit' => 1000]);
        $this->assertSame([], $result['rows']);
        $this->assertSame([], $result['columns']);
    }

    public function testAReportDoesNotUnnestALongArrayInAnAnswer(): void
    {
        $id = $this->publicForm(['shown']);
        self::$responses->createResponse($id, ['answers' => ['shown' => '[' . implode(',', array_fill(0, 101, '1')) . ']']], null);
        self::$responses->createResponse($id, ['answers' => ['shown' => '[' . implode(',', array_fill(0, 100, '1')) . ']']], null);

        $result = $this->runPublic($id, ['viz' => 'bar', 'groupBy' => ['field' => 'shown']]);

        $byLabel = array_column($result['series'], 'value', 'label');
        $this->assertCount(3, $byLabel, 'the short array by value, the long one and the plain answer as themselves');
        $this->assertEquals(100, $byLabel['1'], 'an answer of a hundred values still counts each');
    }

    public function testALabelInAReportFollowsTheRecordsOwnRules(): void
    {
        $target = self::$forms->createForm(['title' => 'Customers', 'userId' => $this->userId, 'status' => 'published', 'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]]]);
        $targetId = (string) $target['id'];
        $mine = self::$responses->createResponse($targetId, ['answers' => ['name' => 'My customer']], null);
        $theirs = self::$responses->createResponse($targetId, ['answers' => ['name' => 'Their customer']], null);
        $archived = self::$responses->createResponse($targetId, ['answers' => ['name' => 'Archived customer']], null);
        $db = self::$sqlite->getFormDatabase($targetId);
        $db->prepare("UPDATE responses SET metadata = json_set(COALESCE(metadata, '{}'), '$.submittedByUserId', ?) WHERE id = ?")->execute(['member', $mine['id']]);
        $db->prepare("UPDATE responses SET metadata = json_set(COALESCE(metadata, '{}'), '$.submittedByUserId', ?) WHERE id = ?")->execute(['someone', $theirs['id']]);
        $db->prepare("UPDATE responses SET status = 'archived' WHERE id = ?")->execute([$archived['id']]);

        $orders = self::$forms->createForm(['title' => 'Orders', 'userId' => $this->userId, 'status' => 'published', 'fields' => [
            ['id' => 'customer', 'type' => 'linked_record', 'label' => 'Customer', 'required' => false, 'properties' => ['targetFormId' => $targetId, 'displayFieldIds' => ['name']]],
        ]]);
        $ordersId = (string) $orders['id'];
        foreach ([$mine, $theirs, $archived] as $row) {
            self::$responses->createResponse($ordersId, ['answers' => ['customer' => $row['id']]], null);
        }
        $service = new ReportService(self::$sqlite, self::$forms, self::$mysql);
        $fields = self::$forms->getForm($ordersId)['fields'];
        $cells = fn (array $own): array => array_column($service->runReport(['viz' => 'table', 'limit' => 10], $fields, $ordersId, 'all', 'member', [], 'UTC', [$targetId], $own)['rows'], 'c0');

        $this->assertEqualsCanonicalizing(['My customer', 'Their customer', 'Linked record'], $cells([]), 'a member who sees everyone there: no archived name');
        $this->assertEqualsCanonicalizing(['My customer', 'Linked record', 'Linked record'], $cells([$targetId]), 'a member who sees only their own');
    }

    private function auth(): AuthService
    {
        return new AuthService(self::$mysql, ['secret' => str_repeat('k', 32), 'algorithm' => 'HS256', 'expiry' => 3600], ['maxAttempts' => 5, 'maxEmailAttempts' => 10, 'decayMinutes' => 15]);
    }

    public function testTheAddressesThatCarryAuthorityCannotBeTaken(): void
    {
        foreach (['official@formlogic.local', 'DEMO@formlogic.local', ' official@formlogic.local '] as $address) {
            $refused = '';
            try {
                $this->auth()->register($address, 'a-strong-password-123');
            } catch (\RuntimeException $e) {
                $refused = $e->getMessage();
            }
            $this->assertStringContainsString('reserved', $refused, $address);
        }
    }

    public function testOneAddressCannotKeepAnAccountLockedOut(): void
    {
        $email = 'lockout-' . bin2hex(random_bytes(6)) . '@test.local';
        $auth = $this->auth();
        $auth->register($email, 'a-strong-password-123');

        for ($i = 0; $i < 30; $i++) {
            try {
                $auth->login($email, 'wrong-guess', '198.51.100.7');
            } catch (\RuntimeException) {
            }
        }

        // That address is refused, but the account isn't, from anywhere else.
        $this->assertNotEmpty($auth->login($email, 'a-strong-password-123', '203.0.113.9'));
    }

    public function testAResetLinkEndsTheLockoutOnTheAccount(): void
    {
        $email = 'reset-' . bin2hex(random_bytes(6)) . '@test.local';
        $auth = $this->auth();
        $auth->register($email, 'a-strong-password-123');
        for ($i = 0; $i < 12; $i++) {
            try {
                $auth->login($email, 'wrong-guess', '198.51.100.' . $i);
            } catch (\RuntimeException) {
            }
        }
        $locked = '';
        try {
            $auth->login($email, 'a-strong-password-123', '203.0.113.10');
        } catch (\RuntimeException $e) {
            $locked = $e->getMessage();
        }
        $this->assertStringContainsString('for this account', $locked);

        $token = bin2hex(random_bytes(32));
        $userId = self::$pdo->query('SELECT id FROM users WHERE email = ' . self::$pdo->quote($email))->fetchColumn();
        self::$pdo->prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
            ->execute([bin2hex(random_bytes(16)), $userId, hash('sha256', $token), date('Y-m-d H:i:s', time() + 3600)]);
        $auth->resetPassword($token, 'another-strong-password-456');

        $this->assertNotEmpty($auth->login($email, 'another-strong-password-456', '203.0.113.10'));
    }

    public function testALongResourceIdStillLeavesAnAuditRow(): void
    {
        $id = 'https://client.example/metadata/' . bin2hex(random_bytes(16));
        (new AuditService(self::$mysql))->log('mcp.oauth.approve', 'mcp', $id, $this->userId, null, ['scope' => 'x']);

        $stmt = self::$pdo->prepare("SELECT resource_id, details FROM audit_log WHERE user_id = ? AND action = 'mcp.oauth.approve'");
        $stmt->execute([$this->userId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        $this->assertNotFalse($row, 'the row was written');
        $this->assertSame(36, strlen((string) $row['resource_id']));
        $this->assertSame($id, json_decode((string) $row['details'], true)['resourceId'], 'the whole id is still there');
    }
}
