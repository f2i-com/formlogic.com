<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\DataCanonicalJson;
use PHPUnit\Framework\TestCase;

/**
 * Cross-language data-nodes vector assertions (docs/FORMLOGIC_DATA_NODES.md §1-§3).
 * The fixture file is written by the vitest suite (FORMLOGIC_DATA_VECTORS_WRITE=1
 * npx vitest run src/lib/data/vectors.test.ts); PHP and Rust assert it byte-identically.
 */
final class DataSyncVectorsTest extends TestCase
{
    private const CONTRACTS = __DIR__ . '/../../../../docs/contracts';

    /** @return array<string,mixed> */
    private function load(): array
    {
        $path = self::CONTRACTS . '/data-sync-vectors.json';
        self::assertFileExists($path, 'run the vitest fixture writer first');
        $decoded = json_decode((string) file_get_contents($path), true);
        self::assertIsArray($decoded);
        return $decoded;
    }

    public function testCanonicalizeVectorsMatchByteForByte(): void
    {
        $vectors = $this->load();
        self::assertNotEmpty($vectors['canonicalize']);
        foreach ($vectors['canonicalize'] as $v) {
            $parsed = json_decode($v['json'], false, 512, JSON_THROW_ON_ERROR);
            self::assertSame($v['canonical'], DataCanonicalJson::encode($parsed), $v['name']);
        }
    }

    public function testRejectVectorsNeverVerifyAsCanonicalBytes(): void
    {
        $vectors = $this->load();
        self::assertNotEmpty($vectors['reject']);
        foreach ($vectors['reject'] as $v) {
            $verifies = false;
            try {
                $parsed = json_decode($v['json'], false, 512, JSON_THROW_ON_ERROR);
                $verifies = DataCanonicalJson::encode($parsed) === $v['json'];
            } catch (\JsonException | \RuntimeException) {
                $verifies = false;
            }
            self::assertFalse($verifies, "{$v['name']} ({$v['reason']}) must not verify");
        }
    }

    public function testDomainHashVectorsMatch(): void
    {
        $vectors = $this->load();
        self::assertNotEmpty($vectors['hashes']);
        foreach ($vectors['hashes'] as $v) {
            $parsed = json_decode($v['json'], false, 512, JSON_THROW_ON_ERROR);
            self::assertSame($v['sha256'], DataCanonicalJson::hashHex($v['domain'], $parsed), $v['name']);
        }
    }

    public function testEd25519IdentitySignaturesAndDomainSeparation(): void
    {
        $vectors = $this->load();
        $ed = $vectors['ed25519'];
        $pair = sodium_crypto_sign_seed_keypair((string) hex2bin($ed['seed_hex']));
        $pk = sodium_crypto_sign_publickey($pair);
        $sk = sodium_crypto_sign_secretkey($pair);
        self::assertSame($ed['public_key_b64'], base64_encode($pk));
        self::assertSame($ed['key_id'], DataCanonicalJson::keyId($pk));
        self::assertSame($ed['fingerprint'], DataCanonicalJson::fingerprint($pk));

        self::assertNotEmpty($ed['signatures']);
        foreach ($ed['signatures'] as $v) {
            $structure = json_decode($v['json'], false, 512, JSON_THROW_ON_ERROR);
            self::assertSame(
                $v['signature_b64'],
                DataCanonicalJson::signB64($v['domain'], $structure, $sk),
                $v['name'],
            );
            $signed = clone $structure;
            $signed->signature = $v['signature_b64'];
            self::assertTrue(DataCanonicalJson::verify($v['domain'], $signed, $pk), "{$v['name']} verifies");

            // A signature must not validate under another domain (docs/FORMLOGIC_DATA_NODES.md §2).
            $otherDomain = $v['domain'] === DataCanonicalJson::DOMAIN_OPERATION
                ? DataCanonicalJson::DOMAIN_CHECKPOINT
                : DataCanonicalJson::DOMAIN_OPERATION;
            self::assertFalse(DataCanonicalJson::verify($otherDomain, $signed, $pk), "{$v['name']} cross-domain");

            $tampered = clone $signed;
            $tampered->sequence = 999999;
            self::assertFalse(DataCanonicalJson::verify($v['domain'], $tampered, $pk), "{$v['name']} tampered");
        }
    }

    public function testLogicalRootVectorsMatch(): void
    {
        $vectors = $this->load();
        self::assertNotEmpty($vectors['logical_roots']);
        foreach ($vectors['logical_roots'] as $v) {
            self::assertSame(
                $v['root_hex'],
                DataCanonicalJson::logicalRootHex($v['dataset_id'], $v['entries']),
                $v['name'],
            );
        }
    }

    public function testPreimageRequiresObjectTopLevel(): void
    {
        $this->expectException(\RuntimeException::class);
        DataCanonicalJson::preimage(DataCanonicalJson::DOMAIN_OPERATION, [1, 2, 3]);
    }
}
