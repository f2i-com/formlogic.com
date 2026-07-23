<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataOperationLogService;
use FormLogic\Services\DataPlacementService;
use FormLogic\Services\DataSnapshotService;
use FormLogic\Support\DataCanonicalJson;

/**
 * N3b — the Cloud-primary signed operation log (plan §12, §27-N3;
 * docs/FORMLOGIC_DATA_NODES.md §12): every write on a placement-signed form
 * appends a chained, signed flop:1 op in the same transaction as the row;
 * CAS misses append nothing; heads verify; legacy forms are untouched; and
 * snapshots carry the real history.
 */
final class DataOperationLogTest extends E2eeTestCase
{
    private static DataCloudSigner $signer;
    private static DataOperationLogService $opLog;
    private static DataPlacementService $placement;
    private static DataSnapshotService $snapshots;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        self::$signer = new DataCloudSigner(self::$tmpRoot . '/keys/data-cloud-signing.key');
        self::$opLog = new DataOperationLogService(self::$mysql, self::$signer);
        self::$placement = new DataPlacementService(self::$mysql, self::$signer);
        self::$snapshots = new DataSnapshotService(self::$mysql, self::$sqlite, self::$signer, self::$tmpRoot . '/data-snapshots');
        self::$responses->setDataOperationLog(self::$opLog);
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$mysql !== null) {
            self::$responses->setDataOperationLog(null);
        }
        parent::tearDownAfterClass();
    }

    /** @return array{formId: string, vault: array<string,mixed>} */
    private function placedPrivateForm(): array
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        ['vault' => $vault] = $this->enablePrivateForm($formId);
        $edPkRaw = base64_decode($vault['ed25519PkB64']);
        $identity = self::$signer->publicIdentity();
        $authority = [
            'keyId' => $identity['keyId'],
            'generation' => 1,
            'ed25519PublicKey' => $identity['publicKey'],
            'fingerprint' => $identity['fingerprint'],
        ];
        $manifest = [
            'protocol' => 'formlogic-data-sync/1',
            'datasetId' => $formId,
            'formId' => $formId,
            'protocolVersion' => 1,
            'storageEpoch' => 1,
            'primaryReplicaId' => 'cloud',
            'replicas' => [[
                'replicaId' => 'cloud', 'kind' => 'cloud', 'role' => 'primary', 'desiredState' => 'active',
                'authoritySigningKey' => $authority, 'transportKeyFingerprint' => $identity['fingerprint'],
            ]],
            'offlineSubmissionPolicy' => ['mode' => 'reject'],
            'readFallbackPolicy' => ['mode' => 'none'],
            'leaseAuthority' => $authority,
            'cutoverCheckpointHash' => null,
            'recoveryAuthorization' => null,
            'previousManifestHash' => null,
            'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'ownerSignerKeyId' => DataCanonicalJson::keyId($edPkRaw),
            'ownerSignerGeneration' => 1,
            'ownerSignerFingerprint' => DataCanonicalJson::fingerprint($edPkRaw),
        ];
        $manifest['signature'] = DataCanonicalJson::signB64(DataCanonicalJson::DOMAIN_PLACEMENT, $manifest, $vault['ed25519SkRaw']);
        self::$placement->putBaseline($formId, $this->userId, $manifest, $edPkRaw);
        self::$opLog->invalidatePlacementCache();
        return ['formId' => $formId, 'vault' => $vault];
    }

    public function testWritesAppendChainedSignedOpsAndCasMissAppendsNothing(): void
    {
        ['formId' => $formId] = $this->placedPrivateForm();
        $pk = self::$signer->publicKeyRaw();

        $first = self::$responses->createEncryptedResponse($formId, $this->makeEnvelope($formId), null, null);
        self::$responses->createEncryptedResponse($formId, $this->makeEnvelope($formId), null, null);

        $db = self::$sqlite->getFormDatabase($formId);
        $ops = $db->query('SELECT * FROM replication_operations ORDER BY sequence')->fetchAll(\PDO::FETCH_ASSOC);
        self::assertCount(2, $ops);
        $prevHash = null;
        foreach ($ops as $i => $row) {
            self::assertSame($i + 1, (int) $row['sequence'], 'contiguous sequence');
            self::assertSame('response.create', $row['kind']);
            self::assertSame($prevHash, $row['previous_hash'], 'hash chain');
            $op = json_decode((string) $row['canonical_operation'], true);
            self::assertTrue(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_OPERATION, $op, $pk), 'op signature');
            self::assertSame(
                (string) $row['operation_hash'],
                DataCanonicalJson::hashHex(DataCanonicalJson::DOMAIN_OPERATION, array_diff_key($op, ['signature' => true])),
            );
            self::assertSame(1, (int) $row['storage_epoch']);
            self::assertNotNull($row['encryption_manifest_hash'], 'op binds its accepted public manifest');
            $prevHash = (string) $row['operation_hash'];
        }

        // Update via CAS: row_version bumps, op 3 is an envelope.put.
        $env2 = $this->makeEnvelope($formId, 2, (string) $first['id']);
        $result = self::$responses->updateEncryptedResponse($formId, (string) $first['id'], $env2, 1);
        self::assertTrue($result['ok']);
        $row = $db->query("SELECT row_version FROM responses WHERE id = '{$first['id']}'")->fetchColumn();
        self::assertSame(2, (int) $row);
        $op3 = $db->query('SELECT * FROM replication_operations WHERE sequence = 3')->fetch(\PDO::FETCH_ASSOC);
        self::assertSame('response.envelope.put', $op3['kind']);
        self::assertSame(1, (int) $op3['base_rev']);
        self::assertSame(2, (int) $op3['rev']);
        self::assertSame(1, (int) $op3['expected_row_version']);
        self::assertSame(2, (int) $op3['row_version']);

        // CAS MISS (stale expectedRev): nothing appended, nothing changed.
        $stale = self::$responses->updateEncryptedResponse($formId, (string) $first['id'], $this->makeEnvelope($formId, 2, (string) $first['id']), 1);
        self::assertFalse($stale['ok']);
        self::assertSame(2, (int) $stale['currentRev']);
        self::assertSame(3, (int) $db->query('SELECT count(*) FROM replication_operations')->fetchColumn());

        // Head checkpoint verifies, matches the log head, and the Cloud anchor row agrees.
        $head = self::$opLog->headCheckpoint($db);
        self::assertIsArray($head);
        self::assertTrue(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_CHECKPOINT, $head, $pk));
        self::assertSame(3, $head['lastSequence']);
        self::assertSame($prevHash === null ? null : $op3['operation_hash'], $head['lastOperationHash']);
        self::assertSame(2, $head['recordCount']);
        $anchor = $this->row('SELECT * FROM data_dataset_high_water WHERE dataset_id = ?', [$formId]);
        self::assertNotNull($anchor);
        self::assertSame(3, (int) $anchor['last_acknowledged_sequence']);
        self::assertSame($op3['operation_hash'], $anchor['last_operation_hash']);

        // Snapshot now carries the real history + the real signed head.
        $snapshot = self::$snapshots->createSnapshot($this->userId, $formId);
        $dir = self::$tmpRoot . '/data-snapshots/' . $snapshot['snapshotId'];
        $opsFile = array_filter(explode("\n", (string) file_get_contents($dir . '/data/operations.ndjson')));
        self::assertCount(3, $opsFile);
        self::assertSame(1, $snapshot['manifest']['storageEpoch']);
        self::assertSame(3, $snapshot['manifest']['lastSequence']);
        $packagedHead = json_decode((string) file_get_contents($dir . '/manifests/checkpoint.json'), true);
        self::assertTrue(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_CHECKPOINT, $packagedHead, $pk));
        self::assertSame($head['logicalRoot'], $packagedHead['logicalRoot']);
        // Head root == package root (shared artifact-line builder guarantees it).
        self::assertSame($snapshot['manifest']['logicalRoot'], $packagedHead['logicalRoot']);
        self::$snapshots->deleteSnapshotOwned($this->userId, $snapshot['snapshotId']);
        self::$pdo->prepare('DELETE FROM data_placement_manifests WHERE dataset_id = ?')->execute([$formId]);
        self::$pdo->prepare('DELETE FROM data_dataset_high_water WHERE dataset_id = ?')->execute([$formId]);
    }

    public function testLegacyFormsStayUntouched(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$opLog->invalidatePlacementCache();
        self::$responses->createEncryptedResponse($formId, $this->makeEnvelope($formId), null, null);
        $db = self::$sqlite->getFormDatabase($formId);
        $tables = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name='replication_operations'")->fetchColumn();
        self::assertFalse($tables, 'no op tables on a legacy (unplaced) form');
        $cols = array_column($db->query('PRAGMA table_info(responses)')->fetchAll(\PDO::FETCH_ASSOC), 'name');
        self::assertNotContains('row_version', $cols, 'no schema change on a legacy form');
    }
}
