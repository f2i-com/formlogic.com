<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AuthController;
use FormLogic\Services\AuthService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Audit FL-005/FL-01: account erasure must be TRUTHFUL and RESUMABLE. A
 * resource-deletion failure previously logged-and-swallowed, then deleted the
 * users row anyway and reported success — orphaning per-form SQLite databases
 * and uploads on disk with no owner left to retry as. Now: any failure keeps
 * the account intact and returns a retryable 'failed' status; the users row
 * drops only after the owned-resource inventory verifies EMPTY.
 */
final class AccountErasureTruthfulnessTest extends TestCase
{
    /** AuthService double: password always verifies; records account deletions. */
    private function authStub(): AuthService
    {
        return new class () extends AuthService {
            /** @var string[] */
            public array $deletedUsers = [];
            public function __construct()
            {
                // no DB needed
            }
            public function verifyPassword(string $userId, string $password): bool
            {
                return true;
            }
            public function deleteAccount(string $userId): void
            {
                $this->deletedUsers[] = $userId;
            }
        };
    }

    /** FormService double over an in-memory form inventory; deleteForm can be broken. */
    private function formsStub(array $formIds, bool $deletesFail): FormService
    {
        return new class ($formIds, $deletesFail) extends FormService {
            /** @var array<string,bool> */
            public array $inventory = [];
            public function __construct(array $formIds, private bool $fail)
            {
                foreach ($formIds as $id) {
                    $this->inventory[$id] = true;
                }
            }
            public function getAllForms(?string $userId = null, array $options = []): array
            {
                return array_map(static fn (string $id) => ['id' => $id], array_keys($this->inventory));
            }
            public function deleteForm(string $formId): bool
            {
                if ($this->fail) {
                    throw new \RuntimeException('disk error deleting per-form database');
                }
                unset($this->inventory[$formId]);
                return true;
            }
        };
    }

    private function deleteAccountRequest(AuthController $controller): array
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/auth/account')
            ->withAttribute('userId', 'user-1')
            ->withParsedBody(['password' => 'correct-horse']);
        $response = $controller->deleteAccount($request, new Response());
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    public function testFailedResourceDeletionKeepsTheAccountAndReportsRetryable(): void
    {
        $auth = $this->authStub();
        $forms = $this->formsStub(['f1', 'f2'], deletesFail: true);
        $controller = new AuthController($auth, [], 86400, null, null, '', $forms, null);

        [$status, $body] = $this->deleteAccountRequest($controller);

        $this->assertSame(503, $status);
        $this->assertSame('failed', $body['status'] ?? null);
        $this->assertTrue($body['retryable'] ?? false);
        $this->assertSame(2, $body['failedForms'] ?? null);
        // The load-bearing guarantee: the users row was NOT dropped, so the
        // stranded per-form data still has an owner and the erasure can resume.
        $this->assertSame([], $auth->deletedUsers, 'account must survive a partial erasure');
    }

    public function testCleanErasureVerifiesEmptyInventoryThenCompletes(): void
    {
        $auth = $this->authStub();
        $forms = $this->formsStub(['f1', 'f2'], deletesFail: false);
        $controller = new AuthController($auth, [], 86400, null, null, '', $forms, null);

        [$status, $body] = $this->deleteAccountRequest($controller);

        $this->assertSame(200, $status);
        $this->assertSame('completed', $body['status'] ?? null);
        $this->assertSame([], $forms->inventory, 'every owned form deleted');
        $this->assertSame(['user-1'], $auth->deletedUsers, 'account dropped only after verification');
    }

    /** A retry AFTER the failure cause is fixed completes — resumable by construction. */
    public function testRetryAfterRepairCompletesTheErasure(): void
    {
        $auth = $this->authStub();
        $forms = $this->formsStub(['f1'], deletesFail: true);
        $controller = new AuthController($auth, [], 86400, null, null, '', $forms, null);

        [$status] = $this->deleteAccountRequest($controller);
        $this->assertSame(503, $status);
        $this->assertSame([], $auth->deletedUsers);

        // "Repair the disk" and retry with the same controller state.
        $repaired = new \ReflectionProperty($forms, 'fail');
        $repaired->setValue($forms, false);
        [$status, $body] = $this->deleteAccountRequest($controller);
        $this->assertSame(200, $status);
        $this->assertSame('completed', $body['status'] ?? null);
        $this->assertSame(['user-1'], $auth->deletedUsers);
    }
}
