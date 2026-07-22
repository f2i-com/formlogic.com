<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FormController;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * §8 manifest serving: the owner payload carries the signed manifest with
 * Cache-Control: no-store; the manifest block matches the frozen wire shape and
 * its signature mathematically verifies against the included signer key
 * (recomputed canonical string — an independent reimplementation of §8).
 */
class E2eeManifestPayloadTest extends E2eeTestCase
{
    public function testPublicManifestShapeAndSignatureVerify(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $enabled = $this->enablePrivateForm($formId);
        $vault = $enabled['vault'];

        $m = self::$encryption->publicManifest($formId);
        $this->assertNotNull($m);

        // The frozen §8 shape — exact key set, no more, no less.
        $this->assertSame(
            ['mode', 'keyId', 'epoch', 'publicKey', 'content', 'wrap', 'schemaVersion', 'schemaHash', 'schemaJson', 'signerKeyId', 'signerPk', 'expiresAt', 'sig'],
            array_keys($m)
        );
        $this->assertSame('private', $m['mode']);
        $this->assertSame('xchacha20p1305.1', $m['content']);
        $this->assertSame('sealedbox-x25519xsalsa20p1305.1', $m['wrap']);
        $this->assertSame(1, $m['epoch']);
        $this->assertSame(1, $m['schemaVersion']);
        $this->assertSame($vault['ed25519PkB64'], $m['signerPk']);
        $this->assertNull($m['expiresAt']);
        $this->assertSame(hash('sha256', $m['schemaJson']), $m['schemaHash']);

        // Any browser can verify: sig over the §8 canonical string against signerPk.
        $canonical = $this->manifestCanonical(
            $formId,
            $m['keyId'],
            $m['epoch'],
            $m['publicKey'],
            $m['schemaVersion'],
            $m['schemaHash'],
            $m['signerKeyId']
        );
        $this->assertTrue(sodium_crypto_sign_verify_detached(
            base64_decode($m['sig']),
            $canonical,
            base64_decode($m['signerPk'])
        ));
    }

    public function testOwnerPayloadCarriesManifestWithNoStore(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);

        $controller = new FormController(self::$forms, null, null, null, null, null, null, self::$encryption);
        $req = (new ServerRequestFactory())
            ->createServerRequest('GET', 'http://api.test/api/forms/' . $formId)
            ->withAttribute('userId', $this->userId);
        $res = $controller->show($req, new SlimResponse(), ['id' => $formId]);
        $this->assertSame(200, $res->getStatusCode());
        $this->assertSame('no-store', $res->getHeaderLine('Cache-Control'));

        $res->getBody()->rewind();
        $body = (array) json_decode((string) $res->getBody(), true);
        $this->assertSame('private', $body['form']['encryption']['mode'] ?? null);
    }

    public function testPlainFormPayloadHasNoEncryptionBlock(): void
    {
        $form = $this->makeDraftForm();
        $controller = new FormController(self::$forms, null, null, null, null, null, null, self::$encryption);
        $req = (new ServerRequestFactory())
            ->createServerRequest('GET', 'http://api.test/api/forms/' . $form['id'])
            ->withAttribute('userId', $this->userId);
        $res = $controller->show($req, new SlimResponse(), ['id' => (string) $form['id']]);
        $this->assertSame('', $res->getHeaderLine('Cache-Control'));
        $res->getBody()->rewind();
        $body = (array) json_decode((string) $res->getBody(), true);
        $this->assertArrayNotHasKey('encryption', $body['form'] ?? []);
    }
}
