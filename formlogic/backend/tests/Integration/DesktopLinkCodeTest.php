<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\DesktopLinkController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AuditService;
use FormLogic\Services\DesktopLinkCodeService;
use FormLogic\Services\DesktopLinkIssuer;
use FormLogic\Services\FlowService;
use FormLogic\Services\McpOAuthService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\Response;

/**
 * Linking an OAIY server with a one-time code (App AI contract §2): the code links the server as the
 * browser link does, answering byte for byte what its token exchange answers, once; an unknown,
 * expired or spent code answers as one; and the scope is what was chosen when the code was made.
 */
final class DesktopLinkCodeTest extends TestCase
{
    private const SECRET = 'desktop-link-test-secret-0123456789';
    /** The browser link's token answer (McpOAuthController::issueDesktopKey), field for field, in order. */
    private const TOKEN_FIELDS = ['access_token', 'token_type', 'scope', 'formlogic_api_key', 'api_key_id', 'desktop_connection_id', 'device_name'];

    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static array $config = [];
    private DesktopLinkController $controller;
    private ApiKeyService $keys;
    /** @var string[] */
    private array $users = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1', 'port' => $_ENV['DB_PORT'] ?? '3306', 'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root', 'password' => $_ENV['DB_PASSWORD'] ?? '', 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        $this->keys = new ApiKeyService(self::$mysql);
        $service = new DesktopLinkCodeService(self::$mysql, new DesktopLinkIssuer($this->keys, new FlowService(self::$mysql)), $this->keys, self::SECRET);
        $this->controller = new DesktopLinkController($service, new AuditService(self::$mysql, null, 'audit-test-key-0123456789abcdef'));
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) return;
        foreach ($this->users as $id) {
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$id]);
            self::$pdo->prepare('DELETE FROM api_keys WHERE user_id = ?')->execute([$id]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
        }
        $this->users = [];
    }

    private function user(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Owner')")->execute([$id, $id . '@test.local']);
        return $this->users[] = $id;
    }

    private function start(string $userId, array $body = []): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/desktop-links/codes')->withParsedBody($body)->withAttribute('userId', $userId);
        $response = $this->controller->start($request, new Response());
        return ['status' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true)];
    }

    private function redeem(array $fields, bool $form = false): array
    {
        $stream = (new StreamFactory())->createStream($form ? http_build_query($fields) : json_encode($fields));
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/oauth/oaiy-link', ['REMOTE_ADDR' => '198.51.100.4'])
            ->withHeader('Content-Type', $form ? 'application/x-www-form-urlencoded' : 'application/json')->withBody($stream);
        $response = $this->controller->redeem($request, new Response());
        return ['status' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true), 'raw' => (string) $response->getBody(), 'cache' => $response->getHeaderLine('Cache-Control')];
    }

    private function codeStatus(string $userId, string $id): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/')->withAttribute('userId', $userId);
        $response = $this->controller->status($request, new Response(), ['id' => $id]);
        return ['status' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true)];
    }

    public function testACodeLinksAServerAsTheBrowserLinkDoes(): void
    {
        $user = $this->user();
        $started = $this->start($user, ['deviceName' => 'Studio']);
        $this->assertSame(201, $started['status'], json_encode($started['body']));
        $data = $started['body']['data'];
        $this->assertMatchesRegularExpression('/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/D', $data['code'], 'twelve characters without look-alikes');
        $this->assertSame('ai', $data['scope'], 'AI only unless asked');
        $this->assertSame('oaiy-server link --code ' . $data['code'] . ' --base-url https://formlogic.example', $data['command']);
        $this->assertEqualsWithDelta(time() + 600, strtotime($data['expiresAt']), 5, 'ten minutes');
        $this->assertSame('waiting', $this->codeStatus($user, $data['id'])['body']['data']['status']);

        $linked = $this->redeem(['code' => $data['code'], 'device_name' => 'rack-2']);
        $this->assertSame(200, $linked['status'], $linked['raw']);
        $this->assertSame(self::TOKEN_FIELDS, array_keys($linked['body']), 'exactly the browser link\'s answer');
        $this->assertSame('no-store', $linked['cache']);
        $body = $linked['body'];
        $this->assertSame([$body['access_token'], 'Bearer', 'connector:relay'], [$body['formlogic_api_key'], $body['token_type'], $body['scope']]);
        $this->assertSame('OAIY server on rack-2', $body['device_name'], 'the server\'s own --name');
        $connection = self::$pdo->prepare('SELECT owner_user_id, desktop_instance_id, api_key_id FROM desktop_connections WHERE id = ?');
        $connection->execute([$body['desktop_connection_id']]);
        $row = $connection->fetch(PDO::FETCH_ASSOC);
        $this->assertSame($user, $row['owner_user_id']);
        $this->assertStringStartsWith('oauth-', $row['desktop_instance_id'], 'an ordinary linked computer until its first check-in');
        $this->assertSame($body['api_key_id'], $row['api_key_id']);
        $key = $this->keys->validateKey($body['formlogic_api_key']);
        $this->assertSame(['connector:relay'], $key['scopes'], 'AI only: the lane and check-ins, nothing else');
        $this->assertTrue($key['aiOnly'], 'marked, so the surfaces it may not use refuse it whatever older links with this scope may do');
        $this->assertTrue($this->middlewareSees($body['formlogic_api_key'])['apiKeyAiOnly'], 'ApiKeyMiddleware hands the mark on');
        $status = $this->codeStatus($user, $data['id'])['body']['data'];
        $this->assertSame(['linked', $body['desktop_connection_id'], 'OAIY server on rack-2'], [$status['status'], $status['connectionId'], $status['deviceName']]);
        // Unlinked since: the code says so, rather than linked to a computer that is gone.
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE id = ?')->execute([$body['desktop_connection_id']]);
        $gone = $this->codeStatus($user, $data['id'])['body']['data'];
        $this->assertSame(['unlinked', $body['desktop_connection_id']], [$gone['status'], $gone['connectionId']]);
        $this->assertStringContainsString('unlinked', $gone['message']);
        $audit = self::$pdo->prepare("SELECT action FROM audit_log WHERE user_id = ? AND action LIKE 'desktop.link_code.%' ORDER BY sequence_number");
        $audit->execute([$user]);
        $this->assertSame(['desktop.link_code.create', 'desktop.link_code.redeem'], $audit->fetchAll(PDO::FETCH_COLUMN));
    }

    public function testEverythingADesktopCanDoWhenThatWasChosen(): void
    {
        $data = $this->start($this->user(), ['scope' => 'all'])['body']['data'];
        $linked = $this->redeem(['code' => strtolower(str_replace('-', ' ', $data['code']))], true);
        $this->assertSame(200, $linked['status'], 'a form body, lower case, spaced: the same code');
        $this->assertSame(implode(' ', McpOAuthService::DESKTOP_SCOPES), $linked['body']['scope']);
        $this->assertSame('OAIY server', $linked['body']['device_name'], 'no name given: the runtime\'s');
        $this->assertFalse($this->keys->validateKey($linked['body']['formlogic_api_key'])['aiOnly']);
        $this->assertFalse($this->middlewareSees($linked['body']['formlogic_api_key'])['apiKeyAiOnly'], 'an ordinary linked computer');
    }

    /** The attributes the real ApiKeyMiddleware gives a request carrying $key. */
    private function middlewareSees(string $key): array
    {
        $seen = [];
        $handler = new class ($seen) implements \Psr\Http\Server\RequestHandlerInterface {
            public function __construct(private array &$seen) {}
            public function handle(\Psr\Http\Message\ServerRequestInterface $request): \Psr\Http\Message\ResponseInterface
            {
                $this->seen = $request->getAttributes();
                return new Response();
            }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://formlogic.example/api/v1/desktop-ai/pending')->withHeader('Authorization', 'Bearer ' . $key);
        (new \FormLogic\Middleware\ApiKeyMiddleware($this->keys, []))->process($request, $handler);
        return $seen;
    }

    public function testACodeWorksOnceAndAnUnknownExpiredOrSpentOneAnswersAlike(): void
    {
        $user = $this->user();
        $first = $this->start($user)['body']['data'];
        $this->assertSame(200, $this->redeem(['code' => $first['code']])['status']);
        $spent = $this->redeem(['code' => $first['code']]);
        $expired = $this->start($user)['body']['data'];
        self::$pdo->prepare('UPDATE desktop_link_codes SET expires_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 1), $expired['id']]);
        $late = $this->redeem(['code' => $expired['code']]);
        $unknown = $this->redeem(['code' => 'ABCD-EFGH-JKMN']);
        $garbage = $this->redeem(['code' => 'not a code']);
        foreach ([$spent, $late, $unknown, $garbage] as $answer) {
            $this->assertSame(400, $answer['status']);
            $this->assertSame(['error' => 'invalid_grant', 'error_description' => 'That code is not valid. Start again from FormLogic.'], $answer['body']);
        }
        $this->assertSame('expired', $this->codeStatus($user, $expired['id'])['body']['data']['status']);
    }

    public function testCodesRedeemedAtOnceLinkOneServer(): void
    {
        $code = $this->start($this->user())['body']['data']['code'];
        $startAt = microtime(true) + 1.5;
        $job = json_encode(['mysql' => self::$config, 'secret' => self::SECRET, 'code' => $code, 'startAt' => $startAt]);
        $processes = [];
        foreach (range(1, 4) as $n) {
            $processes[] = proc_open([PHP_BINARY, dirname(__DIR__) . '/Support/AppAiParallelWorker.php', 'redeem-link', $job], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $outputs[] = $pipes;
        }
        $answers = [];
        foreach ($processes as $index => $process) {
            $answers[] = json_decode((string) stream_get_contents($outputs[$index][1]), true);
            proc_close($process);
        }
        $ok = array_values(array_filter($answers, static fn($answer) => ($answer['ok'] ?? false) === true));
        $this->assertCount(1, $ok, json_encode($answers));
        $this->assertCount(3, array_filter($answers, static fn($answer) => ($answer['error'] ?? null) === 'desktop_link_invalid'), json_encode($answers));
    }

    public function testThreeCodesMayWaitAndAStrangersCodeIsNotTheirs(): void
    {
        $user = $this->user();
        foreach (range(1, 3) as $n) $this->assertSame(201, $this->start($user)['status']);
        $fourth = $this->start($user);
        $this->assertSame([409, 'desktop_link_too_many'], [$fourth['status'], $fourth['body']['code'] ?? null]);
        $bad = $this->start($user, ['scope' => 'root']);
        $this->assertSame(400, $bad['status']);
        $mine = $this->start($this->user())['body']['data'];
        $this->assertSame(404, $this->codeStatus($user, $mine['id'])['status']);
    }

    public function testTheDemoAndAnAdministratorActingAsSomeoneCannotLink(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/')->withParsedBody([])->withAttribute('userId', $this->user())->withAttribute('adminActorId', 'admin-1');
        $this->assertSame(403, $this->controller->start($request, new Response())->getStatusCode());
    }

    public function testTheBrowserLinkAndTheServerLinkShareOneIssuer(): void
    {
        $controller = (string) file_get_contents(dirname(__DIR__, 2) . '/src/Controllers/McpOAuthController.php');
        $this->assertStringContainsString('DesktopLinkIssuer::tokenBody(', $controller, 'the browser link answers through the shared issuer');
        $this->assertStringContainsString('->issue(', $controller);
    }
}
