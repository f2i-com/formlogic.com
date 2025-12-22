<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use PDO;

class ResponseService
{
    private PDO $mysql;
    private SQLiteConnection $sqlite;

    public function __construct(MySQLConnection $mysql, SQLiteConnection $sqlite)
    {
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
    }

    /**
     * Get all responses for a form
     */
    public function getFormResponses(string $formId, array $options = []): array
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return [];
        }

        $db = $this->sqlite->getFormDatabase($formId);

        $sql = "SELECT * FROM responses";
        $params = [];
        $conditions = [];

        // Status filter
        if (!empty($options['status'])) {
            $conditions[] = "status = :status";
            $params['status'] = $options['status'];
        }

        // Date range filter
        if (!empty($options['from'])) {
            $conditions[] = "submitted_at >= :from";
            $params['from'] = $options['from'];
        }

        if (!empty($options['to'])) {
            $conditions[] = "submitted_at <= :to";
            $params['to'] = $options['to'];
        }

        if (!empty($conditions)) {
            $sql .= " WHERE " . implode(' AND ', $conditions);
        }

        $sql .= " ORDER BY submitted_at DESC";

        // Pagination
        $limit = $options['limit'] ?? 100;
        $offset = $options['offset'] ?? 0;
        $sql .= " LIMIT :limit OFFSET :offset";

        $stmt = $db->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->bindValue('limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();

        $responses = [];
        while ($row = $stmt->fetch()) {
            $responses[] = $this->formatResponse($row);
        }

        return $responses;
    }

    /**
     * Get a single response by ID
     */
    public function getResponse(string $formId, string $responseId): ?array
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return null;
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $stmt = $db->prepare("SELECT * FROM responses WHERE id = :id");
        $stmt->execute(['id' => $responseId]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return $this->formatResponse($row);
    }

    /**
     * Create a new response (form submission)
     */
    public function createResponse(string $formId, array $data): array
    {
        $db = $this->sqlite->getFormDatabase($formId);
        $id = $data['id'] ?? $this->generateUuid();
        $now = date('Y-m-d H:i:s');

        // Insert into SQLite
        $stmt = $db->prepare("
            INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at)
            VALUES (:id, :answers, :metadata, :status, :submitted_at, :updated_at)
        ");

        $stmt->execute([
            'id' => $id,
            'answers' => json_encode($data['answers'] ?? []),
            'metadata' => json_encode([
                'userAgent' => $data['userAgent'] ?? null,
                'referrer' => $data['referrer'] ?? null,
                'completionTime' => $data['completionTime'] ?? null,
                'ipAddress' => $data['ipAddress'] ?? null,
            ]),
            'status' => $data['status'] ?? 'submitted',
            'submitted_at' => $now,
            'updated_at' => $now,
        ]);

        // Also insert metadata into MySQL for global querying
        $mysqlStmt = $this->mysql->prepare("
            INSERT INTO response_metadata (id, form_id, status, submitted_at, ip_address, user_agent, completion_time)
            VALUES (:id, :form_id, :status, :submitted_at, :ip_address, :user_agent, :completion_time)
        ");

        $mysqlStmt->execute([
            'id' => $id,
            'form_id' => $formId,
            'status' => $data['status'] ?? 'submitted',
            'submitted_at' => $now,
            'ip_address' => $data['ipAddress'] ?? null,
            'user_agent' => $data['userAgent'] ?? null,
            'completion_time' => $data['completionTime'] ?? null,
        ]);

        // Update analytics
        $this->updateAnalytics($formId, 'completion');

        return $this->getResponse($formId, $id);
    }

    /**
     * Update a response
     */
    public function updateResponse(string $formId, string $responseId, array $data): ?array
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return null;
        }

        $db = $this->sqlite->getFormDatabase($formId);

        $updates = [];
        $params = ['id' => $responseId];

        if (isset($data['answers'])) {
            $updates[] = "answers = :answers";
            $params['answers'] = json_encode($data['answers']);
        }

        if (isset($data['status'])) {
            $updates[] = "status = :status";
            $params['status'] = $data['status'];

            // Update MySQL metadata too
            $mysqlStmt = $this->mysql->prepare("
                UPDATE response_metadata SET status = :status WHERE id = :id
            ");
            $mysqlStmt->execute(['status' => $data['status'], 'id' => $responseId]);
        }

        if (empty($updates)) {
            return $this->getResponse($formId, $responseId);
        }

        $updates[] = "updated_at = :updated_at";
        $params['updated_at'] = date('Y-m-d H:i:s');

        $sql = "UPDATE responses SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $db->prepare($sql);
        $stmt->execute($params);

        return $this->getResponse($formId, $responseId);
    }

    /**
     * Delete a response
     */
    public function deleteResponse(string $formId, string $responseId): bool
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return false;
        }

        $db = $this->sqlite->getFormDatabase($formId);

        // Delete from SQLite
        $stmt = $db->prepare("DELETE FROM responses WHERE id = :id");
        $stmt->execute(['id' => $responseId]);
        $deleted = $stmt->rowCount() > 0;

        // Delete from MySQL metadata
        if ($deleted) {
            $mysqlStmt = $this->mysql->prepare("DELETE FROM response_metadata WHERE id = :id");
            $mysqlStmt->execute(['id' => $responseId]);
        }

        return $deleted;
    }

    /**
     * Get response count for a form
     */
    public function getResponseCount(string $formId): int
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return 0;
        }

        $db = $this->sqlite->getFormDatabase($formId);
        $stmt = $db->query("SELECT COUNT(*) as count FROM responses");
        $row = $stmt->fetch();

        return (int)($row['count'] ?? 0);
    }

    /**
     * Get form analytics
     */
    public function getFormAnalytics(string $formId, array $options = []): array
    {
        // Default analytics response
        $defaultAnalytics = [
            'totalResponses' => 0,
            'totalViews' => 0,
            'totalStarts' => 0,
            'completionRate' => 0,
            'averageCompletionTime' => 0,
            'responsesByDate' => [],
        ];

        try {
            // Get response stats from SQLite
            $responseCount = $this->getResponseCount($formId);

            if (!$this->sqlite->formDatabaseExists($formId)) {
                // Try to get stats from MySQL only
                $mysqlStmt = $this->mysql->prepare("
                    SELECT
                        COALESCE(SUM(views), 0) as total_views,
                        COALESCE(SUM(starts), 0) as total_starts,
                        COALESCE(SUM(completions), 0) as total_completions
                    FROM form_analytics
                    WHERE form_id = :form_id
                ");
                $mysqlStmt->execute(['form_id' => $formId]);
                $aggregates = $mysqlStmt->fetch() ?: [];

                return [
                    'totalResponses' => 0,
                    'totalViews' => (int)($aggregates['total_views'] ?? 0),
                    'totalStarts' => (int)($aggregates['total_starts'] ?? 0),
                    'completionRate' => 0,
                    'averageCompletionTime' => 0,
                    'responsesByDate' => [],
                ];
            }

            $db = $this->sqlite->getFormDatabase($formId);

            // Average completion time - use simpler query without json_extract for compatibility
            $avgTime = 0;
            try {
                $responses = $this->getFormResponses($formId, ['limit' => 1000]);
                $totalTime = 0;
                $timeCount = 0;
                foreach ($responses as $r) {
                    if (!empty($r['metadata']['completionTime'])) {
                        $totalTime += (float)$r['metadata']['completionTime'];
                        $timeCount++;
                    }
                }
                $avgTime = $timeCount > 0 ? $totalTime / $timeCount : 0;
            } catch (\Exception $e) {
                // Ignore - avgTime will remain 0
            }

            // Responses by date (last 30 days)
            $responsesByDate = [];
            try {
                $stmt = $db->query("
                    SELECT date(submitted_at) as date, COUNT(*) as count
                    FROM responses
                    WHERE submitted_at >= date('now', '-30 days')
                    GROUP BY date(submitted_at)
                    ORDER BY date ASC
                ");

                while ($row = $stmt->fetch()) {
                    $responsesByDate[] = [
                        'date' => $row['date'],
                        'count' => (int)$row['count'],
                    ];
                }
            } catch (\Exception $e) {
                // Ignore - responsesByDate will remain empty
            }

            // Get aggregate stats from MySQL
            $mysqlStmt = $this->mysql->prepare("
                SELECT
                    COALESCE(SUM(views), 0) as total_views,
                    COALESCE(SUM(starts), 0) as total_starts,
                    COALESCE(SUM(completions), 0) as total_completions
                FROM form_analytics
                WHERE form_id = :form_id
            ");
            $mysqlStmt->execute(['form_id' => $formId]);
            $aggregates = $mysqlStmt->fetch() ?: [];

            $totalStarts = (int)($aggregates['total_starts'] ?? $responseCount);
            $totalCompletions = (int)($aggregates['total_completions'] ?? $responseCount);
            $completionRate = $totalStarts > 0 ? ($totalCompletions / $totalStarts) * 100 : 0;

            return [
                'totalResponses' => $responseCount,
                'totalViews' => (int)($aggregates['total_views'] ?? 0),
                'totalStarts' => $totalStarts,
                'completionRate' => round($completionRate, 2),
                'averageCompletionTime' => round((float)$avgTime, 2),
                'responsesByDate' => $responsesByDate,
            ];
        } catch (\Exception $e) {
            // Log the error but return default analytics
            error_log('Analytics error for form ' . $formId . ': ' . $e->getMessage());
            return $defaultAnalytics;
        }
    }

    /**
     * Export responses to CSV format
     */
    public function exportResponses(string $formId, array $fields): string
    {
        $responses = $this->getFormResponses($formId);

        if (empty($responses)) {
            return '';
        }

        $output = fopen('php://temp', 'r+');

        // Header row
        $headers = ['Response ID', 'Submitted At', 'Status'];
        foreach ($fields as $field) {
            $headers[] = $field['label'] ?? $field['id'];
        }
        fputcsv($output, $headers);

        // Data rows
        foreach ($responses as $response) {
            $row = [
                $response['id'],
                $response['submittedAt'],
                $response['status'],
            ];

            foreach ($fields as $field) {
                $value = $response['answers'][$field['id']] ?? '';
                if (is_array($value)) {
                    $value = implode(', ', $value);
                }
                $row[] = $value;
            }

            fputcsv($output, $row);
        }

        rewind($output);
        $csv = stream_get_contents($output);
        fclose($output);

        return $csv;
    }

    /**
     * Update form analytics
     */
    private function updateAnalytics(string $formId, string $type): void
    {
        $today = date('Y-m-d');

        // Try to update existing record
        $column = match ($type) {
            'view' => 'views',
            'start' => 'starts',
            'completion' => 'completions',
            default => null,
        };

        if (!$column) {
            return;
        }

        $stmt = $this->mysql->prepare("
            INSERT INTO form_analytics (id, form_id, date, $column)
            VALUES (:id, :form_id, :date, 1)
            ON DUPLICATE KEY UPDATE $column = $column + 1
        ");

        $stmt->execute([
            'id' => $this->generateUuid(),
            'form_id' => $formId,
            'date' => $today,
        ]);
    }

    /**
     * Format a response row for output
     */
    private function formatResponse(array $row): array
    {
        $metadata = json_decode($row['metadata'] ?? '{}', true);

        return [
            'id' => $row['id'],
            'answers' => json_decode($row['answers'], true),
            'status' => $row['status'],
            'submittedAt' => $row['submitted_at'],
            'updatedAt' => $row['updated_at'],
            'metadata' => $metadata,
        ];
    }

    /**
     * Generate a UUID v4
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
