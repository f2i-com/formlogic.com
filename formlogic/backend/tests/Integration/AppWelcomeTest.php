<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * What the site's sign-in and sign-up pages show of an app (GET /api/app/{slug}/welcome): its name, logo or icon, its
 * look as design tokens and its owner's words, for the apps whose web app manifest is public, and nothing that could
 * restyle or reach out of the site's own page.
 */
final class AppWelcomeTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static AppPublicController $controller;

    /** @var string[] */
    private array $appIds = [];
    /** @var string[] */
    private array $userIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-welcome-' . bin2hex(random_bytes(5)));
        $forms = new FormService($conn, $sqlite);
        $responses = new ResponseService($conn, $sqlite);
        self::$apps = new AppService($conn, $forms);
        self::$controller = new AppPublicController(
            self::$apps,
            new AppUserService($conn),
            new AppResponseService($conn, $sqlite, $responses, null, $forms),
            $forms,
            $responses,
            $conn,
            $sqlite,
            new AppDomainService($conn)
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->appIds = $this->userIds = [];
    }

    public function testAPublishedAppGreetsVisitorsWithItsNameLookAndWords(): void
    {
        $owner = $this->makeUser();
        $app = $this->makeApp($owner, [
            'logoUrl' => '/api/files/logo.png',
            'theme' => ['primaryColor' => '#E11D48', 'fontFamily' => 'Georgia'],
            'settings' => ['allowSelfRegistration' => true, 'icon' => 'Moon', 'signInPage' => [
                'title' => "  Welcome back,\n night owl  ",
                'message' => "Tonight's line-up is inside.\n\n\n\nSee you there.",
                'layout' => 'centered',
                'panelColor' => '#123',
            ]],
        ]);
        self::$apps->publishApp($app['id'], null, $owner);

        $seen = $this->welcome(null, $app['slug']);
        self::assertSame(200, $seen['status']);
        self::assertSame([
            'app' => ['name' => $app['name'], 'slug' => $app['slug'], 'icon' => 'Moon', 'logo' => '/api/files/logo.png'],
            'look' => ['accent' => '#e11d48', 'font' => 'Georgia', 'panel' => '#112233', 'layout' => 'centered'],
            'text' => ['title' => 'Welcome back, night owl', 'message' => "Tonight's line-up is inside.\n\nSee you there."],
            'joining' => 'open',
        ], $seen['body']);
    }

    public function testOnlyAppsWhoseManifestIsPublicAnswerAndTheRestLookTheSame(): void
    {
        $owner = $this->makeUser();
        $draft = $this->makeApp($owner, []);
        $nobody = $this->welcome(null, 'no-such-app-' . bin2hex(random_bytes(3)));
        $hidden = $this->welcome(null, $draft['slug']);
        self::assertSame(404, $nobody['status']);
        self::assertSame([$nobody['status'], $nobody['body']], [$hidden['status'], $hidden['body']], 'a draft reads as no app at all');
        self::assertSame(404, $this->welcome($this->makeUser(), $draft['slug'])['status'], 'nor to someone else signed in');
        self::assertSame(200, $this->welcome($owner, $draft['slug'])['status'], 'its owner previews it');
        self::assertSame(404, $this->welcome(null, '../etc')['status']);
    }

    public function testWhatCouldRestyleOrReachOutOfThePageIsDroppedOnSaveAndOnRead(): void
    {
        $owner = $this->makeUser();
        $app = $this->makeApp($owner, ['settings' => ['signInPage' => [
            'title' => "Sign in\u{202E}evil\u{200B}",
            'message' => str_repeat('a', 400),
            'layout' => 'fullscreen',
            'panelColor' => 'url(https://evil.example/x)',
            'appFont' => 'yes',
            'css' => 'input[value^="a"] { background: url(https://evil.example/a) }',
        ]]]);
        $kept = self::$apps->getAppBySlug($app['slug'])['settings']['signInPage'];
        self::assertSame(['title' => 'Sign in evil', 'message' => str_repeat('a', 280)], $kept, 'only plain words survive saving');
        self::$apps->updateApp($app['id'], ['settings' => ['signInPage' => ['layout' => 'nope']]]);
        self::assertArrayNotHasKey('signInPage', self::$apps->getAppBySlug($app['slug'])['settings'], 'nothing left, nothing kept');

        // Written by another path, straight into the database: read again when served.
        $settings = json_encode(['allowSelfRegistration' => true, 'requireApproval' => true, 'icon' => '<svg onload=x>', 'signInPage' => [
            'title' => ['not' => 'text'], 'panelColor' => 'red;background:url(//evil.example)', 'layout' => 'split', 'appFont' => false,
        ]]);
        self::$pdo->prepare('UPDATE apps SET settings = ?, theme = ?, logo_url = ? WHERE id = ?')
            ->execute([$settings, json_encode(['primaryColor' => 'var(--x)', 'fontFamily' => 'Comic Sans; } * { color: red']), 'https://evil.example/logo.png', $app['id']]);
        self::$apps->publishApp($app['id'], null, $owner);
        $body = $this->welcome(null, $app['slug'])['body'];
        self::assertSame(['name' => $app['name'], 'slug' => $app['slug'], 'icon' => null, 'logo' => null], $body['app'], 'a logo from elsewhere is not loaded');
        self::assertSame(['accent' => null, 'font' => null, 'panel' => null, 'layout' => 'split'], $body['look']);
        self::assertSame(['title' => null, 'message' => null], $body['text']);
        self::assertSame('approval', $body['joining']);
    }

    public function testALogoIsShownOnlyFromThisSiteOrWrittenIntoItsAddress(): void
    {
        $logo = static fn (?string $url) => AppService::welcome(['name' => 'A', 'slug' => 'a', 'logoUrl' => $url])['app']['logo'];
        self::assertSame('/uploads/a.png', $logo('/uploads/a.png'));
        self::assertSame('data:image/png;base64,iVBORw0KGgo=', $logo('data:image/png;base64,iVBORw0KGgo='));
        foreach (['https://evil.example/a.png', '//evil.example/a.png', '/\\evil.example/a.png', 'javascript:alert(1)',
            'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', '/a.png" onerror="x', '/a b.png', null] as $bad) {
            self::assertNull($logo($bad), (string) $bad);
        }
        self::assertSame('invite', AppService::welcome(['name' => 'A', 'slug' => 'a'])['joining']);
    }

    /** @return array{status: int, body: array} */
    private function welcome(?string $userId, string $slug): array
    {
        $request = $this->createMock(ServerRequestInterface::class);
        $request->method('getAttribute')->willReturnCallback(fn ($name) => $name === 'userId' ? $userId : null);
        $out = self::$controller->welcome($request, new SlimResponse(), ['slug' => $slug]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    private function makeApp(string $owner, array $data): array
    {
        $app = self::$apps->createApp(['name' => 'Night Owls ' . bin2hex(random_bytes(3))] + $data, $owner);
        $this->appIds[] = (string) $app['id'];
        return $app;
    }

    private function makeUser(): string
    {
        $id = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }
}
