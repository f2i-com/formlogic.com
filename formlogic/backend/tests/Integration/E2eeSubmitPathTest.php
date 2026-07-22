<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ResponseController;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\ResponseService;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * §6/§8 submit path (plan gates: dispatch-order test; stale-rev concurrent edit
 * → 409 via the atomic UPDATE; superseded-manifest acceptance follows key grace
 * exactly; plaintext-answers writes rejected BEFORE sanitation).
 */
class E2eeSubmitPathTest extends E2eeTestCase
{
    private string $formId = '';
    /** @var array<string,string> vault keys captured at enable (for manifest signing) */
    private array $setUpVault = [];

    protected function setUp(): void
    {
        parent::setUp();
        $form = $this->makeDraftForm();
        $this->formId = (string) $form['id'];
        $enabled = $this->enablePrivateForm($this->formId);
        $this->setUpVault = $enabled['vault'];
        // Private forms still require 'published' to accept submissions (same as public).
        self::$forms->updateForm($this->formId, ['status' => 'published']);
    }

    private function controller(): ResponseController
    {
        return new ResponseController(
            self::$responses,
            self::$forms,
            self::$sqlite,
            null,
            null,
            null,
            self::$apps,
            self::$mysql
        );
    }

    private function jsonRequest(string $method, array $body, array $attributes = []): ServerRequestInterface
    {
        $stream = (new StreamFactory())->createStream((string) json_encode($body));
        $req = (new ServerRequestFactory())
            ->createServerRequest($method, 'http://api.test/api/forms/' . $this->formId . '/responses')
            ->withBody($stream)
            ->withHeader('Content-Type', 'application/json');
        foreach ($attributes as $k => $v) {
            $req = $req->withAttribute($k, $v);
        }
        return $req;
    }

    /** @return array{status: int, body: array<string,mixed>} */
    private function call(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return ['status' => $response->getStatusCode(), 'body' => (array) json_decode((string) $response->getBody(), true)];
    }

    private function sqliteRowCount(): int
    {
        return (int) self::$sqlite->getFormDatabase($this->formId)->query('SELECT COUNT(*) FROM responses')->fetchColumn();
    }

    // ── Dispatch order (plan gate) ────────────────────────────────────────────

    public function testPlaintextAnswersWriteIsRejectedBeforeSanitation(): void
    {
        // A perfectly valid PLAINTEXT submission for this form's fields — it must
        // be refused without ever entering the legacy pipeline ('answers' is not
        // an allowed root key in private mode), and NOTHING may be stored.
        $res = $this->controller()->create(
            $this->jsonRequest('POST', ['answers' => ['name' => 'plaintext smuggle']]),
            new SlimResponse(),
            ['formId' => $this->formId]
        );
        $out = $this->call($res);
        $this->assertSame(400, $out['status']);
        $this->assertSame('envelope_invalid', $out['body']['code'] ?? null);
        $this->assertSame(0, $this->sqliteRowCount());
        $this->assertSame(0, (int) $this->row('SELECT COUNT(*) AS c FROM response_metadata WHERE form_id = ?', [$this->formId])['c']);
    }

    public function testPlaintextOwnerUpdateIsRejected(): void
    {
        // Seed one envelope, then try a legacy PATCH-merge update.
        $env = $this->makeEnvelope($this->formId);
        self::$responses->createEncryptedResponse($this->formId, $env, null, null);

        $res = $this->controller()->update(
            $this->jsonRequest('PUT', ['answers' => ['name' => 'patch']], ['userId' => $this->userId]),
            new SlimResponse(),
            ['formId' => $this->formId, 'id' => $env['recordId']]
        );
        $out = $this->call($res);
        $this->assertSame(400, $out['status']);
        $this->assertSame('envelope_invalid', $out['body']['code'] ?? null);
    }

    // ── Envelope create (§8 storage branch + §12 metadata) ────────────────────

    public function testEnvelopeCreateStoresCiphertextRowWithMinimalMetadata(): void
    {
        $env = $this->makeEnvelope($this->formId);
        $res = $this->controller()->create(
            $this->jsonRequest('POST', ['envelope' => $env, 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6))]),
            new SlimResponse(),
            ['formId' => $this->formId]
        );
        $out = $this->call($res);
        $this->assertSame(201, $out['status']);
        $this->assertSame($env['recordId'], $out['body']['response']['id'] ?? null);

        // Row id == envelope recordId; answers == the envelope, verbatim.
        $row = self::$sqlite->getFormDatabase($this->formId)
            ->query('SELECT * FROM responses LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame($env['recordId'], $row['id']);
        $this->assertSame(json_encode($env, JSON_UNESCAPED_SLASHES), $row['answers']);
        // §12: SQLite metadata carries NOTHING for an anonymous submit (submittedByUserId only when present).
        $this->assertSame('{}', $row['metadata']);

        // MySQL mirror: ip kept for abuse forensics, UA/completion_time never written.
        $mirror = $this->row('SELECT * FROM response_metadata WHERE id = ?', [$env['recordId']]);
        $this->assertNotNull($mirror);
        $this->assertNull($mirror['user_agent']);
        $this->assertNull($mirror['completion_time']);
    }

    public function testAuthenticatedSubmitterRecordsOnlySubmittedByUserId(): void
    {
        $env = $this->makeEnvelope($this->formId);
        $submitter = $this->makeUser();
        $res = $this->controller()->create(
            $this->jsonRequest('POST', ['envelope' => $env], ['userId' => $submitter]),
            new SlimResponse(),
            ['formId' => $this->formId]
        );
        $this->assertSame(201, $this->call($res)['status']);
        $row = self::$sqlite->getFormDatabase($this->formId)
            ->query('SELECT metadata FROM responses LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame(['submittedByUserId' => $submitter], json_decode((string) $row['metadata'], true));
    }

    public function testIdempotentReplayReturnsOriginalWithoutDuplicate(): void
    {
        $env = $this->makeEnvelope($this->formId);
        $key = 'k-' . bin2hex(random_bytes(6));
        $first = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env, 'idempotencyKey' => $key]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(201, $first['status']);
        $replay = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env, 'idempotencyKey' => $key]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(200, $replay['status']);
        $this->assertTrue($replay['body']['idempotent'] ?? false);
        $this->assertSame($env['recordId'], $replay['body']['response']['id'] ?? null);
        $this->assertSame(1, $this->sqliteRowCount());
    }

    public function testIdempotencyKeyReuseWithDifferentEnvelopeConflicts(): void
    {
        $key = 'k-' . bin2hex(random_bytes(6));
        $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $this->makeEnvelope($this->formId), 'idempotencyKey' => $key]), new SlimResponse(), ['formId' => $this->formId]));
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $this->makeEnvelope($this->formId), 'idempotencyKey' => $key]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(409, $out['status']);
        $this->assertTrue($out['body']['conflict'] ?? false);
    }

    public function testDuplicateRecordIdIsRejected(): void
    {
        $env = $this->makeEnvelope($this->formId);
        $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env]), new SlimResponse(), ['formId' => $this->formId]));
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(409, $out['status']);
        $this->assertSame('duplicate_record_id', $out['body']['code'] ?? null);
        $this->assertSame(1, $this->sqliteRowCount());
    }

    public function testAttachmentsAreRefusedUntilP4(): void
    {
        $env = $this->makeEnvelope($this->formId);
        $env['attachments'] = ['fil_' . bin2hex(random_bytes(6))];
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(400, $out['status']);
        $this->assertSame('envelope_invalid', $out['body']['code'] ?? null);
    }

    // ── rev CAS (plan gate: concurrent stale-rev edit → 409, atomic UPDATE) ───

    public function testRevCasUpdateLifecycle(): void
    {
        $env = $this->makeEnvelope($this->formId);
        $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env]), new SlimResponse(), ['formId' => $this->formId]));

        // expectedRev 1 → rev 2 wins.
        $env2 = $this->makeEnvelope($this->formId, 2, $env['recordId']);
        $win = $this->call($this->controller()->update(
            $this->jsonRequest('PUT', ['envelope' => $env2, 'expectedRev' => 1], ['userId' => $this->userId]),
            new SlimResponse(),
            ['formId' => $this->formId, 'id' => $env['recordId']]
        ));
        $this->assertSame(200, $win['status']);
        $this->assertSame(2, $win['body']['response']['rev'] ?? null);

        // The stale concurrent editor (same expectedRev 1) loses with a typed 409 + currentRev.
        $env2b = $this->makeEnvelope($this->formId, 2, $env['recordId']);
        $lose = $this->call($this->controller()->update(
            $this->jsonRequest('PUT', ['envelope' => $env2b, 'expectedRev' => 1], ['userId' => $this->userId]),
            new SlimResponse(),
            ['formId' => $this->formId, 'id' => $env['recordId']]
        ));
        $this->assertSame(409, $lose['status']);
        $this->assertSame('revision_conflict', $lose['body']['code'] ?? null);
        $this->assertSame(2, $lose['body']['details']['currentRev'] ?? null);

        // The stored envelope is the WINNER's, byte for byte.
        $row = self::$sqlite->getFormDatabase($this->formId)
            ->query('SELECT answers FROM responses LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame(json_encode($env2, JSON_UNESCAPED_SLASHES), $row['answers']);
    }

    public function testAtomicUpdateExactlyOneWinner(): void
    {
        $env = $this->makeEnvelope($this->formId);
        self::$responses->createEncryptedResponse($this->formId, $env, null, null);
        // Two editors race the SAME expectedRev against the service's single
        // conditional UPDATE — the database guarantees exactly one row-affected.
        $a = self::$responses->updateEncryptedResponse($this->formId, $env['recordId'], $this->makeEnvelope($this->formId, 2, $env['recordId']), 1);
        $b = self::$responses->updateEncryptedResponse($this->formId, $env['recordId'], $this->makeEnvelope($this->formId, 2, $env['recordId']), 1);
        $this->assertTrue($a['ok']);
        $this->assertTrue($b['found']);
        $this->assertFalse($b['ok']);
        $this->assertSame(2, $b['currentRev']);
    }

    public function testUpdateRejectsWrongExpectedRevPlusOne(): void
    {
        $env = $this->makeEnvelope($this->formId);
        self::$responses->createEncryptedResponse($this->formId, $env, null, null);
        // rev must be expectedRev + 1 exactly (replay of an OLD revision is rejected).
        $stale = $this->makeEnvelope($this->formId, 3, $env['recordId']);
        $out = $this->call($this->controller()->update(
            $this->jsonRequest('PUT', ['envelope' => $stale, 'expectedRev' => 1], ['userId' => $this->userId]),
            new SlimResponse(),
            ['formId' => $this->formId, 'id' => $env['recordId']]
        ));
        $this->assertSame(409, $out['status']);
        $this->assertSame('revision_conflict', $out['body']['code'] ?? null);
    }

    public function testUpdateRejectsRecordIdMismatch(): void
    {
        $env = $this->makeEnvelope($this->formId);
        self::$responses->createEncryptedResponse($this->formId, $env, null, null);
        $other = $this->makeEnvelope($this->formId, 2, $this->uuidV4());
        $out = $this->call($this->controller()->update(
            $this->jsonRequest('PUT', ['envelope' => $other, 'expectedRev' => 1], ['userId' => $this->userId]),
            new SlimResponse(),
            ['formId' => $this->formId, 'id' => $env['recordId']]
        ));
        $this->assertSame(400, $out['status']);
        $this->assertSame('envelope_invalid', $out['body']['code'] ?? null);
    }

    // ── Key grace windows (plan §8/§11: schema grace ≡ key grace) ─────────────

    private function setKeyState(string $state, ?string $acceptUntil): void
    {
        self::$pdo->prepare('UPDATE form_ingestion_keys SET state = ?, accept_until = ? WHERE form_id = ?')
            ->execute([$state, $acceptUntil, $this->formId]);
        FormEncryptionService::invalidateCache();
    }

    public function testRetiringKeyWithinGraceStillAccepts(): void
    {
        $this->setKeyState('retiring', date('Y-m-d H:i:s', time() + 3600));
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $this->makeEnvelope($this->formId)]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(201, $out['status']);
    }

    public function testRetiringKeyPastGraceRejects(): void
    {
        $env = $this->makeEnvelope($this->formId); // minted while the key is still acceptable
        $this->setKeyState('retiring', date('Y-m-d H:i:s', time() - 60));
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(409, $out['status']);
        $this->assertSame('key_epoch_retired', $out['body']['code'] ?? null);
    }

    public function testRetiredKeyRejects(): void
    {
        $env = $this->makeEnvelope($this->formId);
        $this->setKeyState('retired', null);
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $env]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(409, $out['status']);
        $this->assertSame('key_epoch_retired', $out['body']['code'] ?? null);
    }

    public function testSupersededManifestAcceptanceFollowsKeyGraceExactly(): void
    {
        // Publish schema v2 (owner-signed with the vault key captured at enable).
        $vaultRow = $this->row('SELECT x25519_pk, ed25519_pk FROM user_vaults WHERE user_id = ?', [$this->userId]);
        $this->assertNotNull($vaultRow);
        $keyRow = $this->row('SELECT id, public_key FROM form_ingestion_keys WHERE form_id = ? AND epoch = 1', [$this->formId]);
        $this->assertNotNull($keyRow);
        $signerKeyId = substr(hash('sha256', base64_decode((string) $vaultRow['ed25519_pk'])), 0, 16);
        $schemaJson = json_encode([['id' => 'name', 'type' => 'short_text', 'label' => 'Name v2']], JSON_UNESCAPED_SLASHES);
        $schemaHash = hash('sha256', (string) $schemaJson);
        $manifestSig = sodium_crypto_sign_detached(
            $this->manifestCanonical($this->formId, (string) $keyRow['id'], 1, (string) $keyRow['public_key'], 2, $schemaHash, $signerKeyId),
            $this->setUpVault['ed25519SkRaw']
        );
        $result = self::$encryption->publishSchemaVersion($this->formId, $this->userId, [
            'schema' => ['schemaJson' => $schemaJson, 'schemaHash' => $schemaHash],
            'manifest' => ['signature' => base64_encode($manifestSig), 'signerKeyId' => $signerKeyId, 'expiresAt' => null],
        ]);
        $this->assertSame(2, $result['schemaVersion']);
        $this->assertSame(2, $result['manifestSeq']);

        // v1 manifest superseded; v2 current.
        $v1 = $this->row('SELECT superseded_at FROM form_manifests WHERE form_id = ? AND manifest_seq = 1', [$this->formId]);
        $this->assertNotNull($v1['superseded_at']);

        // The OLD (v1) tuple stays acceptable while the key is active (schema grace ≡ key grace).
        $envV1 = $this->makeEnvelope($this->formId, 1, null, 1);
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $envV1]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(201, $out['status']);

        // The NEW (v2) tuple is accepted too.
        $envV2 = $this->makeEnvelope($this->formId, 1, null, 2);
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $envV2]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(201, $out['status']);

        // Retire the key → BOTH tuples stop being acceptable in the same instant.
        $envAfterRetire = $this->makeEnvelope($this->formId);
        $this->setKeyState('retired', null);
        $out = $this->call($this->controller()->create($this->jsonRequest('POST', ['envelope' => $envAfterRetire]), new SlimResponse(), ['formId' => $this->formId]));
        $this->assertSame(409, $out['status']);
        $this->assertSame('key_epoch_retired', $out['body']['code'] ?? null);
    }
}
