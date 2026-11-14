<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\ApiKeyService;
use FormLogic\Services\DesktopLinkCodeService;
use FormLogic\Services\DesktopLinkIssuer;
use FormLogic\Services\FlowService;
use FormLogic\Tests\Support\LinkedComputers;
use PHPUnit\Framework\TestCase;

/**
 * A one-time code to link an OAIY server (DesktopLinkCodeService), once it is shown: its maker can
 * withdraw it until a server uses it, after which it cannot be spent; and a code a server spent
 * while linking stalled (its PHP worker died between spending it and making the key) reads as
 * failed after a minute, not as waiting for ever.
 */
final class DesktopLinkCodeWithdrawTest extends TestCase
{
    private LinkedComputers $db;
    private DesktopLinkCodeService $codes;

    protected function setUp(): void
    {
        $this->db = new LinkedComputers();
        $this->db->getConnection()->exec('CREATE TABLE desktop_link_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, device_name TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT, connection_id TEXT, failure TEXT)');
        $keys = $this->createMock(ApiKeyService::class);
        $keys->method('hasRoom')->willReturn(true);
        $this->codes = new DesktopLinkCodeService($this->db, new DesktopLinkIssuer($keys, $this->createMock(FlowService::class)), $keys, 'desktop-link-withdraw-test-secret');
    }

    private function spend(string $id, int $secondsAgo): void
    {
        $this->db->getConnection()->prepare('UPDATE desktop_link_codes SET redeemed_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', time() - $secondsAgo), $id]);
    }

    public function testACodeNotYetUsedIsWithdrawnAndCannotBeSpentAfter(): void
    {
        $code = $this->codes->start('u-1');
        $this->assertSame('waiting', $this->codes->status('u-1', $code['id'])['status']);
        $this->assertSame('withdrawn', $this->codes->withdraw('u-1', $code['id']));
        $this->assertNull($this->codes->status('u-1', $code['id']), 'gone');
        try {
            $this->codes->redeem($code['code']);
            $this->fail('a withdrawn code was spent');
        } catch (\RuntimeException $e) {
            $this->assertSame('desktop_link_invalid', $e->getMessage());
        }
    }

    public function testOnlyItsMakerWithdrawsItAndAnotherPersonsCodeIsAnsweredAsNone(): void
    {
        $code = $this->codes->start('u-1');
        $this->assertNull($this->codes->withdraw('u-2', $code['id']), 'someone else\'s');
        $this->assertNull($this->codes->withdraw('u-1', 'no-such-code'));
        $this->assertSame('waiting', $this->codes->status('u-1', $code['id'])['status'], 'and it stands');
    }

    public function testACodeAServerHasUsedIsNotWithdrawn(): void
    {
        $code = $this->codes->start('u-1');
        $this->spend($code['id'], 5);
        $this->assertSame('used', $this->codes->withdraw('u-1', $code['id']));
        $this->assertSame('waiting', $this->codes->status('u-1', $code['id'])['status'], 'its key is being made');
    }

    /**
     * The route (DesktopLinkController::withdraw): its maker withdraws a waiting code and it is
     * recorded; a used one says how to undo its link; someone else's reads as none; and it is held
     * to what making a code is, refused in the shared demo and to an administrator acting as the account.
     */
    public function testTheRouteWithdrawsForItsMakerAndIsRefusedInTheDemoAndToAnAdministratorActingAs(): void
    {
        $audit = $this->createMock(\FormLogic\Services\AuditService::class);
        $logged = [];
        // log(action, entity type, entity id, user, ip, details)
        $audit->method('log')->willReturnCallback(function (string $action, ...$rest) use (&$logged): void { $logged[] = [$action, $rest[4] ?? null]; });
        $controller = new \FormLogic\Controllers\DesktopLinkController($this->codes, $audit);
        $call = function (string $user, string $id, array $attributes = []) use ($controller): array {
            $request = (new \Slim\Psr7\Factory\ServerRequestFactory())->createServerRequest('DELETE', "https://formlogic.example/api/desktop-links/codes/{$id}")->withAttribute('userId', $user);
            foreach ($attributes as $name => $value) $request = $request->withAttribute($name, $value);
            $response = $controller->withdraw($request, new \Slim\Psr7\Response(), ['id' => $id]);
            return [$response->getStatusCode(), json_decode((string) $response->getBody(), true), $response->getHeaderLine('Cache-Control')];
        };
        $waiting = $this->codes->start('u-1');
        // Refused, and the code stands: the shared demo, and an administrator acting as the account.
        $demo = new \stdClass();
        $demo->email = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        [$status, $body] = $call('u-1', $waiting['id'], ['user' => $demo]);
        $this->assertSame([403, 'demo_readonly'], [$status, $body['code']]);
        [$status, $body] = $call('u-1', $waiting['id'], ['adminActorId' => 'admin-1']);
        $this->assertSame([403, 'acting_as_denied'], [$status, $body['code']]);
        $this->assertSame('waiting', $this->codes->status('u-1', $waiting['id'])['status']);
        // Someone else's, or none at all: the same 404.
        $this->assertSame([404, 'desktop_link_not_found'], [$call('u-2', $waiting['id'])[0], $call('u-2', $waiting['id'])[1]['code']]);
        $this->assertSame(404, $call('u-1', 'no-such-code')[0]);
        // Its maker withdraws it, uncached, and it is recorded.
        $this->assertSame([200, ['data' => ['status' => 'withdrawn']], 'no-store'], $call('u-1', $waiting['id']));
        $this->assertSame([['desktop.link_code.withdraw', ['codeId' => $waiting['id']]]], $logged);
        // A used one says so.
        $used = $this->codes->start('u-1');
        $this->spend($used['id'], 5);
        $this->assertSame([409, 'desktop_link_used'], [$call('u-1', $used['id'])[0], $call('u-1', $used['id'])[1]['code']]);
    }

    public function testASpentCodeWhoseLinkNeverFinishedReadsAsFailedAfterAMinute(): void
    {
        $code = $this->codes->start('u-1');
        $this->spend($code['id'], DesktopLinkCodeService::REDEEM_SECONDS + 5);
        $status = $this->codes->status('u-1', $code['id']);
        $this->assertSame(['failed', DesktopLinkCodeService::REDEEM_FAILED], [$status['status'], $status['message']]);
    }
}
