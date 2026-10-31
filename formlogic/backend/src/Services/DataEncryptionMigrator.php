<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\DataEncryption;
use FormLogic\Support\DataEncryptionException;
use PDO;

/**
 * Brings everything stored onto the current key: plain values from before there was a key, and
 * values under a key in DATA_ENCRYPTION_KEY_PREVIOUS. Safe to run again, and to run on a live
 * site: a value that changes meanwhile is left for the next run.
 *
 * MySQL can keep old row versions for a while after this, so a dump taken later is clean but the
 * server's own files may hold the old text until InnoDB has purged it.
 */
final class DataEncryptionMigrator
{
    public function __construct(
        private readonly PDO $mysql,
        private readonly string $hostedPath,
        private readonly ?string $trashPath = null,
    ) {
    }

    /** @return array{secrets: int, apps: int, records: int, snapshots: int, failed: list<string>} */
    public function run(DataEncryption $crypto): array
    {
        if (!$crypto->enabled()) {
            throw new DataEncryptionException('Set DATA_ENCRYPTION_KEY to a valid key first');
        }
        $failed = [];
        $secrets = $this->moveSecrets($crypto, 'users', 'mfa_secret', [MfaService::class, 'secretContext'], $failed)
            + $this->moveSecrets($crypto, 'webhooks', 'secret', [WebhookService::class, 'secretContext'], $failed);

        $apps = 0;
        $records = 0;
        foreach (glob($this->hostedPath . '/*.sqlite') ?: [] as $path) {
            try {
                $moved = HostedAppService::encryptDatabase($path, $crypto);
                $records += $moved;
                $apps += $moved > 0 ? 1 : 0;
            } catch (\Throwable $e) {
                $failed[] = 'hosted app database ' . basename($path) . ': ' . $e->getMessage();
            }
        }
        $snapshots = $this->moveSnapshots($crypto, $failed);
        if ($failed === []) {
            $crypto->recordMigrated($this->mysql);
        }
        return ['secrets' => $secrets, 'apps' => $apps, 'records' => $records, 'snapshots' => $snapshots, 'failed' => $failed];
    }

    /**
     * Recycle bin snapshots: seals the plain ones, and moves the sealed ones onto the current key.
     *
     * @param list<string> $failed
     */
    private function moveSnapshots(DataEncryption $crypto, array &$failed): int
    {
        $moved = 0;
        foreach ($this->trashPath === null ? [] : (glob($this->trashPath . '/*/*.zip') ?: []) as $path) {
            try {
                if (BackupEnvelope::isSealed($path)) {
                    $moved += BackupEnvelope::rewrap($path, $crypto) ? 1 : 0;
                    continue;
                }
                $staged = $path . '.sealing';
                BackupEnvelope::seal($path, $staged, ['server' => $crypto]);
                if (!rename($staged, $path)) {
                    @unlink($staged);
                    throw new DataEncryptionException('Could not replace the snapshot');
                }
                $moved++;
            } catch (\Throwable $e) {
                $failed[] = 'recycle bin snapshot ' . basename($path) . ': ' . $e->getMessage();
            }
        }
        return $moved;
    }

    /**
     * @param callable(string): string $context
     * @param list<string> $failed
     */
    private function moveSecrets(DataEncryption $crypto, string $table, string $column, callable $context, array &$failed): int
    {
        $update = $this->mysql->prepare("UPDATE {$table} SET {$column} = ? WHERE id = ? AND {$column} = ?");
        $moved = 0;
        foreach ($this->mysql->query("SELECT id, {$column} AS value FROM {$table} WHERE {$column} IS NOT NULL")->fetchAll(PDO::FETCH_ASSOC) as $row) {
            try {
                $next = $crypto->resealed((string) $row['value'], $context((string) $row['id']));
            } catch (DataEncryptionException $e) {
                $failed[] = "{$table}.{$column} of {$row['id']}: " . $e->getMessage();
                continue;
            }
            if ($next !== $row['value']) {
                $update->execute([$next, $row['id'], $row['value']]);
                $moved += $update->rowCount();
            }
        }
        return $moved;
    }
}
