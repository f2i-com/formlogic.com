<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppDataExportService;
use FormLogic\Services\AppService;
use FormLogic\Services\ChatToolDeniedException;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use FormLogic\Services\PlanService;
use FormLogic\Services\PrivateFormEncryptedException;
use FormLogic\Services\ResponseService;
use FormLogic\Services\VaultService;
use FormLogic\Services\WebhookService;
use FormLogic\Tests\Support\E2eePrivateFormsSupport;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * E2EE private response pipeline (docs/E2EE_PRIVATE_FORMS_PLAN.md §6/§8/§9.2):
 * envelopes stored VERBATIM with minimized metadata, plaintext bodies rejected
 * BEFORE any sanitation, duplicate recordIds conflicting, idempotent replays,
 * the atomic rev CAS on update, and the matrix-driven §9.2 gate sweep across
 * every content-dependent surface. Skipped without a test database.
 */
class PrivateResponsePipelineTest extends TestCase
{
    use E2eePrivateFormsSupport;

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static VaultService $vaults;
    private static FormEncryptionService $enc;
    private static WebhookService $webhooks;
    private static FlowService $flows;
    private static AppService $apps;
    private static ResponseController $controller;
    private static string $tmpRoot = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmpRoot = sys_get_temp_dir() . '/fl-e2ee-pipe-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);

        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$vaults = new VaultService($conn);
        self::$enc = new FormEncryptionService($conn, self::$sqlite, self::$tmpRoot . '/uploads');
        self::$webhooks = new WebhookService($conn);
        self::$flows = new FlowService($conn);
        self::$apps = new AppService($conn, self::$forms);
        self::$controller = new ResponseController(
            self::$responses,
            self::$forms,
            self::$sqlite,
            null,
            null,
            null,
            null,
            $conn
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        FormEncryptionService::invalidateCache();
        self::$pdo->exec("INSERT IGNORE INTO plan_allowances (plan, metric, monthly_value, enabled) VALUES
            ('personal', 'cloud_flow_runs', 100, 1), ('personal', 'ai_messages', 500, 1)");
    }

    // ── helpers ──

    /**
     * A published PRIVATE form with a vault-backed owner.
     *
     * @return array{formId: string, userId: string, keys: array, keyId: string, schemaHash: string}
     */
    private function makePrivateForm(): array
    {
        $userId = $this->insertUser(self::$pdo);
        $keys = $this->makeKeys();
        self::$vaults->createVault($userId, $this->vaultBody($keys));
        $form = self::$forms->createForm([
            'title' => 'Private ' . bin2hex(random_bytes(3)),
            'userId' => $userId,
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        $formId = (string) $form['id'];
        $schemaJson = json_encode([['id' => 'name', 'type' => 'short_text']], JSON_UNESCAPED_SLASHES) ?: '[]';
        self::$enc->enable($formId, $userId, $this->enableBody($formId, $userId, $keys, $schemaJson));
        self::$forms->updateForm($formId, ['status' => 'published']);
        $manifest = self::$enc->publicManifest($formId);
        return [
            'formId' => $formId,
            'userId' => $userId,
            'keys' => $keys,
            'keyId' => (string) $manifest['keyId'],
            'schemaHash' => (string) $manifest['schemaHash'],
        ];
    }

    private function makePlainForm(?string $userId = null): array
    {
        $userId ??= $this->insertUser(self::$pdo);
        $form = self::$forms->createForm([
            'title' => 'Plain ' . bin2hex(random_bytes(3)),
            'userId' => $userId,
            'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        return ['formId' => (string) $form['id'], 'userId' => $userId];
    }

    private function rawRequest(string $method, string $uri, string $rawBody, ?string $userId = null): ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, $uri, ['REMOTE_ADDR' => '203.0.113.9']);
        $req->getBody()->write($rawBody);
        $req->getBody()->rewind();
        $req = $req->withHeader('Content-Type', 'application/json')
            ->withHeader('User-Agent', 'phpunit-e2ee');
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId)->withAttribute('user', (object) ['email' => $userId . '@test.local']);
        }
        return $req;
    }

    private function post(string $formId, array $body, ?string $userId = null): ResponseInterface
    {
        $request = $this->rawRequest('POST', "/api/forms/{$formId}/responses", (string) json_encode($body), $userId);
        return self::$controller->create($request, new SlimResponse(), ['formId' => $formId]);
    }

    private function put(string $formId, string $responseId, array $body, string $userId): ResponseInterface
    {
        $request = $this->rawRequest('PUT', "/api/forms/{$formId}/responses/{$responseId}", (string) json_encode($body), $userId);
        return self::$controller->update($request, new SlimResponse(), ['formId' => $formId, 'id' => $responseId]);
    }

    private function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    private function sqliteRow(string $formId, string $responseId): ?array
    {
        $db = self::$sqlite->getFormDatabase($formId);
        $stmt = $db->prepare('SELECT * FROM responses WHERE id = ?');
        $stmt->execute([$responseId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    private function sqliteCount(string $formId): int
    {
        return (int) self::$sqlite->getFormDatabase($formId)->query('SELECT COUNT(*) FROM responses')->fetchColumn();
    }

    // ── create ──

    public function testValidEnvelopeIsStoredVerbatimWithMinimizedMetadata(): void
    {
        $f = $this->makePrivateForm();
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);

        $resp = $this->post($f['formId'], ['envelope' => $envelope, 'idempotencyKey' => 'idem-' . bin2hex(random_bytes(6))]);
        $this->assertSame(201, $resp->getStatusCode(), (string) json_encode($this->decode($resp)));
        $created = $this->decode($resp)['response'];
        $this->assertSame($envelope['recordId'], $created['id'], 'row id = client recordId');

        // Stored answers ARE the envelope, byte for byte.
        $row = $this->sqliteRow($f['formId'], $envelope['recordId']);
        $this->assertNotNull($row);
        $this->assertSame(json_encode($envelope, JSON_UNESCAPED_SLASHES), $row['answers']);
        // Anonymous submission: EMPTY metadata object — no UA/referrer/language/IP.
        $this->assertSame('{}', $row['metadata']);
        $this->assertSame('submitted', $row['status']);

        // MySQL mirror: ip kept for abuse (swept after 30 days), UA/completion NULL.
        $stmt = self::$pdo->prepare('SELECT * FROM response_metadata WHERE id = ?');
        $stmt->execute([$envelope['recordId']]);
        $mirror = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame('203.0.113.9', $mirror['ip_address']);
        $this->assertNull($mirror['user_agent']);
        $this->assertNull($mirror['completion_time']);

        // No plaintext side effects: no computed rows, no tags, no script logs.
        $db = self::$sqlite->getFormDatabase($f['formId']);
        $this->assertSame(0, (int) $db->query('SELECT COUNT(*) FROM computed')->fetchColumn());
        $this->assertSame(0, (int) $db->query('SELECT COUNT(*) FROM tags')->fetchColumn());
    }

    public function testAuthenticatedSubmitterRecordsOnlyTheirUserId(): void
    {
        $f = $this->makePrivateForm();
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);
        $resp = $this->post($f['formId'], ['envelope' => $envelope], $f['userId']);
        $this->assertSame(201, $resp->getStatusCode());
        $row = $this->sqliteRow($f['formId'], $envelope['recordId']);
        $this->assertSame(['submittedByUserId' => $f['userId']], json_decode((string) $row['metadata'], true));
    }

    public function testPlaintextAnswersBodyRejectedBeforeSanitation(): void
    {
        $f = $this->makePrivateForm();
        $resp = $this->post($f['formId'], ['answers' => ['name' => 'CANARY-PLAINTEXT']]);
        $this->assertSame(400, $resp->getStatusCode());
        $this->assertSame('envelope_invalid', $this->decode($resp)['code'] ?? null);
        // Rejected before ANY pipeline stage — nothing stored anywhere.
        $this->assertSame(0, $this->sqliteCount($f['formId']));
    }

    public function testUnexpectedRootKeysAndMissingEnvelopeAreRejected(): void
    {
        $f = $this->makePrivateForm();
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);

        $extra = $this->post($f['formId'], ['envelope' => $envelope, 'answers' => ['name' => 'x']]);
        $this->assertSame(400, $extra->getStatusCode());
        $this->assertSame('envelope_invalid', $this->decode($extra)['code'] ?? null);

        $missing = $this->post($f['formId'], ['idempotencyKey' => 'k1']);
        $this->assertSame(400, $missing->getStatusCode());
        $this->assertSame('envelope_invalid', $this->decode($missing)['code'] ?? null);

        // Duplicate JSON keys in the RAW body are caught by the jsonlint parse.
        $raw = '{"envelope": ' . json_encode($envelope) . ', "envelope": ' . json_encode($envelope) . '}';
        $request = $this->rawRequest('POST', "/api/forms/{$f['formId']}/responses", $raw);
        $dup = self::$controller->create($request, new SlimResponse(), ['formId' => $f['formId']]);
        $this->assertSame(400, $dup->getStatusCode());
        $this->assertSame('envelope_invalid', $this->decode($dup)['code'] ?? null);

        $this->assertSame(0, $this->sqliteCount($f['formId']));
    }

    public function testDuplicateRecordIdConflicts(): void
    {
        $f = $this->makePrivateForm();
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);
        $this->assertSame(201, $this->post($f['formId'], ['envelope' => $envelope])->getStatusCode());

        // A DIFFERENT envelope reusing the same recordId (no idempotency key).
        $again = $this->makeEnvelope($f['keyId'], $f['schemaHash'], $envelope['recordId']);
        $resp = $this->post($f['formId'], ['envelope' => $again]);
        $this->assertSame(409, $resp->getStatusCode());
        $this->assertSame('duplicate_record_id', $this->decode($resp)['code'] ?? null);
        $this->assertSame(1, $this->sqliteCount($f['formId']));
    }

    public function testManifestTupleMismatchIsKeyEpochRetired(): void
    {
        $f = $this->makePrivateForm();
        $wrongEpoch = $this->makeEnvelope($f['keyId'], $f['schemaHash'], null, 1, 2);
        $resp = $this->post($f['formId'], ['envelope' => $wrongEpoch]);
        $this->assertSame(409, $resp->getStatusCode());
        $this->assertSame('key_epoch_retired', $this->decode($resp)['code'] ?? null);

        $wrongHash = $this->makeEnvelope($f['keyId'], hash('sha256', 'other schema'));
        $resp = $this->post($f['formId'], ['envelope' => $wrongHash]);
        $this->assertSame(409, $resp->getStatusCode());
        $this->assertSame('key_epoch_retired', $this->decode($resp)['code'] ?? null);
    }

    public function testAttachmentsAreBlockedUntilP4(): void
    {
        $f = $this->makePrivateForm();
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);
        $envelope['attachments'] = ['fil_abc'];
        $resp = $this->post($f['formId'], ['envelope' => $envelope]);
        $this->assertSame(400, $resp->getStatusCode());
        $this->assertSame('envelope_invalid', $this->decode($resp)['code'] ?? null);
    }

    public function testIdempotentReplayReturnsTheOriginal(): void
    {
        $f = $this->makePrivateForm();
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);
        $key = 'idem-' . bin2hex(random_bytes(6));

        $first = $this->post($f['formId'], ['envelope' => $envelope, 'idempotencyKey' => $key]);
        $this->assertSame(201, $first->getStatusCode());

        $replay = $this->post($f['formId'], ['envelope' => $envelope, 'idempotencyKey' => $key]);
        $this->assertSame(200, $replay->getStatusCode());
        $decoded = $this->decode($replay);
        $this->assertTrue($decoded['idempotent'] ?? false);
        $this->assertSame($envelope['recordId'], $decoded['response']['id']);
        $this->assertSame(1, $this->sqliteCount($f['formId']));

        // Same key + a DIFFERENT envelope = payload-hash conflict.
        $other = $this->makeEnvelope($f['keyId'], $f['schemaHash']);
        $conflict = $this->post($f['formId'], ['envelope' => $other, 'idempotencyKey' => $key]);
        $this->assertSame(409, $conflict->getStatusCode());
    }

    public function testUnpublishedPrivateFormRefusesEnvelopes(): void
    {
        // Enable happens pre-publish (plan D8) — a draft private form must not accept writes.
        $userId = $this->insertUser(self::$pdo);
        $keys = $this->makeKeys();
        self::$vaults->createVault($userId, $this->vaultBody($keys));
        $form = self::$forms->createForm([
            'title' => 'Draft private', 'userId' => $userId,
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        $formId = (string) $form['id'];
        $schemaJson = '[{"id":"name"}]';
        self::$enc->enable($formId, $userId, $this->enableBody($formId, $userId, $keys, $schemaJson));
        $manifest = self::$enc->publicManifest($formId);

        $resp = $this->post($formId, ['envelope' => $this->makeEnvelope((string) $manifest['keyId'], (string) $manifest['schemaHash'])]);
        $this->assertSame(403, $resp->getStatusCode());
    }

    // ── update (rev CAS) ──

    public function testUpdateCasSwapsAndStaleRevConflicts(): void
    {
        $f = $this->makePrivateForm();
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);
        $recordId = $envelope['recordId'];
        $this->assertSame(201, $this->post($f['formId'], ['envelope' => $envelope])->getStatusCode());

        // rev 1 → 2.
        $v2 = $this->makeEnvelope($f['keyId'], $f['schemaHash'], $recordId, 2);
        $ok = $this->put($f['formId'], $recordId, ['envelope' => $v2, 'expectedRev' => 1], $f['userId']);
        $this->assertSame(200, $ok->getStatusCode(), (string) json_encode($this->decode($ok)));
        $this->assertSame(2, $this->decode($ok)['response']['rev']);
        $row = $this->sqliteRow($f['formId'], $recordId);
        $this->assertSame(json_encode($v2, JSON_UNESCAPED_SLASHES), $row['answers'], 'complete envelope replaced');

        // Concurrent-edit simulation: a second client still holding rev 1 loses.
        $stale = $this->makeEnvelope($f['keyId'], $f['schemaHash'], $recordId, 2);
        $conflict = $this->put($f['formId'], $recordId, ['envelope' => $stale, 'expectedRev' => 1], $f['userId']);
        $this->assertSame(409, $conflict->getStatusCode());
        $decoded = $this->decode($conflict);
        $this->assertSame('revision_conflict', $decoded['code'] ?? null);
        $this->assertSame(2, $decoded['details']['currentRev'] ?? null);
        // The stored envelope is untouched by the losing write.
        $this->assertSame(json_encode($v2, JSON_UNESCAPED_SLASHES), $this->sqliteRow($f['formId'], $recordId)['answers']);

        // The envelope must carry rev == expectedRev + 1 (replay of an old rev refused).
        $wrongRev = $this->makeEnvelope($f['keyId'], $f['schemaHash'], $recordId, 2);
        $bad = $this->put($f['formId'], $recordId, ['envelope' => $wrongRev, 'expectedRev' => 2], $f['userId']);
        $this->assertSame(409, $bad->getStatusCode());
        $this->assertSame('revision_conflict', $this->decode($bad)['code'] ?? null);

        // recordId must match the row being updated.
        $foreign = $this->makeEnvelope($f['keyId'], $f['schemaHash'], null, 3);
        $mismatch = $this->put($f['formId'], $recordId, ['envelope' => $foreign, 'expectedRev' => 2], $f['userId']);
        $this->assertSame(400, $mismatch->getStatusCode());
        $this->assertSame('envelope_invalid', $this->decode($mismatch)['code'] ?? null);

        // Plaintext PATCH bodies are rejected in the private branch (dispatch order).
        $patch = $this->put($f['formId'], $recordId, ['answers' => ['name' => 'plain']], $f['userId']);
        $this->assertSame(400, $patch->getStatusCode());
        $this->assertSame('envelope_invalid', $this->decode($patch)['code'] ?? null);
    }

    // ── §9.2 matrix ──

    public function testGateMatrixEverySurfaceRefusesPrivateAndServesPlain(): void
    {
        $f = $this->makePrivateForm();
        $priv = $f['formId'];
        $envelope = $this->makeEnvelope($f['keyId'], $f['schemaHash']);
        $this->assertSame(201, $this->post($priv, ['envelope' => $envelope])->getStatusCode());

        $p = $this->makePlainForm($f['userId']);
        $plain = $p['formId'];
        self::$responses->createResponse($plain, ['answers' => ['name' => 'Ada']]);

        $wsFlow = self::$flows->createWorkspaceFlow($f['userId'], ['name' => 'Matrix flow']);

        /** @var array<string, callable(string): mixed> $surfaces each callable runs a content-dependent surface against a form id */
        $surfaces = [
            'answersEq filter' => fn (string $id) => self::$responses->getFormResponses($id, ['answersEq' => ['name' => 'Ada']]),
            'answersGte filter' => fn (string $id) => self::$responses->getFormResponses($id, ['answersGte' => ['name' => '2026-01-01']]),
            'answersPhoneEq filter' => fn (string $id) => self::$responses->getFormResponses($id, ['answersPhoneEq' => ['name' => '0491570156']]),
            'sort by answer field' => fn (string $id) => self::$responses->getFormResponses($id, ['sort' => 'name', 'sortDir' => 'asc']),
            'answers LIKE search' => fn (string $id) => self::$responses->findMatchingResponseIds($id, 'Ada'),
            'searchable list' => fn (string $id) => self::$responses->getFormResponsesSearchable($id, 'Ada', ['name']),
            'CSV export' => function (string $id): void {
                $out = fopen('php://temp', 'r+');
                self::$responses->exportResponsesStreaming($id, [['id' => 'name', 'type' => 'short_text', 'label' => 'Name']], $out);
                fclose($out);
            },
            'CSV import' => fn (string $id) => self::$responses->importResponses($id, [['Name' => 'Bob']], ['Name' => 'name'], [['id' => 'name', 'type' => 'short_text', 'label' => 'Name']]),
            'plaintext create' => fn (string $id) => self::$responses->createResponse($id, ['answers' => ['name' => 'Bob']]),
            'plaintext update' => fn (string $id) => self::$responses->updateResponse($id, 'whatever-id', ['status' => 'reviewed']),
            'script recompute' => fn (string $id) => self::$responses->recomputeResponse($id, 'whatever-id', 'return {};'),
            'field usage count' => fn (string $id) => self::$responses->countResponsesWithFieldValue($id, 'name'),
            'field data purge' => fn (string $id) => self::$responses->purgeFieldData($id, 'gone_field'),
            'webhook create' => fn (string $id) => self::$webhooks->createWebhook($id, $f['userId'], 'https://8.8.8.8/hook', ['response.created']),
            'flow binding create' => fn (string $id) => self::$flows->createFormBinding($f['userId'], $id, ['flow' => $wsFlow['slug'], 'event' => 'form.submitted', 'mode' => 'async']),
        ];

        foreach ($surfaces as $label => $surface) {
            try {
                $surface($priv);
                $this->fail("{$label}: private form was NOT refused");
            } catch (PrivateFormEncryptedException $e) {
                $this->assertStringContainsString('private_form_encrypted', $e->getMessage(), $label);
            }
            try {
                $surface($plain);
                $this->addToAssertionCount(1); // plain form serves normally
            } catch (PrivateFormEncryptedException $e) {
                $this->fail("{$label}: plain form was wrongly refused");
            }
        }

        // Listing WITHOUT content params stays ALLOWED on private forms (plan §9.2:
        // non-content operations are still server-side) — and returns ciphertext.
        $rows = self::$responses->getFormResponses($priv, ['limit' => 10]);
        $this->assertCount(1, $rows);
        $this->assertSame(1, $rows[0]['answers']['__flenc'] ?? null);

        // Chat/MCP record tools: all four ops refuse with the typed reason.
        $chat = new ChatToolsService(self::$forms, self::$apps, self::$responses, null, null, self::$flows, null);
        $ctx = new ChatToolsContext($f['userId']);
        foreach ([
            ['list_responses', ['formId' => $priv]],
            ['add_response', ['formId' => $priv, 'answers' => ['name' => 'Bob']]],
            ['update_response', ['formId' => $priv, 'responseId' => $envelope['recordId'], 'answers' => ['name' => 'Bob']]],
            ['delete_response', ['formId' => $priv, 'responseId' => $envelope['recordId']]],
        ] as [$tool, $args]) {
            try {
                $chat->call($tool, $args, $ctx);
                $this->fail("chat tool {$tool}: private form was NOT refused");
            } catch (ChatToolDeniedException $e) {
                $this->assertSame('private_form_encrypted', $e->getReasonCode(), $tool);
            }
        }
        $plainList = $chat->call('list_responses', ['formId' => $plain], $ctx);
        $this->assertNotEmpty($plainList, 'chat list works on a plain form');
    }

    public function testCloudFlowRunnerNodesRefusePrivateForms(): void
    {
        $f = $this->makePrivateForm();
        $p = $this->makePlainForm($f['userId']);
        self::$responses->createResponse($p['formId'], ['answers' => ['name' => 'Ada']]);

        $runner = new CloudFlowRunner(
            self::$mysql,
            self::$responses,
            new AIService(),
            new PlanService(self::$mysql, new FileStorageService(['storagePath' => self::$tmpRoot . '/uploads']), ['planEnforced' => true]),
            new DesktopCommandService(self::$mysql),
            'https://site.example'
        );
        // list node against the PRIVATE form → typed node failure carrying the marker.
        $listPrivate = self::$flows->createWorkspaceFlow($f['userId'], [
            'name' => 'List private ' . bin2hex(random_bytes(3)),
            'flowJson' => ['nodes' => [['id' => 'list', 'type' => 'formlogic_list_responses', 'data' => ['form' => $f['formId']]]], 'edges' => []],
        ]);
        $outcome = $runner->run($listPrivate, $f['userId'], []);
        $this->assertSame('error', $outcome['status'], (string) json_encode($outcome));
        $this->assertStringContainsString('private_form_encrypted', $outcome['error']['message']);

        // submit node against the PRIVATE form → refused the same way.
        $submitPrivate = self::$flows->createWorkspaceFlow($f['userId'], [
            'name' => 'Submit private ' . bin2hex(random_bytes(3)),
            'flowJson' => ['nodes' => [['id' => 'sub', 'type' => 'formlogic_submit_response', 'data' => ['form' => $f['formId'], 'answers' => ['name' => 'x']]]], 'edges' => []],
        ]);
        $outcome = $runner->run($submitPrivate, $f['userId'], []);
        $this->assertSame('error', $outcome['status']);
        $this->assertStringContainsString('private_form_encrypted', $outcome['error']['message']);

        // The same list node against a PLAIN form runs to completion.
        $listPlain = self::$flows->createWorkspaceFlow($f['userId'], [
            'name' => 'List plain ' . bin2hex(random_bytes(3)),
            'flowJson' => ['nodes' => [['id' => 'list', 'type' => 'formlogic_list_responses', 'data' => ['form' => $p['formId']]]], 'edges' => []],
        ]);
        $outcome = $runner->run($listPlain, $f['userId'], []);
        $this->assertSame('done', $outcome['status'], (string) json_encode($outcome));
        $this->assertSame(1, $outcome['result']['count']);
    }

    public function testSqlDumpRefusesAppsContainingPrivateForms(): void
    {
        $f = $this->makePrivateForm();
        $app = self::$apps->createApp(['name' => 'Dump app'], $f['userId']);

        // Post-enable invariant (§9.1 both-ends rule): attaching a private form to
        // an app is refused at the feature's creation path.
        try {
            self::$apps->addFormToApp((string) $app['id'], $f['formId'], 'Private records');
            $this->fail('addFormToApp accepted a private form');
        } catch (PrivateFormEncryptedException $e) {
            $this->assertStringContainsString('private_form_encrypted', $e->getMessage());
        }

        // Defense in depth: even if an attachment row EXISTS (legacy drift, direct
        // SQL), the SQL dump still refuses rather than emitting ciphertext columns.
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'Drifted', 0, 1, '{}')")
            ->execute([$this->uuid4(), (string) $app['id'], $f['formId']]);
        $export = new AppDataExportService(self::$mysql, self::$sqlite, self::$forms, self::$apps, self::$tmpRoot . '/uploads');
        $this->expectException(PrivateFormEncryptedException::class);
        $export->generateSqlDump($app, 'mysql', static function (): void {
        });
    }
}
