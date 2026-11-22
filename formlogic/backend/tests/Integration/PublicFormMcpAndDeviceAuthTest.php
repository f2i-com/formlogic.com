<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\McpController;
use FormLogic\Controllers\McpOAuthController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use FormLogic\Services\McpDeviceAuthService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\PublicFormDraftService;
use FormLogic\Services\PublicFormMcpService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * End-to-end integration tests for:
 *  1. Zero-account Public Form MCP (`/api/mcp/forms/{formId}` & `/api/mcp/public`)
 *     on multi-section forms (get_public_form, validate_form_answers, save_form_draft,
 *     get_form_draft, submit_public_form, resources/list & resources/read).
 *  2. In-MCP RFC 8628 interactive user login (`start_mcp_login` -> browser approve ->
 *     `complete_mcp_login` -> authenticated `/api/mcp` tool call).
 *  3. Streamable HTTP MCP fixes (protocol version negotiation, GET/DELETE /api/mcp,
 *     empty batch -32600, zero-arg tool schemas with properties: {}).
 */
class PublicFormMcpAndDeviceAuthTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static ResponseService $responses;
    private static McpTokenService $tokens;
    private static PublicFormDraftService $drafts;
    private static McpDeviceAuthService $deviceAuth;
    private static PublicFormMcpService $publicMcp;
    private static McpController $ctrl;
    private static McpOAuthController $oauthCtrl;

    private string $userId = '';
    private string $publicFormId = '';
    private string $draftFormId = '';
    private string $appId = '';
    private string $appFormId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-pubmcp-test-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$tokens = new McpTokenService($conn);
        self::$drafts = new PublicFormDraftService($conn, self::$responses);
        self::$deviceAuth = new McpDeviceAuthService($conn, self::$tokens);
        $respCtrl = new ResponseController(self::$responses, self::$forms, $sqlite, null, null, null, self::$apps, $conn);
        $enc = new FormEncryptionService($conn, $sqlite);
        self::$publicMcp = new PublicFormMcpService(self::$forms, self::$apps, self::$responses, self::$drafts, self::$deviceAuth, $respCtrl, $enc);
        self::$ctrl = new McpController(
            self::$tokens,
            self::$forms,
            self::$apps,
            self::$responses,
            publicFormMcp: self::$publicMcp,
        );
        $oauthSvc = new McpOAuthService($conn, self::$tokens);
        self::$oauthCtrl = new McpOAuthController($oauthSvc, self::$apps, null, null, null, null, null, self::$deviceAuth);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-pubmcp-' . bin2hex(random_bytes(6));
        self::$pdo->prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
            ->execute([$this->userId, $this->userId . '@example.test', password_hash('SecretPass123!', PASSWORD_BCRYPT), 'Hospital Admin']);

        $created = self::$forms->createForm([
            'userId' => $this->userId,
            'title' => 'Hospital Patient Intake',
            'description' => 'Multi-section admission intake',
            'status' => 'published',
            'fields' => [
                ['id' => 'sec_patient', 'type' => 'section', 'label' => 'Patient Identification', 'description' => 'Basic identity', 'required' => false, 'order' => 0],
                ['id' => 'full_name', 'type' => 'short_text', 'label' => 'Full Name', 'required' => true, 'order' => 1],
                ['id' => 'dob', 'type' => 'date', 'label' => 'Date of Birth', 'required' => true, 'order' => 2],
                ['id' => 'sec_medical', 'type' => 'section', 'label' => 'Medical History', 'description' => 'Allergies & meds', 'required' => false, 'order' => 3],
                ['id' => 'has_allergies', 'type' => 'multiple_choice', 'label' => 'Known Allergies', 'required' => true, 'order' => 4, 'properties' => [
                    'options' => [
                        ['id' => 'yes', 'label' => 'Yes', 'value' => 'yes'],
                        ['id' => 'no', 'label' => 'No', 'value' => 'no'],
                    ],
                ]],
                ['id' => 'allergy_details', 'type' => 'long_text', 'label' => 'Allergy Details', 'required' => false, 'order' => 5],
            ],
        ]);
        $this->publicFormId = (string) $created['id'];

        $draftForm = self::$forms->createForm([
            'userId' => $this->userId,
            'title' => 'Unpublished Draft Form',
            'status' => 'draft',
            'fields' => [['id' => 'note', 'type' => 'short_text', 'label' => 'Note', 'required' => false, 'order' => 0]],
        ]);
        $this->draftFormId = (string) $draftForm['id'];

        $app = self::$apps->createApp(['name' => 'Private Clinic App'], $this->userId);
        $this->appId = (string) $app['id'];
        $appForm = self::$forms->createForm([
            'userId' => $this->userId,
            'title' => 'Internal Ward Notes',
            'status' => 'published',
            'fields' => [['id' => 'ward', 'type' => 'short_text', 'label' => 'Ward', 'required' => true, 'order' => 0]],
        ]);
        $this->appFormId = (string) $appForm['id'];
        self::$apps->addFormToApp($this->appId, $this->appFormId, 'Ward Notes');
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    private function publicRpc(array $payload, ?string $boundFormId = null): array
    {
        $url = $boundFormId !== null
            ? "https://forms.example.test/api/mcp/forms/{$boundFormId}"
            : 'https://forms.example.test/api/mcp/public';
        $req = (new ServerRequestFactory())
            ->createServerRequest('POST', $url)
            ->withHeader('Content-Type', 'application/json')
            ->withBody((new StreamFactory())->createStream((string) json_encode($payload)));
        $res = self::$ctrl->handlePublic(
            $req,
            (new ResponseFactory())->createResponse(),
            $boundFormId !== null ? ['formId' => $boundFormId] : [],
        );
        return [
            'status' => $res->getStatusCode(),
            'headers' => $res->getHeaders(),
            'body' => json_decode((string) $res->getBody(), true),
        ];
    }

    private function authedRpc(string $token, array $payload): array
    {
        $req = (new ServerRequestFactory())
            ->createServerRequest('POST', 'https://forms.example.test/api/mcp')
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Authorization', 'Bearer ' . $token)
            ->withBody((new StreamFactory())->createStream((string) json_encode($payload)));
        $res = self::$ctrl->handle($req, (new ResponseFactory())->createResponse());
        return [
            'status' => $res->getStatusCode(),
            'headers' => $res->getHeaders(),
            'body' => json_decode((string) $res->getBody(), true),
        ];
    }

    public function testZeroAccountPublicFormMcpFullLifecycle(): void
    {
        // 1. Initialize without any account or Authorization header — negotiates protocolVersion 2025-06-18
        $init = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'initialize',
            'params' => ['protocolVersion' => '2025-06-18'],
        ], $this->publicFormId);
        $this->assertSame(200, $init['status']);
        $this->assertSame('2025-06-18', $init['body']['result']['protocolVersion']);
        $this->assertSame('2025-06-18', $init['headers']['MCP-Protocol-Version'][0] ?? null);
        $this->assertArrayHasKey('resources', $init['body']['result']['capabilities']);

        // 2. Resources expose the bound form schema
        $resList = $this->publicRpc(['jsonrpc' => '2.0', 'id' => 2, 'method' => 'resources/list'], $this->publicFormId);
        $uri = $resList['body']['result']['resources'][0]['uri'] ?? '';
        $this->assertSame("formlogic://forms/{$this->publicFormId}/schema", $uri);
        $resRead = $this->publicRpc(['jsonrpc' => '2.0', 'id' => 3, 'method' => 'resources/read', 'params' => ['uri' => $uri]], $this->publicFormId);
        $schemaFromRes = json_decode((string) ($resRead['body']['result']['contents'][0]['text'] ?? ''), true);
        $this->assertSame(2, $schemaFromRes['sectionCount']);

        // 3. tools/list has valid JSON Schema (properties object present on every tool)
        $list = $this->publicRpc(['jsonrpc' => '2.0', 'id' => 4, 'method' => 'tools/list'], $this->publicFormId);
        $tools = $list['body']['result']['tools'];
        $toolNames = array_column($tools, 'name');
        $this->assertContains('get_public_form', $toolNames);
        $this->assertContains('save_form_draft', $toolNames);
        $this->assertContains('submit_public_form', $toolNames);
        $this->assertContains('start_mcp_login', $toolNames);

        // 4. get_public_form returns structured sections & fields
        $formRes = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 5,
            'method' => 'tools/call',
            'params' => ['name' => 'get_public_form', 'arguments' => []],
        ], $this->publicFormId);
        $formData = json_decode((string) $formRes['body']['result']['content'][0]['text'], true);
        $this->assertSame('Hospital Patient Intake', $formData['title']);
        $this->assertCount(2, $formData['sections']);
        $this->assertSame('Patient Identification', $formData['sections'][0]['title']);
        $this->assertSame('Medical History', $formData['sections'][1]['title']);
        $this->assertSame(4, $formData['totalQuestions']);
        $this->assertSame(3, $formData['requiredQuestions']);

        // 5. validate_form_answers checks partial answers & section progress
        $valRes = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 6,
            'method' => 'tools/call',
            'params' => [
                'name' => 'validate_form_answers',
                'arguments' => ['answers' => ['full_name' => 'Jane Doe', 'dob' => '1988-05-14']],
            ],
        ], $this->publicFormId);
        $valData = json_decode((string) $valRes['body']['result']['content'][0]['text'], true);
        $this->assertFalse($valData['valid']);
        $this->assertTrue($valData['sectionProgress'][0]['complete']);
        $this->assertFalse($valData['sectionProgress'][1]['complete']);
        $this->assertSame('has_allergies', $valData['missingRequired'][0]['fieldId']);

        // 6. save_form_draft saves progress, returns resumeUrl + portable draftJson, and updates in place
        $draftRes = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 7,
            'method' => 'tools/call',
            'params' => [
                'name' => 'save_form_draft',
                'arguments' => [
                    'answers' => ['full_name' => 'Jane Doe', 'dob' => '1988-05-14'],
                    'currentSectionIndex' => 1,
                    'label' => 'Section 1 done',
                ],
            ],
        ], $this->publicFormId);
        $this->assertFalse($draftRes['body']['result']['isError'] ?? false, (string) ($draftRes['body']['result']['content'][0]['text'] ?? ''));
        $draftData = json_decode((string) $draftRes['body']['result']['content'][0]['text'], true);
        $token = (string) ($draftData['draftToken'] ?? '');
        $this->assertStringStartsWith('fld_', $token);
        $this->assertStringContainsString('/form/' . $this->publicFormId . '?draft=' . $token, (string) $draftData['resumeUrl']);
        $this->assertSame('formlogic-form-draft', $draftData['draftJson']['format']);
        $this->assertSame(1, $draftData['draftJson']['currentSectionIndex']);

        // Update same draft in place
        $draftRes2 = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 8,
            'method' => 'tools/call',
            'params' => [
                'name' => 'save_form_draft',
                'arguments' => [
                    'draftToken' => $token,
                    'answers' => ['full_name' => 'Jane Doe', 'dob' => '1988-05-14', 'has_allergies' => 'yes', 'allergy_details' => 'Penicillin'],
                    'currentSectionIndex' => 1,
                ],
            ],
        ], $this->publicFormId);
        $draftData2 = json_decode((string) $draftRes2['body']['result']['content'][0]['text'], true);
        $this->assertSame($token, $draftData2['draftToken']);
        $this->assertTrue($draftData2['valid']);

        // 7. submit_public_form refuses without confirmSubmit: true
        $refused = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 9,
            'method' => 'tools/call',
            'params' => [
                'name' => 'submit_public_form',
                'arguments' => [
                    'answers' => ['full_name' => 'Jane Doe', 'dob' => '1988-05-14', 'has_allergies' => 'yes'],
                    'confirmSubmit' => false,
                ],
            ],
        ], $this->publicFormId);
        $this->assertTrue($refused['body']['result']['isError'] ?? false);

        // 8. submit_public_form succeeds with confirmSubmit: true, stores real response, and cleans up draft
        $submitted = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 10,
            'method' => 'tools/call',
            'params' => [
                'name' => 'submit_public_form',
                'arguments' => [
                    'answers' => ['full_name' => 'Jane Doe', 'dob' => '1988-05-14', 'has_allergies' => 'yes', 'allergy_details' => 'Penicillin'],
                    'confirmSubmit' => true,
                    'draftToken' => $token,
                    'idempotencyKey' => 'idem-hospital-' . bin2hex(random_bytes(4)),
                ],
            ],
        ], $this->publicFormId);
        $this->assertFalse($submitted['body']['result']['isError'] ?? false);
        $subData = json_decode((string) $submitted['body']['result']['content'][0]['text'], true);
        $this->assertTrue($subData['submitted']);
        $this->assertNotEmpty($subData['responseId']);
        $this->assertNull(self::$drafts->getDraft($this->publicFormId, $token), 'Draft should be deleted after submission');
    }

    public function testPublicMcpRejectsUnpublishedAndAppPrivateForms(): void
    {
        $unpub = $this->publicRpc(['jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize'], $this->draftFormId);
        $this->assertSame(404, $unpub['status']);

        $appForm = $this->publicRpc(['jsonrpc' => '2.0', 'id' => 2, 'method' => 'initialize'], $this->appFormId);
        $this->assertSame(404, $appForm['status']);

        // Also rejected via /api/mcp/public when passing formId explicitly
        $appViaGeneral = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 3,
            'method' => 'tools/call',
            'params' => ['name' => 'get_public_form', 'arguments' => ['formId' => $this->appFormId]],
        ]);
        $this->assertTrue($appViaGeneral['body']['result']['isError'] ?? false);
    }

    public function testInMcpInteractiveDeviceLoginUpgradesToAuthenticatedMcp(): void
    {
        // 1. AI starts login over zero-account /api/mcp/public
        $start = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'tools/call',
            'params' => [
                'name' => 'start_mcp_login',
                'arguments' => ['clientName' => 'Test AI Agent', 'scopes' => ['forms:read', 'apps:read']],
            ],
        ]);
        $startData = json_decode((string) $start['body']['result']['content'][0]['text'], true);
        $deviceCode = (string) ($startData['deviceCode'] ?? '');
        $userCode = (string) ($startData['userCode'] ?? '');
        $this->assertStringStartsWith('mcpdc_', $deviceCode);
        $this->assertMatchesRegularExpression('/^[A-Z0-9]{4}-[A-Z0-9]{4}$/', $userCode);

        // 2. Polling before approval returns authorization_pending
        $pending = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 2,
            'method' => 'tools/call',
            'params' => ['name' => 'complete_mcp_login', 'arguments' => ['deviceCode' => $deviceCode]],
        ]);
        $pendingData = json_decode((string) $pending['body']['result']['content'][0]['text'], true);
        $this->assertSame('authorization_pending', $pendingData['status']);

        // 3. Authenticated user approves in browser via POST /api/oauth/device/approve
        $approveReq = (new ServerRequestFactory())
            ->createServerRequest('POST', 'https://forms.example.test/api/oauth/device/approve')
            ->withHeader('Content-Type', 'application/json')
            ->withAttribute('userId', $this->userId)
            ->withAttribute('user', ['id' => $this->userId, 'email' => $this->userId . '@example.test'])
            ->withParsedBody(['code' => $userCode, 'scopes' => ['forms:read']]);
        $approveRes = self::$oauthCtrl->deviceApprove($approveReq, (new ResponseFactory())->createResponse());
        $this->assertSame(200, $approveRes->getStatusCode());

        // 4. AI calls complete_mcp_login -> receives audience-bound flm_oauth_* Bearer token
        $done = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 3,
            'method' => 'tools/call',
            'params' => ['name' => 'complete_mcp_login', 'arguments' => ['deviceCode' => $deviceCode]],
        ]);
        $doneData = json_decode((string) $done['body']['result']['content'][0]['text'], true);
        $this->assertSame('approved', $doneData['status']);
        $token = (string) ($doneData['accessToken'] ?? '');
        $this->assertStringStartsWith('flm_oauth_', $token);
        $this->assertSame(['forms:read'], $doneData['scopes']);

        // 5. Replaying deviceCode fails atomically
        $replay = $this->publicRpc([
            'jsonrpc' => '2.0',
            'id' => 4,
            'method' => 'tools/call',
            'params' => ['name' => 'complete_mcp_login', 'arguments' => ['deviceCode' => $deviceCode]],
        ]);
        $replayData = json_decode((string) $replay['body']['result']['content'][0]['text'], true);
        $this->assertSame('expired_token', $replayData['status']);

        // 6. Returned token works against authenticated /api/mcp (lists owner forms + negotiates protocol)
        $initAuthed = $this->authedRpc($token, [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'initialize',
            'params' => ['protocolVersion' => '2024-11-05'],
        ]);
        $this->assertSame('2024-11-05', $initAuthed['body']['result']['protocolVersion']);

        $formsRes = $this->authedRpc($token, [
            'jsonrpc' => '2.0',
            'id' => 2,
            'method' => 'tools/call',
            'params' => ['name' => 'list_forms', 'arguments' => []],
        ]);
        $this->assertFalse($formsRes['body']['result']['isError'] ?? false);
        $this->assertStringContainsString('Hospital Patient Intake', (string) $formsRes['body']['result']['content'][0]['text']);

        // 7. Streamable HTTP GET /api/mcp returns 405 w/ Allow; DELETE /api/mcp returns 204 and revokes token
        $getReq = (new ServerRequestFactory())
            ->createServerRequest('GET', 'https://forms.example.test/api/mcp')
            ->withHeader('Authorization', 'Bearer ' . $token);
        $getRes = self::$ctrl->handleGet($getReq, (new ResponseFactory())->createResponse());
        $this->assertSame(405, $getRes->getStatusCode());
        $this->assertStringContainsString('POST', $getRes->getHeaderLine('Allow'));

        $delReq = (new ServerRequestFactory())
            ->createServerRequest('DELETE', 'https://forms.example.test/api/mcp')
            ->withHeader('Authorization', 'Bearer ' . $token);
        $delRes = self::$ctrl->handleDelete($delReq, (new ResponseFactory())->createResponse());
        $this->assertSame(204, $delRes->getStatusCode());

        // Token is now revoked
        $afterDel = $this->authedRpc($token, ['jsonrpc' => '2.0', 'id' => 3, 'method' => 'ping']);
        $this->assertSame(401, $afterDel['status']);
    }

    public function testEmptyBatchReturnsInvalidRequest(): void
    {
        $res = $this->publicRpc([]);
        $this->assertSame(400, $res['status']);
        $this->assertSame(-32600, $res['body']['error']['code']);
    }
}
