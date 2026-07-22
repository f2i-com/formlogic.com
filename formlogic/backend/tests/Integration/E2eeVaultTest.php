<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\VaultController;
use FormLogic\Services\EncryptionRequestException;
use FormLogic\Services\VaultService;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * P2 vault gates (docs/E2EE_PRIVATE_FORMS_PLAN.md §16-P2):
 *  - the server stores wrapped/sealed material ONLY (it can never recover a vault);
 *  - create is create-only; KDF params round-trip and refuse downgrade;
 *  - passphrase change is a version-checked CAS that rewraps ONLY the passphrase
 *    side (row diff proves the recovery wrap, key bundle and public keys are untouched);
 *  - stale-version CAS → 409 vault_version_conflict;
 *  - controller guards: demo → demo_readonly, acting-as → acting_as_denied,
 *    beta flag off → private_forms_disabled.
 */
class E2eeVaultTest extends E2eeTestCase
{
    /** @return array<string,mixed> */
    private function validCreateBody(): array
    {
        return [
            'kdf' => VaultService::KDF,
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => VaultService::MIN_OPSLIMIT,
            'kdfMemlimit' => VaultService::MIN_MEMLIMIT,
            'wrappedUmk' => base64_encode(random_bytes(72)),
            'wrappedUmkRecovery' => base64_encode(random_bytes(72)),
            'encKeyBundle' => base64_encode(random_bytes(120)),
            'x25519Pk' => base64_encode(random_bytes(32)),
            'ed25519Pk' => base64_encode(random_bytes(32)),
        ];
    }

    public function testCreateAndGetRoundTripsKdfParamsAndWrappedBlobs(): void
    {
        $body = $this->validCreateBody();
        $vault = self::$vaults->createVault($this->userId, $body);

        $this->assertSame(1, $vault['version']);
        $this->assertSame('argon2id13.1', $vault['kdf']);
        $this->assertSame(VaultService::MIN_OPSLIMIT, $vault['kdfOpslimit']);
        $this->assertSame(VaultService::MIN_MEMLIMIT, $vault['kdfMemlimit']);
        foreach (['kdfSalt', 'wrappedUmk', 'wrappedUmkRecovery', 'encKeyBundle', 'x25519Pk', 'ed25519Pk'] as $field) {
            $this->assertSame($body[$field], $vault[$field], "{$field} must round-trip byte-exact");
        }

        $fetched = self::$vaults->getVault($this->userId);
        $this->assertSame($vault, $fetched);
    }

    public function testServerStoresOnlyWrappedMaterial(): void
    {
        self::$vaults->createVault($this->userId, $this->validCreateBody());
        $row = $this->row('SELECT * FROM user_vaults WHERE user_id = ?', [$this->userId]);
        $this->assertNotNull($row);
        // The column set is exactly the §7 contract — no plaintext-key column exists.
        $this->assertSame(
            ['user_id', 'version', 'kdf', 'kdf_salt', 'kdf_memlimit', 'kdf_opslimit',
             'wrapped_umk', 'wrapped_umk_recovery', 'enc_key_bundle', 'x25519_pk', 'ed25519_pk',
             'created_at', 'updated_at'],
            array_keys($row)
        );
        // The stored blobs are raw bytes of the expected lengths (nonce||ct), nothing else.
        $this->assertSame(72, strlen((string) $row['wrapped_umk']));
        $this->assertSame(72, strlen((string) $row['wrapped_umk_recovery']));
        $this->assertSame(16, strlen((string) $row['kdf_salt']));
        $this->assertSame(120, strlen((string) $row['enc_key_bundle']));
    }

    public function testCreateIsCreateOnly(): void
    {
        self::$vaults->createVault($this->userId, $this->validCreateBody());
        try {
            self::$vaults->createVault($this->userId, $this->validCreateBody());
            $this->fail('second create must throw');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('vault_exists', $e->errorCode);
            $this->assertSame(409, $e->status);
        }
        // …and the original row is untouched.
        $this->assertSame(1, (int) $this->row('SELECT version FROM user_vaults WHERE user_id = ?', [$this->userId])['version']);
    }

    public function testRecoveryKitIsMandatoryAtCreation(): void
    {
        $body = $this->validCreateBody();
        unset($body['wrappedUmkRecovery']);
        try {
            self::$vaults->createVault($this->userId, $body);
            $this->fail('vault creation without a recovery wrap must throw (plan D5)');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('vault_invalid', $e->errorCode);
        }
        $this->assertNull($this->row('SELECT user_id FROM user_vaults WHERE user_id = ?', [$this->userId]));
    }

    public function testKdfDowngradeIsRefusedOnCreate(): void
    {
        foreach ([['kdfOpslimit', 2], ['kdfMemlimit', 33_554_432]] as [$field, $value]) {
            $body = $this->validCreateBody();
            $body[$field] = $value;
            try {
                self::$vaults->createVault($this->userId, $body);
                $this->fail("KDF downgrade via {$field} must throw");
            } catch (EncryptionRequestException $e) {
                $this->assertSame('vault_invalid', $e->errorCode);
            }
        }
        $this->assertNull($this->row('SELECT user_id FROM user_vaults WHERE user_id = ?', [$this->userId]));
    }

    public function testKdfDowngradeIsRefusedOnPassphraseChange(): void
    {
        self::$vaults->createVault($this->userId, $this->validCreateBody());
        $body = [
            'expectedVersion' => 1,
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => 1, // downgrade
            'kdfMemlimit' => VaultService::MIN_MEMLIMIT,
            'wrappedUmk' => base64_encode(random_bytes(72)),
        ];
        try {
            self::$vaults->changePassphrase($this->userId, $body);
            $this->fail('KDF downgrade on passphrase change must throw');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('vault_invalid', $e->errorCode);
        }
        // Higher params (upgrade) are accepted.
        $body['kdfOpslimit'] = 4;
        $body['kdfMemlimit'] = VaultService::MIN_MEMLIMIT * 2;
        $vault = self::$vaults->changePassphrase($this->userId, $body);
        $this->assertSame(4, $vault['kdfOpslimit']);
        $this->assertSame(VaultService::MIN_MEMLIMIT * 2, $vault['kdfMemlimit']);
    }

    public function testPassphraseChangeRewrapsOnly(): void
    {
        $create = $this->validCreateBody();
        self::$vaults->createVault($this->userId, $create);
        $before = $this->row('SELECT * FROM user_vaults WHERE user_id = ?', [$this->userId]);
        $this->assertNotNull($before);

        $change = [
            'expectedVersion' => 1,
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => 4,
            'kdfMemlimit' => VaultService::MIN_MEMLIMIT * 2,
            'wrappedUmk' => base64_encode(random_bytes(72)),
        ];
        $vault = self::$vaults->changePassphrase($this->userId, $change);
        $after = $this->row('SELECT * FROM user_vaults WHERE user_id = ?', [$this->userId]);
        $this->assertNotNull($after);

        $this->assertSame(2, $vault['version']);
        // Passphrase-side fields moved…
        $this->assertSame($change['kdfSalt'], base64_encode((string) $after['kdf_salt']));
        $this->assertSame($change['wrappedUmk'], base64_encode((string) $after['wrapped_umk']));
        // …and NOTHING else did (plan: "rotation ≠ passphrase change — rewraps the UMK only").
        foreach (['wrapped_umk_recovery', 'enc_key_bundle', 'x25519_pk', 'ed25519_pk', 'created_at'] as $col) {
            $this->assertSame($before[$col], $after[$col], "{$col} must be untouched by a passphrase change");
        }
    }

    public function testStaleVersionCasConflicts(): void
    {
        self::$vaults->createVault($this->userId, $this->validCreateBody());
        $change = [
            'expectedVersion' => 1,
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => 3,
            'kdfMemlimit' => VaultService::MIN_MEMLIMIT,
            'wrappedUmk' => base64_encode(random_bytes(72)),
        ];
        self::$vaults->changePassphrase($this->userId, $change); // version now 2

        // The loser of the race replays expectedVersion 1 → typed 409 carrying the current version.
        try {
            self::$vaults->changePassphrase($this->userId, $change);
            $this->fail('stale-version change must throw');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('vault_version_conflict', $e->errorCode);
            $this->assertSame(409, $e->status);
            $this->assertSame(2, $e->details['currentVersion'] ?? null);
        }
        $this->assertSame(2, (int) $this->row('SELECT version FROM user_vaults WHERE user_id = ?', [$this->userId])['version']);
    }

    public function testPassphraseChangeOnMissingVault(): void
    {
        try {
            self::$vaults->changePassphrase($this->userId, [
                'expectedVersion' => 1,
                'kdfSalt' => base64_encode(random_bytes(16)),
                'kdfOpslimit' => 3,
                'kdfMemlimit' => VaultService::MIN_MEMLIMIT,
                'wrappedUmk' => base64_encode(random_bytes(72)),
            ]);
            $this->fail('change on a missing vault must throw');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('vault_not_found', $e->errorCode);
            $this->assertSame(404, $e->status);
        }
    }

    // ── controller guards ────────────────────────────────────────────────────

    /** @return array{0: object, 1: SlimResponse} */
    private function controller(bool $flag = true): array
    {
        return [new VaultController(self::$vaults, $flag), new SlimResponse()];
    }

    private function requestWith(array $attributes, string $method = 'GET'): \Psr\Http\Message\ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, 'http://api.test/api/vault');
        foreach ($attributes as $k => $v) {
            $req = $req->withAttribute($k, $v);
        }
        return $req;
    }

    /** @return array<string,mixed> */
    private function decode(SlimResponse $response): array
    {
        $response->getBody()->rewind();
        return (array) json_decode((string) $response->getBody(), true);
    }

    public function testActingAsIsDeniedOnAllVaultVerbs(): void
    {
        [$ctrl, $resp] = $this->controller();
        $req = $this->requestWith(['userId' => $this->userId, 'adminActorId' => 'admin-1']);
        foreach (['getVault', 'createVault', 'changePassphrase'] as $method) {
            $out = $ctrl->{$method}($req, new SlimResponse());
            $this->assertSame(403, $out->getStatusCode(), $method);
            $this->assertSame('acting_as_denied', $this->decode($out)['code'] ?? null, $method);
        }
    }

    public function testDemoAccountIsDenied(): void
    {
        // Another suite may leave DEMO_EMAIL mutated — pin it for this assertion.
        $prev = $_ENV['DEMO_EMAIL'] ?? null;
        $_ENV['DEMO_EMAIL'] = 'demo@formlogic.local';
        try {
            $demoUser = (object) ['email' => 'demo@formlogic.local'];
            [$ctrl, $resp] = $this->controller();
            $req = $this->requestWith(['userId' => $this->userId, 'user' => $demoUser], 'PUT');
            $out = $ctrl->createVault($req, new SlimResponse());
            $this->assertSame(403, $out->getStatusCode());
            $this->assertSame('demo_readonly', $this->decode($out)['code'] ?? null);
        } finally {
            if ($prev === null) {
                unset($_ENV['DEMO_EMAIL']);
            } else {
                $_ENV['DEMO_EMAIL'] = $prev;
            }
        }
    }

    public function testBetaFlagOffRefusesVaultCreationButAllowsReads(): void
    {
        [$ctrl, $resp] = $this->controller(false);
        $req = $this->requestWith(['userId' => $this->userId], 'PUT');
        $out = $ctrl->createVault($req, new SlimResponse());
        $this->assertSame(403, $out->getStatusCode());
        $this->assertSame('private_forms_disabled', $this->decode($out)['code'] ?? null);

        // Reads stay available so a disabled beta never bricks an existing vault.
        $out = $ctrl->getVault($this->requestWith(['userId' => $this->userId]), new SlimResponse());
        $this->assertSame(404, $out->getStatusCode());
        $this->assertSame('vault_not_found', $this->decode($out)['code'] ?? null);
    }
}
