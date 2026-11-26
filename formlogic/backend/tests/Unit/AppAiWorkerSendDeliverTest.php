<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppAiWorker;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use FormLogic\Tests\Support\InMemoryAiRelay;
use FormLogic\Tests\Support\LinkedComputers;
use PHPUnit\Framework\TestCase;

/**
 * App AI's worker as far as one job, with no database (a connection double that keeps what each
 * statement is given): whose share of the site's workers a delivery is counted in, and what a job
 * is told when it is too large to send. The worker's whole run, queue and computers are
 * AppAiWorkerTest's (MySQL).
 */
final class AppAiWorkerSendDeliverTest extends TestCase
{
    private const MANIFEST = [
        'name' => 'Logo maker', 'main' => 'ui/main.ui',
        'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'database' => ['kind' => 'private-sqlite'],
            'routes' => [
                ['path' => '/api/site/ai/deliver', 'method' => 'POST', 'handler' => 'deliver'],
                ['path' => '/api/site/ai/parts', 'method' => 'POST', 'handler' => 'parts'],
            ]],
        'formlogicAi' => ['uses' => ['chat'], 'purpose' => 'Talks logos through.', 'jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver', 'parts' => '/api/site/ai/parts']],
    ];

    /** @var list<array{sql: string, params: array<int|string, mixed>}> */
    private array $statements = [];

    /** @param array<string, mixed> $asked what a job asks (its prompt and picture), read by id as the worker sends it */
    private function connection(array $asked = []): MySQLConnection
    {
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturnCallback(function (string $sql) use ($asked): \PDOStatement {
            $statement = $this->createMock(\PDOStatement::class);
            $statement->method('execute')->willReturnCallback(function (?array $params = null) use ($sql): bool {
                $this->statements[] = ['sql' => $sql, 'params' => $params ?? []];
                return true;
            });
            // The app's owner, and what a job asks, are the rows read here.
            $statement->method('fetchColumn')->willReturn(str_contains($sql, 'FROM apps') ? 'owner-1' : false);
            $statement->method('fetch')->willReturn(str_contains($sql, 'SELECT prompt, reference FROM app_ai_jobs') ? $asked : false);
            $statement->method('rowCount')->willReturn(1);
            return $statement;
        });
        $mysql = $this->createMock(MySQLConnection::class);
        $mysql->method('getConnection')->willReturn($pdo);
        return $mysql;
    }

    /** @param array<string, mixed> $parts the worker's other parts, by property */
    private function worker(NativeAppService $native, array $parts = [], array $asked = []): AppAiWorker
    {
        $worker = (new \ReflectionClass(AppAiWorker::class))->newInstanceWithoutConstructor();
        foreach (['mysql' => $this->connection($asked), 'native' => $native, 'results' => sys_get_temp_dir(), 'logger' => null, 'encryption' => null] + $parts as $name => $value) {
            (new \ReflectionProperty(AppAiWorker::class, $name))->setValue($worker, $value);
        }
        return $worker;
    }

    /**
     * The host, writing down in order each account it is told an app is for and each request.
     *
     * @return array{0: NativeAppService, 1: \ArrayObject<int, array{0: string, 1: string, 2: string}>}
     */
    private function host(): array
    {
        $calls = new \ArrayObject();
        $native = $this->createMock(NativeAppService::class);
        $native->method('installedManifest')->willReturn(self::MANIFEST);
        $native->method('ownedBy')->willReturnCallback(static function (string $appId, string $owner) use ($calls): void {
            $calls[] = ['ownedBy', $appId, $owner];
        });
        $native->method('request')->willReturnCallback(static function (string $appId, array $request) use ($calls): array {
            $calls[] = ['request', $appId, (string) $request['path']];
            return ['status' => 200, 'body' => []];
        });
        return [$native, $calls];
    }

    private static function call(AppAiWorker $worker, string $method, mixed ...$arguments): mixed
    {
        return (new \ReflectionMethod(AppAiWorker::class, $method))->invoke($worker, ...$arguments);
    }

    /**
     * A delivery and a part each run in one of the site's workers, counted in the app's owner's
     * share of them: the worker names the owner first, as the app's page and its API do. It named
     * nobody, so a delivery was counted for whichever account a page or the API had last named,
     * and for none where nothing had (a server moved, or its storage folder cleared).
     */
    public function testADeliveryAndAPartAreCountedForTheAppsOwner(): void
    {
        [$native, $calls] = $this->host();
        $worker = $this->worker($native);
        $job = ['id' => 'job-1', 'app_id' => 'app-1', 'app_job_id' => 'row-7', 'status' => 'failed', 'code' => 'engine_failed', 'message' => 'The AI failed.',
            'requester_kind' => 'nobody', 'requester_id' => '', 'delivery_attempts' => 0, 'result_path' => null, 'follow_up_of' => null];

        $this->assertTrue(self::call($worker, 'deliverOne', $job));
        $this->assertSame([['ownedBy', 'app-1', 'owner-1'], ['request', 'app-1', '/api/site/ai/deliver']], iterator_to_array($calls));

        $calls->exchangeArray([]);
        $this->assertTrue(self::call($worker, 'part', ['status' => 'running'] + $job, 0, ['text' => 'Hel']));
        $this->assertSame([['ownedBy', 'app-1', 'owner-1'], ['request', 'app-1', '/api/site/ai/parts']], iterator_to_array($calls));

        // The owner is read once in half a minute, not for every part of an answer.
        $read = array_filter($this->statements, static fn (array $s): bool => str_contains($s['sql'], 'SELECT owner_id FROM apps'));
        $this->assertCount(1, $read);
        $this->assertSame(['app-1'], array_values($read)[0]['params']);
    }

    /**
     * A turn too large for a computer's AI lane (256 KiB sealed) is failed by what made it so, as
     * SiteDesktopAi says it. An App AI chat is text alone, and every one was told "The picture to
     * edit is too large to send". The site's AI here is an administrator's computer, held in
     * SQLite (LinkedComputers); its lane, in memory.
     */
    public function testAChatTooLargeForTheLaneIsToldItIsTheChat(): void
    {
        $computers = new LinkedComputers();
        $admin = $computers->user('u-admin', true);
        $connection = $computers->link($admin, 'inst-site-ai', base64_encode(sodium_crypto_box_publickey(sodium_crypto_box_keypair())));
        $settingsPath = sys_get_temp_dir() . '/app-ai-send-' . bin2hex(random_bytes(6)) . '.json';
        $settings = new SiteAiDesktopSettings($computers, $settingsPath);
        $settings->choose($admin, $connection);
        try {
            $relay = new InMemoryAiRelay();
            $site = $this->createMock(AppAiSiteSettings::class);
            $site->method('current')->willReturn([]);
            $ai = $this->createMock(AppAiService::class);
            $ai->method('refund')->willReturn(true);
            [$native] = $this->host();
            // 64,000 characters, the most an administrator lets a chat hold (AppAiSiteSettings::CHAT_MAX_INPUT):
            // a line separator is written as   even unescaped, six bytes a character, past the lane.
            $chat = [['role' => 'user', 'content' => str_repeat("\u{2028}", AppAiSiteSettings::CHAT_MAX_INPUT[1])]];
            $worker = $this->worker($native, ['desktop' => new SiteDesktopAi($relay, $settings), 'site' => $site, 'ai' => $ai],
                ['prompt' => json_encode($chat, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'reference' => null]);
            $job = ['id' => 'job-3', 'app_id' => 'app-1', 'kind' => 'chat', 'seed' => null, 'size' => null, 'max_output' => null];
            $route = ['kind' => 'oaiy', 'target' => $settings->current(), 'availability' => ['source' => 'site'], 'ownerId' => 'owner-1', 'chatModel' => null, 'pictureModel' => null];

            $this->assertSame('skip', self::call($worker, 'sendOne', $job, $route));
            $failed = array_values(array_filter($this->statements, static fn (array $s): bool => str_contains($s['sql'], "SET status = 'failed'")));
            $this->assertCount(1, $failed);
            $this->assertSame(['too_large', 'The chat is too long to send: the AI takes about 250 KB a request. Send fewer or shorter messages.'], array_slice($failed[0]['params'], 0, 2));
            $this->assertSame([], $relay->requests, 'nothing too large was queued');
        } finally {
            @unlink($settingsPath);
        }
    }
}
