<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\BlueprintRevisionConflictException;
use FormLogic\Services\BlueprintService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Blueprints Phase-6 groundwork (extensible-flows plan §11/§14): identity + separate
 * semantic/layout revisions, the §14.3 operation gateway (preconditions, atomicity,
 * inverse-op audit, operation-id idempotency), edge endpoint validation and tombstoned
 * deletes. Skipped without a test DB.
 */
class BlueprintTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static BlueprintService $blueprints;

    private string $userId = '';

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
        self::$blueprints = new BlueprintService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            self::markTestSkipped('No test database available');
        }
        $this->userId = 'bp-user-' . bin2hex(random_bytes(6));
    }

    private function op(string $type, array $extra = []): array
    {
        return array_merge(['operationId' => 'op-' . bin2hex(random_bytes(8)), 'type' => $type], $extra);
    }

    private function createBlueprint(): array
    {
        return self::$blueprints->createBlueprint($this->userId, ['name' => 'Onboarding']);
    }

    public function testCreateListGetDeleteAreOwnerScoped(): void
    {
        $blueprint = $this->createBlueprint();
        $this->assertSame(0, $blueprint['semanticRevision']);
        $this->assertSame('draft', $blueprint['status']);
        $this->assertCount(1, self::$blueprints->listBlueprints($this->userId));
        // Foreign owners see nothing — get and delete both report missing.
        $this->assertNull(self::$blueprints->getBlueprint('someone-else', $blueprint['id']));
        $this->assertFalse(self::$blueprints->deleteBlueprint('someone-else', $blueprint['id']));
        $this->assertTrue(self::$blueprints->deleteBlueprint($this->userId, $blueprint['id']));
        $this->assertNull(self::$blueprints->getBlueprint($this->userId, $blueprint['id']));
    }

    public function testSemanticCommitPlacesElementsAndEdgeWithRevisionBump(): void
    {
        $blueprint = $this->createBlueprint();
        $result = self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-form',
                    'elementType' => 'form',
                    'resourceRef' => ['kind' => 'form', 'id' => 'form-123'],
                    'properties' => ['title' => 'Customers'],
                    'layout' => ['x' => 100, 'y' => 80],
                ]),
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-flow',
                    'elementType' => 'flow',
                    'resourceRef' => ['kind' => 'flow', 'id' => 'flow-456'],
                    'properties' => ['title' => 'Onboarding flow'],
                ]),
                // §25 step 7: the form.submitted trigger as a concept edge form → flow.
                $this->op('blueprint.element.create', [
                    'targetId' => 'el-trigger',
                    'elementType' => 'edge',
                    'properties' => ['edgeType' => 'triggers', 'sourceId' => 'el-form', 'targetId' => 'el-flow', 'state' => 'concept'],
                ]),
            ],
        ]);
        $this->assertSame(1, $result['semanticRevision']);
        $this->assertSame(1, $result['layoutRevision'], 'the inline create layout counts as a layout change');

        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        $this->assertNotNull($snapshot);
        // Same-second creations order by id — assert the SET (slice-5 sibling lesson).
        $ids = array_column($snapshot['elements'], 'id');
        sort($ids);
        $this->assertSame(['el-flow', 'el-form', 'el-trigger'], $ids);
        $byId = array_column($snapshot['elements'], null, 'id');
        $form = $byId['el-form'];
        // assertEquals: MySQL JSON columns normalize (and reorder) object keys.
        $this->assertEquals(['x' => 100, 'y' => 80], $form['layout']);
        $this->assertEquals(['kind' => 'form', 'id' => 'form-123'], $form['resourceRef']);
    }

    public function testStaleSemanticRevisionConflictsAndMutatesNothing(): void
    {
        $blueprint = $this->createBlueprint();
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [$this->op('blueprint.element.create', ['targetId' => 'a', 'elementType' => 'note'])],
        ]);
        try {
            self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
                'baseSemanticRevision' => 0, // stale — current is 1
                'operations' => [$this->op('blueprint.element.create', ['targetId' => 'b', 'elementType' => 'note'])],
            ]);
            $this->fail('expected a revision conflict');
        } catch (BlueprintRevisionConflictException $e) {
            $this->assertSame(1, $e->currentRevision);
        }
        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        $this->assertCount(1, $snapshot['elements'], 'the refused batch must not have written anything');
    }

    public function testLayoutOnlyBatchesSkipTheSemanticPrecondition(): void
    {
        $blueprint = $this->createBlueprint();
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [$this->op('blueprint.element.create', ['targetId' => 'a', 'elementType' => 'group'])],
        ]);
        // No baseSemanticRevision at all: a drag never conflicts with semantic edits (§11.2).
        $result = self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'operations' => [
                $this->op('blueprint.layout.set', ['targetId' => 'a', 'layout' => ['x' => 5, 'y' => 9]]),
                $this->op('blueprint.viewport.set', ['viewport' => ['x' => 0, 'y' => 0, 'zoom' => 1.5]]),
            ],
        ]);
        $this->assertSame(1, $result['semanticRevision'], 'layout batches never bump the semantic revision');
        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        $this->assertEquals(['x' => 5, 'y' => 9], $snapshot['elements'][0]['layout']);
        $this->assertSame(1.5, $snapshot['viewport']['zoom']);
    }

    public function testStructuralRefusalsEdgeEndpointsAndReferencedDeletes(): void
    {
        $blueprint = $this->createBlueprint();
        // An edge to a missing endpoint refuses the WHOLE batch.
        try {
            self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
                'baseSemanticRevision' => 0,
                'operations' => [
                    $this->op('blueprint.element.create', ['targetId' => 'n1', 'elementType' => 'form']),
                    $this->op('blueprint.element.create', [
                        'targetId' => 'e1',
                        'elementType' => 'edge',
                        'properties' => ['edgeType' => 'triggers', 'sourceId' => 'n1', 'targetId' => 'ghost'],
                    ]),
                ],
            ]);
            $this->fail('expected an endpoint refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('targetId must reference', $e->getMessage());
        }
        $this->assertCount(0, self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements']);

        // Place a valid triangle, then refuse deleting a node an edge still references.
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [
                $this->op('blueprint.element.create', ['targetId' => 'n1', 'elementType' => 'form']),
                $this->op('blueprint.element.create', ['targetId' => 'n2', 'elementType' => 'flow']),
                $this->op('blueprint.element.create', [
                    'targetId' => 'e1',
                    'elementType' => 'edge',
                    'properties' => ['edgeType' => 'triggers', 'sourceId' => 'n1', 'targetId' => 'n2'],
                ]),
            ],
        ]);
        try {
            self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
                'baseSemanticRevision' => 1,
                'operations' => [$this->op('blueprint.element.delete', ['targetId' => 'n1'])],
            ]);
            $this->fail('expected a referenced-delete refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('still referenced by edge', $e->getMessage());
        }
        // Edge first, then the node — tombstoned, not physically deleted.
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 1,
            'operations' => [
                $this->op('blueprint.element.delete', ['targetId' => 'e1']),
                $this->op('blueprint.element.delete', ['targetId' => 'n1']),
            ],
        ]);
        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        $this->assertSame(['n2'], array_column($snapshot['elements'], 'id'));
        $tombstones = self::$pdo->prepare(
            'SELECT COUNT(*) FROM blueprint_elements WHERE blueprint_id = ? AND deleted_at IS NOT NULL'
        );
        $tombstones->execute([$blueprint['id']]);
        $this->assertSame(2, (int) $tombstones->fetchColumn());
    }

    public function testValidateIsACommitFaithfulDryRunThatWritesNothing(): void
    {
        $blueprint = $this->createBlueprint();
        $batch = [
            'baseSemanticRevision' => 0,
            'operations' => [$this->op('blueprint.element.create', ['targetId' => 'n1', 'elementType' => 'form', 'layout' => ['x' => 1, 'y' => 2]])],
        ];
        $preview = self::$blueprints->validateOperations($this->userId, $blueprint['id'], $batch);
        $this->assertTrue($preview['valid']);
        $this->assertSame(1, $preview['semanticRevision'], 'previews the revision the commit WOULD produce');
        $this->assertSame(1, $preview['layoutRevision']);
        // Nothing was written — no elements, no revision bump, no operation rows.
        $snapshot = self::$blueprints->getBlueprint($this->userId, $blueprint['id']);
        $this->assertCount(0, $snapshot['elements']);
        $this->assertSame(0, $snapshot['semanticRevision']);
        $ops = self::$pdo->prepare('SELECT COUNT(*) FROM blueprint_operations WHERE blueprint_id = ?');
        $ops->execute([$blueprint['id']]);
        $this->assertSame(0, (int) $ops->fetchColumn());
        // The SAME batch then commits cleanly, and validate rejects exactly like commit.
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], $batch);
        try {
            self::$blueprints->validateOperations($this->userId, $blueprint['id'], $batch);
            $this->fail('expected the dry-run to conflict like commit would');
        } catch (BlueprintRevisionConflictException $e) {
            $this->assertSame(1, $e->currentRevision);
        }
    }

    public function testChangeSetsProposeApproveDiscardWithConflicts(): void
    {
        $blueprint = $this->createBlueprint();
        // Propose: validates and PARKS — the diagram itself is untouched.
        $proposal = self::$blueprints->proposeChangeSet($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'origin' => 'copilot',
            'summary' => 'Add a customers entity',
            'operations' => [$this->op('blueprint.element.create', ['targetId' => 'g1', 'elementType' => 'form', 'properties' => ['title' => 'Customers']])],
        ]);
        $this->assertSame('proposed', $proposal['status']);
        $this->assertCount(0, self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements']);
        $listed = self::$blueprints->listProposedChangeSets($this->userId, $blueprint['id']);
        $this->assertCount(1, $listed);
        $this->assertSame('Add a customers entity', $listed[0]['summary']);

        // Approve = the ordinary gateway commit; the change set resolves.
        $result = self::$blueprints->approveChangeSet($this->userId, $blueprint['id'], $proposal['changeSetId']);
        $this->assertSame(1, $result['semanticRevision']);
        $this->assertCount(1, self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements']);
        $this->assertCount(0, self::$blueprints->listProposedChangeSets($this->userId, $blueprint['id']));
        // Resolved change sets can't approve twice.
        try {
            self::$blueprints->approveChangeSet($this->userId, $blueprint['id'], $proposal['changeSetId']);
            $this->fail('expected an already-resolved refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('already-resolved', $e->getMessage());
        }

        // A proposal parked against a revision that then MOVES conflicts at approval.
        $stale = self::$blueprints->proposeChangeSet($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 1,
            'summary' => 'Stale proposal',
            'operations' => [$this->op('blueprint.element.create', ['targetId' => 'g2', 'elementType' => 'note'])],
        ]);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 1,
            'operations' => [$this->op('blueprint.element.create', ['targetId' => 'user-edit', 'elementType' => 'note'])],
        ]);
        try {
            self::$blueprints->approveChangeSet($this->userId, $blueprint['id'], $stale['changeSetId']);
            $this->fail('expected a revision conflict at approval');
        } catch (BlueprintRevisionConflictException $e) {
            $this->assertSame(2, $e->currentRevision);
        }
        // Still proposed (approval failed) — discard resolves it.
        $this->assertCount(1, self::$blueprints->listProposedChangeSets($this->userId, $blueprint['id']));
        self::$blueprints->discardChangeSet($this->userId, $blueprint['id'], $stale['changeSetId']);
        $this->assertCount(0, self::$blueprints->listProposedChangeSets($this->userId, $blueprint['id']));
    }

    public function testUndoAppliesStoredInversesAsNewChangeSets(): void
    {
        $blueprint = $this->createBlueprint();
        try {
            self::$blueprints->undoLastChangeSet($this->userId, $blueprint['id']);
            $this->fail('expected nothing-to-undo');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Nothing to undo', $e->getMessage());
        }

        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [$this->op('blueprint.element.create', ['targetId' => 'n1', 'elementType' => 'note', 'properties' => ['text' => 'hello']])],
        ]);
        // Undo the create → the element tombstones (the stored inverse is a delete)…
        $undo = self::$blueprints->undoLastChangeSet($this->userId, $blueprint['id']);
        $this->assertSame(2, $undo['semanticRevision'], 'undo is a NEW forward change set, never a rewind');
        $this->assertCount(0, self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements']);
        // …and undoing again REDOES it (the undo batch has inverses of its own).
        $redo = self::$blueprints->undoLastChangeSet($this->userId, $blueprint['id']);
        $this->assertSame(3, $redo['semanticRevision']);
        $elements = self::$blueprints->getBlueprint($this->userId, $blueprint['id'])['elements'];
        $this->assertCount(1, $elements);
        $this->assertSame('hello', $elements[0]['properties']['text'] ?? null);
    }

    public function testOperationLogRecordsInversesAndRefusesReplays(): void
    {
        $blueprint = $this->createBlueprint();
        $create = $this->op('blueprint.element.create', ['targetId' => 'n1', 'elementType' => 'note', 'properties' => ['text' => 'v1']]);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 0,
            'operations' => [$create],
        ]);
        self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
            'baseSemanticRevision' => 1,
            'operations' => [$this->op('blueprint.element.update', ['targetId' => 'n1', 'properties' => ['text' => 'v2']])],
        ]);

        $ops = self::$pdo->prepare(
            'SELECT op_type, inverse_json FROM blueprint_operations WHERE blueprint_id = ? ORDER BY id'
        );
        $ops->execute([$blueprint['id']]);
        $rows = $ops->fetchAll();
        $this->assertCount(2, $rows);
        $createInverse = json_decode((string) $rows[0]['inverse_json'], true);
        $this->assertSame('blueprint.element.delete', $createInverse['type']);
        $updateInverse = json_decode((string) $rows[1]['inverse_json'], true);
        $this->assertSame('blueprint.element.update', $updateInverse['type']);
        $this->assertSame(['text' => 'v1'], $updateInverse['properties'], 'the inverse restores the PRE-apply properties');

        // Replaying an already-committed operationId is refused, not double-applied.
        try {
            self::$blueprints->commitOperations($this->userId, $blueprint['id'], [
                'baseSemanticRevision' => 2,
                'operations' => [array_merge($create, ['targetId' => 'n9'])],
            ]);
            $this->fail('expected a duplicate-operation refusal');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('already committed', $e->getMessage());
        }
    }
}
