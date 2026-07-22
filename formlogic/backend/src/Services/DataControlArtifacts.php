<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Deterministic control-artifact lines for one Private form
 * (docs/FORMLOGIC_DATA_NODES.md §9/§12): manifests, schema versions,
 * ingestion keys, and grants as EXACT NDJSON line bytes. An artifact's
 * flroot:1 entry hash is sha256 over its line, so the SAME builder must feed
 * both the snapshot packages and the per-write head checkpoints — byte drift
 * between the two would make checkpoint roots and package roots disagree.
 */
final class DataControlArtifacts
{
    /**
     * @return list<array{kind: string, id: string, line: string}>
     */
    public static function linesFor(\PDO $mysqlPdo, string $formId): array
    {
        $out = [];
        $add = static function (string $kind, string $id, array $fields) use (&$out): void {
            $line = json_encode(['kind' => $kind, 'id' => $id] + $fields, JSON_UNESCAPED_SLASHES);
            if ($line === false) {
                throw new \RuntimeException('control artifact does not serialize');
            }
            $out[] = ['kind' => $kind, 'id' => $id, 'line' => $line];
        };

        $stmt = $mysqlPdo->prepare('SELECT * FROM form_manifests WHERE form_id = ? ORDER BY manifest_seq');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $m) {
            $add('manifest', (string) $m['id'], [
                'manifestSeq' => (int) $m['manifest_seq'],
                'keyId' => (string) $m['key_id'],
                'ingestEpoch' => (int) $m['ingest_epoch'],
                'schemaVersion' => (int) $m['schema_version'],
                'schemaHash' => (string) $m['schema_hash'],
                'contentSuite' => (string) $m['content_suite'],
                'wrapSuite' => (string) $m['wrap_suite'],
                'signerKeyId' => (string) $m['signer_key_id'],
                'signerPk' => (string) $m['signer_pk'],
                'signedBytes' => base64_encode((string) $m['signed_bytes']),
                'signature' => base64_encode((string) $m['signature']),
                'createdAt' => (string) $m['created_at'],
                'expiresAt' => $m['expires_at'],
                'supersededAt' => $m['superseded_at'],
            ]);
        }
        $stmt = $mysqlPdo->prepare('SELECT * FROM form_schema_versions WHERE form_id = ? ORDER BY version');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $s) {
            $add('schema', (string) $s['id'], [
                'version' => (int) $s['version'],
                'schemaJson' => base64_encode((string) $s['schema_json']),
                'schemaHash' => (string) $s['schema_hash'],
                'createdAt' => (string) $s['created_at'],
            ]);
        }
        $stmt = $mysqlPdo->prepare('SELECT * FROM form_ingestion_keys WHERE form_id = ? ORDER BY epoch');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $k) {
            $add('ingestion', (string) $k['id'], [
                'epoch' => (int) $k['epoch'],
                'publicKey' => (string) $k['public_key'],
                'wrappedSecret' => base64_encode((string) $k['wrapped_secret']),
                'fkEpoch' => (int) $k['fk_epoch'],
                'state' => (string) $k['state'],
                'acceptUntil' => $k['accept_until'],
                'createdAt' => (string) $k['created_at'],
            ]);
        }
        $stmt = $mysqlPdo->prepare('SELECT * FROM form_key_grants WHERE form_id = ? ORDER BY fk_epoch, user_id');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $g) {
            $add('grant', (string) $g['id'], [
                'userId' => (string) $g['user_id'],
                'fkEpoch' => (int) $g['fk_epoch'],
                'wrappedKey' => base64_encode((string) $g['wrapped_key']),
                'wrapSuite' => (string) $g['wrap_suite'],
                'role' => (string) $g['role'],
                'grantorUserId' => (string) $g['grantor_user_id'],
                'grantorKeyId' => (string) $g['grantor_key_id'],
                'granteePk' => (string) $g['grantee_pk'],
                'sigVersion' => (int) $g['sig_version'],
                'signature' => base64_encode((string) $g['signature']),
                'expiresAt' => $g['expires_at'],
                'state' => (string) $g['state'],
            ]);
        }
        return $out;
    }

    /**
     * flroot:1 artifact entries for the given lines.
     * @param list<array{kind: string, id: string, line: string}> $lines
     * @return list<array{0:string,1:string,2:string,3:string}>
     */
    public static function rootEntries(array $lines): array
    {
        return array_map(
            static fn(array $l): array => ['artifact', $l['kind'], $l['id'], hash('sha256', $l['line'])],
            $lines,
        );
    }
}
