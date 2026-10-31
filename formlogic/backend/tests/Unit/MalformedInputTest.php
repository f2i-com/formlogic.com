<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AIController;
use FormLogic\Controllers\AppUserController;
use FormLogic\Controllers\AuthController;
use FormLogic\Controllers\FormController;
use FormLogic\Controllers\PackCatalogController;
use FormLogic\Services\AIService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\DocumentConverter;
use FormLogic\Services\FormService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackFileService;
use FormLogic\Services\PlanService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * What a fuzz of every route found: a field of the wrong type reached a typed parameter and came
 * back as a 500. A client's mistake is a 4xx, and a server error should mean the server's fault.
 */
final class MalformedInputTest extends TestCase
{
    private function post(array $body, string $path = '/api/x'): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.local' . $path)
            ->withAttribute('userId', 'user-1')
            ->withParsedBody($body);
    }

    private function message(ResponseInterface $response): string
    {
        return (string) (json_decode((string) $response->getBody(), true)['message'] ?? '');
    }

    /** @return array<string, array{mixed}> */
    public static function notText(): array
    {
        return ['a list' => [['x']], 'an object' => [['x' => 1]], 'a number' => [123], 'true' => [true]];
    }

    #[DataProvider('notText')]
    public function testSigningInWithAPasswordThatIsntTextIsARefusal(mixed $password): void
    {
        $controller = (new \ReflectionClass(AuthController::class))->newInstanceWithoutConstructor();

        $response = $controller->login($this->post(['email' => 'a@example.com', 'password' => $password]), new SlimResponse());

        $this->assertSame(400, $response->getStatusCode());
    }

    #[DataProvider('notText')]
    public function testAnInvitationTokenThatIsntTextIsARefusal(mixed $token): void
    {
        $controller = (new \ReflectionClass(AppUserController::class))->newInstanceWithoutConstructor();

        $response = $controller->acceptInvitation($this->post(['token' => $token]), new SlimResponse());

        $this->assertSame(400, $response->getStatusCode());
    }

    public function testBrowsingPacksIgnoresFiltersThatArentText(): void
    {
        $catalog = $this->createMock(PackCatalogService::class);
        $catalog->expects($this->once())->method('listPublicPacks')
            ->with(['tag' => 'crm'], 'popular', 1, 20)->willReturn(['packs' => []]);
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://formlogic.local/api/packs/catalog')
            ->withQueryParams(['sort' => ['x'], 'search' => ['x'], 'category' => ['a' => 'b'], 'tag' => 'crm']);

        $response = (new PackCatalogController($catalog, $this->createMock(PackFileService::class)))->browse($request, new SlimResponse());

        $this->assertSame(200, $response->getStatusCode());
    }

    #[DataProvider('notText')]
    public function testPublishingAPackWhoseNameOrDetailsArentTextIsARefusal(mixed $value): void
    {
        $catalog = $this->createMock(PackCatalogService::class);
        $catalog->expects($this->never())->method('publishPack');
        $controller = new PackCatalogController($catalog, $this->createMock(PackFileService::class));

        foreach (['name', 'description', 'slug', 'icon', 'category', 'itemType', 'version', 'changelog'] as $field) {
            $body = ['pack' => ['x' => 1], 'name' => 'Good name', $field => $value];
            $response = $controller->publish($this->post($body), new SlimResponse());
            $this->assertSame(400, $response->getStatusCode(), $field);
        }
    }

    public function testWithSiteAiOffAGeneratorSaysWhatToDoAndChargesNothing(): void
    {
        $ai = $this->createMock(AIService::class);
        $ai->method('isEnabled')->willReturn(false);
        $ai->expects($this->never())->method('generateFormFromPrompt');
        $plans = $this->createMock(PlanService::class);
        $plans->expects($this->never())->method('checkAndIncrement');
        $controller = new AIController($ai, $this->createMock(DocumentConverter::class), [], null, $plans);

        foreach (['generateForm', 'generateAppPlan', 'generateScreen'] as $method) {
            $response = $controller->{$method}($this->post(['prompt' => 'A contact form']), new SlimResponse());
            $this->assertSame(503, $response->getStatusCode(), $method);
            $this->assertStringContainsString('Connect your AI', $this->message($response), $method);
        }
    }

    private function memberAdmin(): AppUserService
    {
        $users = $this->createMock(AppUserService::class);
        $users->method('hasPermission')->willReturn(true);
        $users->method('roleBelongsToApp')->willReturn(true);
        $users->method('groupBelongsToApp')->willReturn(true);
        return $users;
    }

    #[DataProvider('notText')]
    public function testARoleOrGroupNameThatIsntTextIsARefusal(mixed $name): void
    {
        $users = $this->memberAdmin();
        $users->expects($this->never())->method('createRole');
        $users->expects($this->never())->method('createGroup');
        $controller = new AppUserController($users, $this->createMock(AppService::class));

        $this->assertSame(400, $controller->createRole($this->post(['name' => $name]), new SlimResponse(), ['appId' => 'a'])->getStatusCode());
        $this->assertSame(400, $controller->createGroup($this->post(['name' => $name]), new SlimResponse(), ['appId' => 'a'])->getStatusCode());
        $this->assertSame(400, $controller->updateRole($this->post(['name' => $name]), new SlimResponse(), ['appId' => 'a', 'roleId' => 'r'])->getStatusCode());
        $this->assertSame(400, $controller->updateGroup($this->post(['name' => $name]), new SlimResponse(), ['appId' => 'a', 'id' => 'g'])->getStatusCode());
    }

    public function testANameAlreadyTakenIsSaidPlainlyAndTheDatabaseErrorStaysHidden(): void
    {
        $taken = new \PDOException("SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'x' for key 'unique_app_role'");
        $taken->errorInfo = ['23000', 1062, 'Duplicate entry'];
        $users = $this->memberAdmin();
        $users->method('createRole')->willThrowException($taken);
        $users->method('createGroup')->willThrowException($taken);
        $users->method('updateRole')->willThrowException($taken);
        $users->method('updateGroup')->willThrowException($taken);
        $controller = new AppUserController($users, $this->createMock(AppService::class));

        foreach ([
            $controller->createRole($this->post(['name' => 'Member']), new SlimResponse(), ['appId' => 'a']),
            $controller->createGroup($this->post(['name' => 'Team']), new SlimResponse(), ['appId' => 'a']),
            $controller->updateRole($this->post(['name' => 'Member']), new SlimResponse(), ['appId' => 'a', 'roleId' => 'r']),
            $controller->updateGroup($this->post(['name' => 'Team']), new SlimResponse(), ['appId' => 'a', 'id' => 'g']),
        ] as $response) {
            $this->assertSame(409, $response->getStatusCode());
            $this->assertStringContainsString('already has a', $this->message($response));
            $this->assertStringNotContainsString('SQLSTATE', (string) $response->getBody());
        }
    }

    public function testAnotherDatabaseFailureIsNotShownEither(): void
    {
        $users = $this->memberAdmin();
        $users->method('createRole')->willThrowException(new \PDOException('SQLSTATE[HY000]: General error: table is on fire'));
        $controller = new AppUserController($users, $this->createMock(AppService::class));

        $response = $controller->createRole($this->post(['name' => 'Member']), new SlimResponse(), ['appId' => 'a']);

        $this->assertSame(500, $response->getStatusCode());
        $this->assertStringNotContainsString('SQLSTATE', (string) $response->getBody());
    }

    public function testASecondSaveFromOneCopyLosesUnderTheHold(): void
    {
        $fields = [['id' => 'a', 'type' => 'short_text', 'label' => 'A']];
        $copy = FormService::fieldsRevision($fields);
        $forms = $this->createMock(FormService::class);
        // Both requests read the same copy, and the other save landed before this one got the hold.
        $forms->method('getForm')->willReturnOnConsecutiveCalls(
            ['id' => 'f1', 'userId' => 'user-1', 'fields' => $fields],
            ['id' => 'f1', 'userId' => 'user-1', 'fields' => [...$fields, ['id' => 'b', 'type' => 'short_text', 'label' => 'B']]],
        );
        $forms->expects($this->once())->method('holdFieldSaves')->willReturn('hold');
        $forms->expects($this->once())->method('releaseFieldSaves')->with('hold');
        $forms->expects($this->never())->method('updateForm');

        $response = (new FormController($forms))->update(
            $this->post(['fields' => [...$fields, ['id' => 'c', 'type' => 'short_text', 'label' => 'C']], 'expectedFieldsRevision' => $copy]),
            new SlimResponse(),
            ['id' => 'f1']
        );

        $this->assertSame(409, $response->getStatusCode());
        $this->assertStringContainsString('changed somewhere else', $this->message($response));
    }

    public function testASaveThatKeepsItsCopyGivesTheHoldBack(): void
    {
        $fields = [['id' => 'a', 'type' => 'short_text', 'label' => 'A']];
        $forms = $this->createMock(FormService::class);
        $forms->method('getForm')->willReturn(['id' => 'f1', 'userId' => 'user-1', 'fields' => $fields]);
        $forms->method('holdFieldSaves')->willReturn('hold');
        $forms->expects($this->once())->method('updateForm')->willThrowException(new \RuntimeException('no'));
        $forms->expects($this->once())->method('releaseFieldSaves')->with('hold');

        $response = (new FormController($forms))->update(
            $this->post(['fields' => $fields, 'expectedFieldsRevision' => FormService::fieldsRevision($fields)]),
            new SlimResponse(),
            ['id' => 'f1']
        );

        $this->assertSame(400, $response->getStatusCode(), 'the hold goes back when the save fails too');
    }

    public function testAnImageThatIsntAnImageIsNotAFailedGeneration(): void
    {
        $ai = $this->createMock(AIService::class);
        $ai->method('isEnabled')->willReturn(true);
        $ai->method('isConfigured')->willReturn(true);
        $ai->expects($this->never())->method('generateAppPlan');
        $controller = new AIController($ai, $this->createMock(DocumentConverter::class));

        $response = $controller->generateAppPlan($this->post(['prompt' => 'An app', 'image' => 'x']), new SlimResponse());

        $this->assertSame(400, $response->getStatusCode());
    }
}
