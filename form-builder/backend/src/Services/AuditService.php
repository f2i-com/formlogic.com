<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use PDO;

class AuditService
{
    private PDO $mysql;
    private LoggerInterface $logger;

    public function __construct(MySQLConnection $mysql, ?LoggerInterface $logger = null)
    {
        $this->mysql = $mysql->getConnection();
        $this->logger = $logger ?? new NullLogger();
    }

    /**
     * Log an audit event. Wrapped in try/catch so audit failures never break main operations.
     */
    public function log(
        string $action,
        string $resourceType,
        ?string $resourceId,
        ?string $userId,
        ?string $ipAddress,
        array $details = []
    ): void {
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address)
                VALUES (:id, :user_id, :action, :resource_type, :resource_id, :details, :ip_address)
            ");
            $stmt->execute([
                'id' => $this->generateUuid(),
                'user_id' => $userId,
                'action' => $action,
                'resource_type' => $resourceType,
                'resource_id' => $resourceId,
                'details' => !empty($details) ? json_encode($details) : null,
                'ip_address' => $ipAddress,
            ]);
        } catch (\Exception $e) {
            // Never let audit failures break the main operation
            $this->logger->warning('Audit log failed', [
                'action' => $action,
                'exception' => $e->getMessage(),
            ]);
        }
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
