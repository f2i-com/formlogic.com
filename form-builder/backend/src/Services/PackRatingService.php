<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

class PackRatingService
{
    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Upsert a user's rating for a pack.
     */
    public function ratePack(string $catalogId, string $userId, int $rating, ?string $review = null): array
    {
        if ($rating < 1 || $rating > 5) {
            throw new \RuntimeException('Rating must be between 1 and 5');
        }

        // Check pack exists
        $stmt = $this->mysql->prepare("SELECT id FROM pack_catalog WHERE id = :id AND status = 'published'");
        $stmt->execute(['id' => $catalogId]);
        if (!$stmt->fetch()) {
            throw new \RuntimeException('Pack not found');
        }

        // Atomic upsert to prevent race conditions with concurrent requests
        $ratingId = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO pack_ratings (id, catalog_id, user_id, rating, review)
            VALUES (:id, :catalog_id, :user_id, :rating, :review)
            ON DUPLICATE KEY UPDATE rating = VALUES(rating), review = VALUES(review), updated_at = CURRENT_TIMESTAMP
        ");
        $stmt->execute([
            'id' => $ratingId,
            'catalog_id' => $catalogId,
            'user_id' => $userId,
            'rating' => $rating,
            'review' => $review,
        ]);

        // Retrieve the actual ID (may differ if it was an update)
        $existing = $this->getUserRating($catalogId, $userId);
        return ['id' => $existing['id'] ?? $ratingId, 'rating' => $rating, 'review' => $review];
    }

    /**
     * Get paginated ratings for a pack.
     */
    public function getPackRatings(string $catalogId, int $page = 1, int $limit = 20): array
    {
        $offset = ($page - 1) * $limit;

        $countStmt = $this->mysql->prepare("SELECT COUNT(*) FROM pack_ratings WHERE catalog_id = :catalog_id");
        $countStmt->execute(['catalog_id' => $catalogId]);
        $total = (int) $countStmt->fetchColumn();

        $stmt = $this->mysql->prepare("
            SELECT pr.*, u.name AS user_name
            FROM pack_ratings pr
            JOIN users u ON u.id = pr.user_id
            WHERE pr.catalog_id = :catalog_id
            ORDER BY pr.created_at DESC
            LIMIT :limit OFFSET :offset
        ");
        $stmt->bindValue('catalog_id', $catalogId);
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue('offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll();

        $ratings = array_map(fn($row) => [
            'id' => $row['id'],
            'userId' => $row['user_id'],
            'userName' => $row['user_name'],
            'rating' => (int) $row['rating'],
            'review' => $row['review'],
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
        ], $rows);

        return [
            'ratings' => $ratings,
            'total' => $total,
            'page' => $page,
            'totalPages' => (int) ceil($total / max($limit, 1)),
        ];
    }

    /**
     * Get the current user's rating for a pack.
     */
    public function getUserRating(string $catalogId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT * FROM pack_ratings WHERE catalog_id = :catalog_id AND user_id = :user_id
        ");
        $stmt->execute(['catalog_id' => $catalogId, 'user_id' => $userId]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    /**
     * Delete a user's rating.
     */
    public function deleteRating(string $catalogId, string $userId): void
    {
        $stmt = $this->mysql->prepare("
            DELETE FROM pack_ratings WHERE catalog_id = :catalog_id AND user_id = :user_id
        ");
        $stmt->execute(['catalog_id' => $catalogId, 'user_id' => $userId]);
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
