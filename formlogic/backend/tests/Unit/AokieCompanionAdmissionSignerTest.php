<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AokieCompanionAdmissionSigner;
use PHPUnit\Framework\TestCase;

final class AokieCompanionAdmissionSignerTest extends TestCase
{
    private const SECRET = '0123456789abcdef0123456789abcdef';
    private const MOBILE_THUMBPRINT = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';
    private const PLUGIN_PUBLIC_KEY = 'PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw';
    private const PLUGIN_THUMBPRINT = 'FtIu-VbGrfe_KB6CH7GNwODB72MNxj_ml11dEvO-7kk';

    public function testTokenIsByteExactWithTheRustGatewayFixture(): void
    {
        $signer = new AokieCompanionAdmissionSigner(
            self::SECRET,
            'wss://gateway.example/v2/realtime',
        );
        $issued = $signer->issue(
            'app_a',
            'device_a',
            'mobile',
            ['state_read', 'monitor'],
            self::MOBILE_THUMBPRINT,
            self::PLUGIN_THUMBPRINT,
            [],
            null,
            null,
            90,
            100,
            'admission_a',
        );

        // This exact prefix + hex(JSON) + HMAC-SHA256 format is consumed by
        // aokie-realtime::v2::AdmissionTokenSigner. Keeping the fixture literal
        // catches field-name, ordering, encoding and signature drift in PHP.
        $this->assertSame(
            'aokie-adm-v2.'
            . '7b22617564223a22616f6b69652d76322d67617465776179222c226170704964223a226170705f61222c227375626a6563744964223a226465766963655f61222c22726f6c65223a226d6f62696c65222c22686f6c6465724b65795468756d627072696e74223a226b50724b5f716d7856576159564139777742463649756f3376567a7a37547848435477584279677253346b222c226578706563746564506565724b65795468756d627072696e74223a22467449752d5662477266655f4b4236434837474e774f444237324d4e786a5f6d6c31316445764f2d376b6b222c2273636f706573223a5b2273746174655f72656164222c226d6f6e69746f72225d2c22657870223a3139302c226a7469223a2261646d697373696f6e5f61227d.'
            . '88a1b14b85f07385905df2d5d19c93a35580436c2adad354bbb3da865372e319',
            $issued['accessToken'],
        );
        $this->assertSame(190, $issued['expiresAt']);
        $this->assertSame(90, $issued['expiresIn']);
        $this->assertSame(self::MOBILE_THUMBPRINT, $issued['holderKeyThumbprint']);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $issued['expectedPeerKeyThumbprint']);
    }

    public function testSignerRejectsUnsafeClaimsAndCapsLifetime(): void
    {
        $signer = new AokieCompanionAdmissionSigner(
            self::SECRET,
            'wss://gateway.example/v2/realtime',
        );
        $issued = $signer->issue(
            'app_a',
            'plugin_a',
            'plugin',
            ['state_read', 'rtc_signal', 'assistance_read', 'assistance_respond'],
            self::PLUGIN_THUMBPRINT,
            null,
            [self::MOBILE_THUMBPRINT],
            7,
            AokieCompanionAdmissionSigner::peerRosterHash(7, [self::MOBILE_THUMBPRINT]),
            999,
            100,
            'admission_plugin_a',
        );
        $this->assertSame(300, $issued['expiresIn']);
        $this->assertContains('assistance_respond', $issued['scopes']);
        $this->assertSame([self::MOBILE_THUMBPRINT], $issued['approvedPeerKeyThumbprints']);
        $this->assertSame(7, $issued['peerRosterRevision']);

        $this->expectException(\InvalidArgumentException::class);
        $signer->issue(
            'app_a',
            'device_a',
            'mobile',
            ['takeover'],
            self::MOBILE_THUMBPRINT,
            self::PLUGIN_THUMBPRINT,
            [],
            null,
            null,
            60,
            100,
            'admission_a',
        );
    }

    public function testEndpointAndRosterValidationMatchesProtocolV2AndFailsClosed(): void
    {
        $endpoint = AokieCompanionAdmissionSigner::validateEndpointPublicKey([
            'algorithm' => 'ed25519',
            'publicKey' => self::PLUGIN_PUBLIC_KEY,
            'thumbprint' => self::PLUGIN_THUMBPRINT,
        ]);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $endpoint['thumbprint']);
        $this->assertSame(
            'x8v1MACEY0RpNbXVAPbO29BjImsr9WyKGg17vBfu8tM',
            AokieCompanionAdmissionSigner::peerRosterHash(7, [self::MOBILE_THUMBPRINT]),
        );

        foreach ([
            [[], 1, AokieCompanionAdmissionSigner::peerRosterHash(1, [])],
            [[self::MOBILE_THUMBPRINT, self::MOBILE_THUMBPRINT], 1, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
            [[self::MOBILE_THUMBPRINT], 0, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
            [[self::MOBILE_THUMBPRINT], 1, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
        ] as [$peers, $revision, $hash]) {
            try {
                AokieCompanionAdmissionSigner::validatePluginPeerPolicy($peers, $revision, $hash);
                $this->fail('malformed peer policy must fail closed');
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }

        $this->expectException(\InvalidArgumentException::class);
        AokieCompanionAdmissionSigner::validateEndpointPublicKey([
            'algorithm' => 'ed25519',
            'publicKey' => self::PLUGIN_PUBLIC_KEY,
            'thumbprint' => self::MOBILE_THUMBPRINT,
        ]);
    }
}
