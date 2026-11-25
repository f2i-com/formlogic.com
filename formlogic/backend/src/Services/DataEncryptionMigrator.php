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
        private readonly ?NativeAppService $nativeApps = null,
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
            + $this->moveSecrets($crypto, 'webhooks', 'secret', [WebhookService::class, 'secretContext'], $failed)
            // The SoftN directory's edit keys, which only this site holds (SoftnDirectoryService).
            + $this->moveSecrets($crypto, 'softn_directory_publications', 'edit_key', [SoftnDirectoryService::class, 'editKeyContext'], $failed)
            // Per-app plugin secrets (private/plugin-*.json) and un-migrated legacy Twilio verify.json files.
            + $this->moveNativeAppSecrets($crypto, $failed);

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

    /**
     * Reseal per-app plugin secrets (`private/plugin-*.json`) and legacy `private/verify.json`
     * under each app's private file lock so key rotation and initial encryption cover them too.
     *
     * @param list<string> $failed
     */
    private function moveNativeAppSecrets(DataEncryption $crypto, array &$failed): int
    {
        if ($this->nativeApps === null) {
            return 0;
        }
        try {
            $appIds = $this->mysql->query('SELECT id FROM apps')->fetchAll(PDO::FETCH_COLUMN);
        } catch (\Throwable $e) {
            $failed[] = 'apps list for plugin secrets: ' . $e->getMessage();
            return 0;
        }
        $moved = 0;
        foreach ($appIds as $rawId) {
            $appId = (string) $rawId;
            if ($appId === '') {
                continue;
            }
            foreach ($this->nativeApps->privateFileNames($appId, 'plugin-') as $fileName) {
                if (preg_match('/^plugin-[0-9a-f]{24}\.json$/D', $fileName) !== 1) {
                    continue;
                }
                try {
                    $moved += $this->nativeApps->withPrivateFileLock($appId, $fileName, function () use ($appId, $fileName, $crypto): int {
                        $text = $this->nativeApps->readPrivateFile($appId, $fileName);
                        if ($text === null) {
                            return 0;
                        }
                        $kept = json_decode($text, true);
                        if (!is_array($kept) || !is_string($kept['plugin'] ?? null) || $kept['plugin'] === '' || !is_array($kept['secrets'] ?? null)) {
                            return 0;
                        }
                        $pluginId = $kept['plugin'];
                        if (PluginAppSettings::fileName($pluginId) !== $fileName) {
                            return 0;
                        }
                        $count = 0;
                        $changed = false;
                        foreach ($kept['secrets'] as $fieldKey => $entry) {
                            if (!is_array($entry) || !is_string($entry['value'] ?? null)) {
                                continue;
                            }
                            $ctx = PluginAppSettings::secretContext($pluginId, $appId, (string) $fieldKey);
                            $wasSealed = ($entry['sealed'] ?? false) === true;
                            $next = $wasSealed
                                ? $crypto->resealed($entry['value'], $ctx)
                                : $crypto->seal($entry['value'], $ctx);
                            if ($next !== $entry['value'] || !$wasSealed) {
                                $kept['secrets'][$fieldKey] = ['value' => $next, 'sealed' => true];
                                $changed = true;
                                $count++;
                            }
                        }
                        if ($changed) {
                            $this->nativeApps->writePrivateFile($appId, $fileName, json_encode(
                                [
                                    'plugin' => $pluginId,
                                    'values' => (object) (is_array($kept['values'] ?? null) ? $kept['values'] : []),
                                    'secrets' => (object) $kept['secrets'],
                                ],
                                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                            ));
                        }
                        return $count;
                    });
                } catch (\Throwable $e) {
                    $failed[] = "plugin settings {$fileName} of app {$appId}: " . $e->getMessage();
                }
            }

            if ($this->nativeApps->readPrivateFile($appId, 'verify.json') !== null) {
                try {
                    $moved += $this->nativeApps->withPrivateFileLock($appId, 'verify.json', function () use ($appId, $crypto): int {
                        $text = $this->nativeApps->readPrivateFile($appId, 'verify.json');
                        if ($text === null) {
                            return 0;
                        }
                        $kept = json_decode($text, true);
                        if (!is_array($kept) || !is_string($kept['authToken'] ?? null)) {
                            return 0;
                        }
                        $ctx = 'native-app-verify:' . $appId;
                        $wasSealed = ($kept['sealed'] ?? false) === true;
                        $next = $wasSealed
                            ? $crypto->resealed($kept['authToken'], $ctx)
                            : $crypto->seal($kept['authToken'], $ctx);
                        if ($next !== $kept['authToken'] || !$wasSealed) {
                            $kept['authToken'] = $next;
                            $kept['sealed'] = true;
                            $this->nativeApps->writePrivateFile($appId, 'verify.json', json_encode(
                                $kept,
                                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                            ));
                            return 1;
                        }
                        return 0;
                    });
                } catch (\Throwable $e) {
                    $failed[] = "legacy verify.json of app {$appId}: " . $e->getMessage();
                }
            }
        }
        return $moved;
    }
}
