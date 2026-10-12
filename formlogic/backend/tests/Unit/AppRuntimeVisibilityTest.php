<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The pure lifecycle policy, without constructing a database connection. */
final class AppRuntimeVisibilityTest extends TestCase
{
    public static function visibilityCases(): iterable
    {
        foreach (['published', 'draft', 'archived', 'unknown', null] as $status) {
            foreach (['owner', 'member', '', null] as $user) {
                yield ($status ?? 'missing') . '/' . ($user === null ? 'anonymous' : ($user ?: 'empty')) => [
                    $status, $user, $status === 'published' || ($status === 'draft' && $user === 'owner'),
                ];
            }
        }
    }

    #[DataProvider('visibilityCases')]
    public function testRuntimeVisibility(?string $status, ?string $user, bool $expected): void
    {
        $apps = $this->getMockBuilder(AppService::class)->disableOriginalConstructor()->onlyMethods([])->getMock();
        $app = ['id' => 'app-id', 'ownerId' => 'owner'];
        if ($status !== null) $app['status'] = $status;
        $this->assertSame($expected, $apps->isRuntimeVisible($app, $user));
    }
}
