<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Cross-language E2EE vector assertions (docs/E2EE_PRIVATE_FORMS_PLAN.md §16-P1).
 * PHP asserts the deterministic KATs byte-identically and OPENS the JS-sealed fixtures
 * (JS-seal -> PHP-open interop). Sealing is randomized by construction, so there are no
 * byte-identical seal vectors — each side only opens the other's committed output.
 */
final class E2eeVectorsTest extends TestCase
{
    private const CONTRACTS = __DIR__ . '/../../../../docs/contracts';

    /** @return array<string,mixed> */
    private function load(string $file): array
    {
        $path = self::CONTRACTS . '/' . $file;
        self::assertFileExists($path, "run the fixture writers first ({$file})");
        $decoded = json_decode((string) file_get_contents($path), true);
        self::assertIsArray($decoded);
        return $decoded;
    }

    public function testArgon2idKatsMatchByteForByte(): void
    {
        $vectors = $this->load('e2ee-envelope-vectors.json');
        foreach ($vectors['argon2id'] as $v) {
            $out = sodium_crypto_pwhash(
                32,
                $v['password'],
                (string) hex2bin($v['salt_hex']),
                $v['opslimit'],
                $v['memlimit'],
                SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13,
            );
            self::assertSame($v['out_hex'], bin2hex($out), 'argon2id KAT diverged');
        }
    }

    public function testXChaChaKatsAndAadMutationMatrix(): void
    {
        $vectors = $this->load('e2ee-envelope-vectors.json');
        foreach ($vectors['xchacha'] as $v) {
            $key = (string) hex2bin($v['key_hex']);
            $nonce = (string) hex2bin($v['nonce_hex']);
            $plaintext = base64_decode($v['plaintext_b64'], true);
            self::assertIsString($plaintext);

            $ct = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plaintext, $v['aad'], $nonce, $key);
            self::assertSame($v['ct_b64'], base64_encode($ct), 'xchacha KAT diverged');

            $opened = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
                (string) base64_decode($v['ct_b64'], true), $v['aad'], $nonce, $key,
            );
            self::assertSame($plaintext, $opened);

            foreach ($v['badAads'] as $bad) {
                $result = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
                    (string) base64_decode($v['ct_b64'], true), $bad, $nonce, $key,
                );
                self::assertFalse($result, "decrypt must fail for mutated AAD: {$bad}");
            }
        }
    }

    public function testKdfDerivationsMatch(): void
    {
        $vectors = $this->load('e2ee-envelope-vectors.json');
        foreach ($vectors['kdf'] as $v) {
            $out = sodium_crypto_kdf_derive_from_key(
                32, $v['subkey_id'], $v['context'], (string) hex2bin($v['key_hex']),
            );
            self::assertSame($v['out_hex'], bin2hex($out), 'crypto_kdf KAT diverged');
        }
    }

    public function testJsSealedFixturesOpenInPhp(): void
    {
        $file = $this->load('e2ee-sealed-js.json');
        $keypair = sodium_crypto_box_seed_keypair((string) hex2bin($file['meta']['recipient_seed_hex']));
        self::assertSame(
            $file['recipient']['publicKey_b64'],
            base64_encode(sodium_crypto_box_publickey($keypair)),
        );
        foreach ($file['items'] as $item) {
            $opened = sodium_crypto_box_seal_open((string) base64_decode($item['sealed_b64'], true), $keypair);
            self::assertNotFalse($opened, "JS-sealed item failed to open: {$item['label']}");
            self::assertSame($item['plaintext_b64'], base64_encode($opened));
        }
    }

    public function testJsFullEnvelopeOpensInPhp(): void
    {
        $file = $this->load('e2ee-sealed-js.json');
        $fix = $file['envelope'];
        $env = $fix['envelope'];

        $ingestion = sodium_crypto_box_seed_keypair((string) hex2bin($fix['ingestion_seed_hex']));
        $dek = sodium_crypto_box_seal_open((string) base64_decode($env['wrappedDek'], true), $ingestion);
        self::assertNotFalse($dek, 'DEK unwrap failed');
        self::assertSame(32, strlen((string) $dek));

        // AAD rebuilt here exactly as the client builds it (§6). Production PHP never
        // does this — it holds no keys; this test proves the byte layout end-to-end.
        $attHash = '-';
        $aad = sprintf(
            'flenc:1|%s|%s|%d|%s|%d|%d|%s|%s',
            $fix['formId'], $env['recordId'], $env['rev'], $env['keyId'],
            $env['epoch'], $env['schemaVersion'], $env['schemaHash'], $attHash,
        );
        $plaintext = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
            (string) base64_decode($env['ct'], true), $aad,
            (string) base64_decode($env['nonce'], true), (string) $dek,
        );
        self::assertNotFalse($plaintext, 'content decrypt failed');
        self::assertSame($fix['expectedInner'], json_decode((string) $plaintext, true));

        // Cross-form replay must fail: same envelope, different formId in the AAD.
        $wrongAad = str_replace($fix['formId'], 'another-form', $aad);
        self::assertFalse(sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
            (string) base64_decode($env['ct'], true), $wrongAad,
            (string) base64_decode($env['nonce'], true), (string) $dek,
        ));
    }

    public function testPhpSealedFixturesExistAndSelfOpen(): void
    {
        $file = $this->load('e2ee-sealed-php.json');
        $keypair = sodium_crypto_box_seed_keypair((string) hex2bin($file['meta']['recipient_seed_hex']));
        foreach ($file['items'] as $item) {
            $opened = sodium_crypto_box_seal_open((string) base64_decode($item['sealed_b64'], true), $keypair);
            self::assertNotFalse($opened, "PHP-sealed item failed to self-open: {$item['label']}");
            self::assertSame($item['plaintext_b64'], base64_encode($opened));
        }
    }
}
