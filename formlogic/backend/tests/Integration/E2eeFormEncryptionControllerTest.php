<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FormEncryptionController;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * Form-encryption controller guards (plan §9.1 item 9 + D9): demo and acting-as
 * are refused, the beta flag gates mutating endpoints, non-owners get a bare 404
 * (no existence leak), and the owner read surface returns the key/grant/manifest
 * state a client needs to unlock + verify.
 */
class E2eeFormEncryptionControllerTest extends E2eeTestCase
{
    private function controller(bool $flag = true): FormEncryptionController
    {
        return new FormEncryptionController(self::$encryption, self::$forms, null, $flag);
    }

    private function request(string $method, array $attributes, ?array $body = null): \Psr\Http\Message\ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, 'http://api.test/x');
        if ($body !== null) {
            $req = $req->withBody((new StreamFactory())->createStream((string) json_encode($body)))
                ->withHeader('Content-Type', 'application/json')
                ->withParsedBody($body);
        }
        foreach ($attributes as $k => $v) {
            $req = $req->withAttribute($k, $v);
        }
        return $req;
    }

    /** @return array{status:int, body:array<string,mixed>} */
    private function out(SlimResponse $res): array
    {
        $res->getBody()->rewind();
        return ['status' => $res->getStatusCode(), 'body' => (array) json_decode((string) $res->getBody(), true)];
    }

    public function testEnableEndToEndThroughController(): void
    {
        $form = $this->makeDraftForm();
        $vault = $this->makeVault($this->userId);
        $body = $this->makeEnableBody((string) $form['id'], $this->userId, $vault, $form);
        $res = $this->controller()->enable(
            $this->request('POST', ['userId' => $this->userId], $body),
            new SlimResponse(),
            ['formId' => $form['id']]
        );
        $out = $this->out($res);
        $this->assertSame(200, $out['status']);
        $this->assertTrue($out['body']['data']['enabled'] ?? false);
        $this->assertTrue(self::$encryption->isPrivate((string) $form['id']));
    }

    public function testNonOwnerGetsBare404(): void
    {
        $form = $this->makeDraftForm();
        $other = $this->makeUser();
        $res = $this->controller()->enable(
            $this->request('POST', ['userId' => $other], []),
            new SlimResponse(),
            ['formId' => $form['id']]
        );
        $out = $this->out($res);
        $this->assertSame(404, $out['status']);
        $this->assertArrayNotHasKey('code', $out['body']); // no existence leak
    }

    public function testActingAsDeniedOnMutationsAndStateRead(): void
    {
        $form = $this->makeDraftForm();
        $this->enablePrivateForm((string) $form['id']);
        $attrs = ['userId' => $this->userId, 'adminActorId' => 'admin-1'];

        foreach ([
            ['enable', []],
            ['publishSchema', []],
        ] as [$method, $body]) {
            $res = $this->controller()->{$method}($this->request('POST', $attrs, $body), new SlimResponse(), ['formId' => $form['id']]);
            $out = $this->out($res);
            $this->assertSame(403, $out['status'], $method);
            $this->assertSame('acting_as_denied', $out['body']['code'] ?? null, $method);
        }
        $res = $this->controller()->getEncryption($this->request('GET', $attrs), new SlimResponse(), ['formId' => $form['id']]);
        $out = $this->out($res);
        $this->assertSame(403, $out['status']);
        $this->assertSame('acting_as_denied', $out['body']['code'] ?? null);
    }

    public function testDemoDenied(): void
    {
        // Another suite may leave DEMO_EMAIL mutated — pin it for this assertion.
        $prev = $_ENV['DEMO_EMAIL'] ?? null;
        $_ENV['DEMO_EMAIL'] = 'demo@formlogic.local';
        try {
            $form = $this->makeDraftForm();
            $attrs = ['userId' => $this->userId, 'user' => (object) ['email' => 'demo@formlogic.local']];
            $res = $this->controller()->enable($this->request('POST', $attrs, []), new SlimResponse(), ['formId' => $form['id']]);
            $out = $this->out($res);
            $this->assertSame(403, $out['status']);
            $this->assertSame('demo_readonly', $out['body']['code'] ?? null);
        } finally {
            if ($prev === null) {
                unset($_ENV['DEMO_EMAIL']);
            } else {
                $_ENV['DEMO_EMAIL'] = $prev;
            }
        }
    }

    public function testBetaFlagOffGatesMutationsButNotReads(): void
    {
        $form = $this->makeDraftForm();
        $this->enablePrivateForm((string) $form['id']);
        $ctrl = $this->controller(false);

        $res = $ctrl->enable($this->request('POST', ['userId' => $this->userId], []), new SlimResponse(), ['formId' => $form['id']]);
        $out = $this->out($res);
        $this->assertSame(403, $out['status']);
        $this->assertSame('private_forms_disabled', $out['body']['code'] ?? null);

        $res = $ctrl->publishSchema($this->request('POST', ['userId' => $this->userId], []), new SlimResponse(), ['formId' => $form['id']]);
        $this->assertSame(403, $this->out($res)['status']);

        // Reads stay open (a disabled beta never bricks existing private forms).
        $res = $ctrl->getEncryption($this->request('GET', ['userId' => $this->userId]), new SlimResponse(), ['formId' => $form['id']]);
        $this->assertSame(200, $this->out($res)['status']);
    }

    public function testOwnerStateReadReturnsGrantsKeysManifestsAndSchemas(): void
    {
        $form = $this->makeDraftForm();
        $enabled = $this->enablePrivateForm((string) $form['id']);
        $res = $this->controller()->getEncryption(
            $this->request('GET', ['userId' => $this->userId]),
            new SlimResponse(),
            ['formId' => $form['id']]
        );
        $out = $this->out($res);
        $this->assertSame(200, $out['status']);
        $data = $out['body']['data'] ?? [];
        $this->assertSame('private', $data['encryption']['mode'] ?? null);
        $this->assertNotEmpty($data['grant']['wrappedKey'] ?? null);
        $this->assertCount(1, $data['ingestionKeys'] ?? []);
        $this->assertCount(1, $data['manifests'] ?? []);
        $this->assertCount(1, $data['schemaVersions'] ?? []);
        $this->assertSame($enabled['vault']['ed25519PkB64'], $data['manifests'][0]['signerPk'] ?? null);
    }

    public function testStateReadOnPlainFormIsTyped404(): void
    {
        $form = $this->makeDraftForm();
        $res = $this->controller()->getEncryption(
            $this->request('GET', ['userId' => $this->userId]),
            new SlimResponse(),
            ['formId' => $form['id']]
        );
        $out = $this->out($res);
        $this->assertSame(404, $out['status']);
        $this->assertSame('private_form_not_encrypted', $out['body']['code'] ?? null);
    }

    public function testFormsListCarriesIsPrivateFlag(): void
    {
        // The owner forms list marks private forms with a lock icon — the flag rides
        // the list query itself (one correlated EXISTS, no N+1 per form).
        $private = $this->makeDraftForm();
        $this->enablePrivateForm((string) $private['id']);
        $plain = $this->makeDraftForm();

        $byId = [];
        foreach (self::$forms->getAllForms($this->userId) as $f) {
            $byId[(string) $f['id']] = $f;
        }
        $this->assertArrayHasKey((string) $private['id'], $byId);
        $this->assertArrayHasKey((string) $plain['id'], $byId);
        $this->assertTrue($byId[(string) $private['id']]['isPrivate'] ?? null);
        $this->assertFalse($byId[(string) $plain['id']]['isPrivate'] ?? null);
    }
}
