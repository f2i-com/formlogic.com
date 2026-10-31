<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Models\User;
use PDO;

/**
 * What an account's owner is told about administrators in it. The audit log has always recorded
 * this, for the administrators: this is the same record, for the person it is about.
 */
class AdminSupportActivity
{
    private const SAY = [
        'admin.support_opened' => 'An administrator opened your account',
        'admin.on_behalf' => 'An administrator changed something in your account',
        'admin.password_reset' => 'An administrator set a temporary password on your account',
        'admin.password_reset_link' => 'An administrator sent you a password reset link',
        'admin.email_change' => 'An administrator changed your sign-in email',
        'admin.mfa_reset' => 'An administrator turned off your two-factor authentication',
    ];

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql, private ?AuditService $audit = null, private ?EmailService $email = null)
    {
        $this->mysql = $mysql->getConnection();
    }

    /** Called for each request an administrator makes as this owner: says so, once a day. */
    public function opened(User $owner, string $adminId, ?string $ip): void
    {
        $seen = $this->mysql->prepare(
            "SELECT 1 FROM audit_log
             WHERE action = 'admin.support_opened' AND resource_type = 'admin' AND resource_id = :owner
               AND user_id = :admin AND created_at > NOW() - INTERVAL 24 HOUR LIMIT 1"
        );
        $seen->execute(['owner' => $owner->id, 'admin' => $adminId]);
        if ($seen->fetchColumn() !== false) {
            return;
        }
        // The record comes first, as it does for everything an administrator does: mail fails.
        $this->audit?->log('admin.support_opened', 'admin', $owner->id, $adminId, $ip, []);
        $this->email?->send(
            $owner->email,
            'An administrator opened your account',
            '<p>A site administrator opened your account for support. They can see how your apps and forms are built, not the answers people submitted.</p>'
            . '<p>If you did not ask for this, contact support. You can see what was done in Settings, under Security.</p>'
        );
    }

    /** @return list<array{at: string, what: string}> newest first */
    public function recentFor(string $ownerId, int $limit = 30): array
    {
        // Ordinary edits can't push a password reset off the list, however many there are.
        $rows = [];
        $actions = array_keys(self::SAY);
        foreach ([['admin.on_behalf'], array_values(array_diff($actions, ['admin.on_behalf']))] as $group) {
            $stmt = $this->mysql->prepare(
                "SELECT action, UNIX_TIMESTAMP(created_at) AS at FROM audit_log
                 WHERE resource_type = 'admin' AND resource_id = ?
                   AND action IN (" . implode(',', array_fill(0, count($group), '?')) . ")
                 ORDER BY created_at DESC LIMIT " . max(1, min($limit, 100))
            );
            $stmt->execute(array_merge([$ownerId], $group));
            $rows = array_merge($rows, $stmt->fetchAll(PDO::FETCH_ASSOC));
        }
        usort($rows, static fn (array $a, array $b): int => (int) $b['at'] <=> (int) $a['at']);
        return array_map(
            static fn (array $row): array => ['at' => gmdate('c', (int) $row['at']), 'what' => self::SAY[$row['action']]],
            $rows
        );
    }
}
