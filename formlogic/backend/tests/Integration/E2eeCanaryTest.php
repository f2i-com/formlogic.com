<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ResponseController;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * THE PLAINTEXT CANARY (plan §16 standing gate, new from P3): a canary answer
 * seeded through a private form must appear NOWHERE server-side — not in the
 * per-form SQLite (+ WAL/SHM), not in any MySQL table, not in logs, not in any
 * API payload. The server must hold ciphertext only.
 */
class E2eeCanaryTest extends E2eeTestCase
{
    private string $formId = '';

    protected function setUp(): void
    {
        parent::setUp();
        $form = $this->makeDraftForm();
        $this->formId = (string) $form['id'];
        $this->enablePrivateForm($this->formId);
        self::$forms->updateForm($this->formId, ['status' => 'published']);
    }

    public function testCanaryAppearsNowhereServerSide(): void
    {
        $canary = 'FLCANARY-' . bin2hex(random_bytes(12));

        // 1. A plaintext smuggle attempt is refused (the canary must not land anywhere).
        $controller = new ResponseController(
            self::$responses, self::$forms, self::$sqlite, null, null, null, self::$apps, self::$mysql
        );
        $smuggle = (new ServerRequestFactory())
            ->createServerRequest('POST', 'http://api.test/api/forms/' . $this->formId . '/responses')
            ->withBody((new StreamFactory())->createStream(json_encode(['answers' => ['name' => $canary]])))
            ->withHeader('Content-Type', 'application/json');
        $res = $controller->create($smuggle, new SlimResponse(), ['formId' => $this->formId]);
        $this->assertSame(400, $res->getStatusCode());

        // 2. The client seals {answers: {name: <canary>}} — the server only ever sees
        //    the envelope (random ct here; it can never contain the canary plaintext).
        $env = $this->makeEnvelope($this->formId);
        self::$responses->createEncryptedResponse($this->formId, $env, $this->userId, '203.0.113.7');

        // Positive control: the CIPHERTEXT is stored.
        $db = self::$sqlite->getFormDatabase($this->formId);
        $row = $db->query('SELECT * FROM responses LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame($env['recordId'], $row['id']);
        $this->assertStringContainsString('__flenc', (string) $row['answers']);
        $this->assertStringContainsString($env['ct'], (string) $row['answers']);

        // ── The sweep ────────────────────────────────────────────────────────

        // (a) The per-form SQLite file itself, its WAL and SHM.
        $dbPath = self::$sqlite->getFormDbPath($this->formId);
        foreach ([$dbPath, $dbPath . '-wal', $dbPath . '-shm'] as $file) {
            if (is_file($file)) {
                $this->assertStringNotContainsString($canary, (string) file_get_contents($file), "canary found in {$file}");
            }
        }

        // (b) Every MySQL table that touches this form or the vault.
        foreach ([
            ['response_metadata', 'form_id = ?', [$this->formId]],
            ['form_encryption', 'form_id = ?', [$this->formId]],
            ['form_ingestion_keys', 'form_id = ?', [$this->formId]],
            ['form_key_grants', 'form_id = ?', [$this->formId]],
            ['form_manifests', 'form_id = ?', [$this->formId]],
            ['form_schema_versions', 'form_id = ?', [$this->formId]],
            ['user_vaults', 'user_id = ?', [$this->userId]],
        ] as [$table, $where, $params]) {
            $stmt = self::$pdo->prepare("SELECT * FROM {$table} WHERE {$where}");
            $stmt->execute($params);
            $dump = json_encode($stmt->fetchAll(\PDO::FETCH_ASSOC));
            $this->assertStringNotContainsString($canary, (string) $dump, "canary found in MySQL {$table}");
        }

        // (c) API payloads: owner list + single record read return ciphertext only.
        $listReq = (new ServerRequestFactory())
            ->createServerRequest('GET', 'http://api.test/api/forms/' . $this->formId . '/responses')
            ->withAttribute('userId', $this->userId);
        $listRes = $controller->index($listReq, new SlimResponse(), ['formId' => $this->formId]);
        $listRes->getBody()->rewind();
        $payload = (string) $listRes->getBody();
        $this->assertStringContainsString('__flenc', $payload); // control: ciphertext served
        $this->assertStringNotContainsString($canary, $payload);

        $showReq = (new ServerRequestFactory())
            ->createServerRequest('GET', 'http://api.test/x')
            ->withAttribute('userId', $this->userId);
        $showRes = $controller->show($showReq, new SlimResponse(), ['formId' => $this->formId, 'id' => $env['recordId']]);
        $showRes->getBody()->rewind();
        $this->assertStringNotContainsString($canary, (string) $showRes->getBody());

        // (d) Server logs (rotating daily files — the canary is unique per run).
        $logDir = dirname(__DIR__, 2) . '/storage/logs';
        if (is_dir($logDir)) {
            foreach (glob($logDir . '/*.log') ?: [] as $logFile) {
                $contents = @file_get_contents($logFile);
                if ($contents !== false) {
                    $this->assertStringNotContainsString($canary, $contents, "canary found in log {$logFile}");
                }
            }
        }
    }
}
