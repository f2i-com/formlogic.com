<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use PDO;

class AuditService
{
    private const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

    private PDO $mysql;
    private LoggerInterface $logger;
    private string $hmacKey;

    public function __construct(MySQLConnection $mysql, ?LoggerInterface $logger = null, ?string $hmacKey = null)
    {
        $this->mysql = $mysql->getConnection();
        $this->logger = $logger ?? new NullLogger();
        if ($hmacKey === null || $hmacKey === '') {
            $appEnv = getenv('APP_ENV') ?: ($_ENV['APP_ENV'] ?? 'development');
            if ($appEnv === 'production') {
                throw new \RuntimeException('AUDIT_HMAC_KEY must be configured in production');
            }
            $this->hmacKey = 'formlogic-audit-dev-key';
        } else {
            $this->hmacKey = $hmacKey;
        }
    }

    /**
     * Log an audit event with hash chaining for immutable audit trail.
     * Wrapped in try/catch so audit failures never break main operations.
     */
    public function log(
        string $action,
        string $resourceType,
        ?string $resourceId,
        ?string $userId,
        ?string $ipAddress,
        array $details = []
    ): void {
        $gotLock = false;
        try {
            $alreadyInTransaction = $this->mysql->inTransaction();
            if (!$alreadyInTransaction) {
                $this->mysql->beginTransaction();
            }

            // Serialize chain extension across connections so concurrent writers
            // (especially on an empty/genesis table, where there's no prior row for
            // FOR UPDATE to lock) can't both chain from genesis and fork the chain.
            try {
                $gotLock = ((int) $this->mysql->query("SELECT GET_LOCK('formlogic_audit_chain', 5)")->fetchColumn()) === 1;
            } catch (\Exception $lockErr) {
                $gotLock = false; // best-effort; never block auditing on lock errors
            }

            // Get next sequence number via auto-increment table
            $this->mysql->exec("INSERT INTO audit_sequence VALUES ()");
            $sequenceNumber = (int) $this->mysql->lastInsertId();

            // Clean up the sequence row to prevent unbounded growth
            $cleanupStmt = $this->mysql->prepare("DELETE FROM audit_sequence WHERE id < :seq");
            $cleanupStmt->execute(['seq' => $sequenceNumber]);

            // Fetch the most recent entry's integrity hash with lock to prevent chain races
            $stmt = $this->mysql->query("
                SELECT integrity_hash FROM audit_log
                WHERE integrity_hash IS NOT NULL
                ORDER BY sequence_number DESC LIMIT 1
                FOR UPDATE
            ");
            $prevRow = $stmt->fetch(PDO::FETCH_ASSOC);
            $previousHash = ($prevRow && $prevRow['integrity_hash'] !== null)
                ? $prevRow['integrity_hash']
                : self::GENESIS_HASH;

            // Use the same detailsJson for both hashing and storage
            $detailsJson = !empty($details) ? json_encode($details) : '';
            $detailsForStorage = $detailsJson !== '' ? $detailsJson : null;
            $ipForHash = $ipAddress ?? '';
            $timestamp = date('Y-m-d H:i:s');

            // Compute integrity hash: chain previous hash with all stored fields
            $hashInput = $previousHash . '|' . $action . '|' . $resourceType . '|'
                . ($resourceId ?? '') . '|' . ($userId ?? '') . '|'
                . $detailsJson . '|' . $ipForHash . '|' . $timestamp;
            $integrityHash = hash_hmac('sha256', $hashInput, $this->hmacKey);

            $stmt = $this->mysql->prepare("
                INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address, integrity_hash, sequence_number, created_at)
                VALUES (:id, :user_id, :action, :resource_type, :resource_id, :details, :ip_address, :integrity_hash, :sequence_number, :created_at)
            ");
            $stmt->execute([
                'id' => $this->generateUuid(),
                'user_id' => $userId,
                'action' => $action,
                'resource_type' => $resourceType,
                'resource_id' => $resourceId,
                'details' => $detailsForStorage,
                'ip_address' => $ipAddress,
                'integrity_hash' => $integrityHash,
                'sequence_number' => $sequenceNumber,
                'created_at' => $timestamp,
            ]);

            if (!$alreadyInTransaction) {
                $this->mysql->commit();
            }

            if ($gotLock) {
                $this->mysql->query("SELECT RELEASE_LOCK('formlogic_audit_chain')");
                $gotLock = false;
            }
        } catch (\Exception $e) {
            if (!$alreadyInTransaction && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            if ($gotLock) {
                try {
                    $this->mysql->query("SELECT RELEASE_LOCK('formlogic_audit_chain')");
                } catch (\Exception $relErr) {
                    // ignore — the lock auto-releases when the connection closes
                }
            }
            // Never let audit failures break the main operation
            $this->logger->warning('Audit log failed', [
                'action' => $action,
                'exception' => $e->getMessage(),
            ]);
        }
    }

    /**
     * Verify the integrity of the audit chain.
     * Recomputes each hash and compares to the stored value.
     * Skips pre-migration entries (hash=NULL).
     * Iterates in bounded keyset-paginated batches so memory stays flat even for
     * a very large append-only log (the previous query buffered the entire table).
     *
     * @return array{intact: bool, verified: int, total: int, brokenAt: array|null}
     */
    public function verifyChain(): array
    {
        // Count verifiable (post-migration) entries up front (before opening the
        // paginated cursor, so no result set is left open on the shared connection).
        $countStmt = $this->mysql->query("SELECT COUNT(*) FROM audit_log WHERE integrity_hash IS NOT NULL");
        $total = (int) $countStmt->fetchColumn();

        $verified = 0;
        $previousHash = self::GENESIS_HASH;
        $lastSeq = -1;            // sequence_number is monotonic; paginate by it
        $batchSize = 1000;

        $stmt = $this->mysql->prepare("
            SELECT id, user_id, action, resource_type, resource_id, details, ip_address, integrity_hash, sequence_number, created_at
            FROM audit_log
            WHERE integrity_hash IS NOT NULL AND sequence_number > :last
            ORDER BY sequence_number ASC
            LIMIT :batch
        ");

        do {
            $stmt->bindValue(':last', $lastSeq, PDO::PARAM_INT);
            $stmt->bindValue(':batch', $batchSize, PDO::PARAM_INT);
            $stmt->execute();
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            foreach ($rows as $entry) {
                $detailsJson = $entry['details'] ?? '';
                $ipForHash = $entry['ip_address'] ?? '';
                $hashInput = $previousHash . '|' . $entry['action'] . '|' . $entry['resource_type'] . '|'
                    . ($entry['resource_id'] ?? '') . '|' . ($entry['user_id'] ?? '') . '|'
                    . $detailsJson . '|' . $ipForHash . '|' . $entry['created_at'];
                $expectedHash = hash_hmac('sha256', $hashInput, $this->hmacKey);

                if ($expectedHash !== $entry['integrity_hash']) {
                    return [
                        'intact' => false,
                        'verified' => $verified,
                        'total' => $total,
                        'brokenAt' => [
                            'id' => $entry['id'],
                            'sequenceNumber' => (int) $entry['sequence_number'],
                            'action' => $entry['action'],
                            'createdAt' => $entry['created_at'],
                        ],
                    ];
                }

                $previousHash = $entry['integrity_hash'];
                $lastSeq = (int) $entry['sequence_number'];
                $verified++;
            }
        } while (count($rows) === $batchSize);

        return [
            'intact' => true,
            'verified' => $verified,
            'total' => $total,
            'brokenAt' => null,
        ];
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
