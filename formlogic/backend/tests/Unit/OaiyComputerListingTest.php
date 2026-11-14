<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\OaiyComputerController;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use FormLogic\Tests\Support\InMemoryAiRelay;
use FormLogic\Tests\Support\LinkedComputers;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * A computer's listings, as the routes answer them (OaiyComputerController, for the administrator's
 * pages and an app's "Use my OAIY"): asked at once with 202 and a handle, then read with it, 202
 * while the computer has not answered and 200 with the list once it has, no request ever waiting on
 * the computer. Only the person's own computer is asked, and only their own listing read back.
 */
final class OaiyComputerListingTest extends TestCase
{
    private const SECRET = 'oaiy-listing-test-secret-0123456789abcdef';

    private LinkedComputers $computers;
    private InMemoryAiRelay $relay;
    private SiteAiDesktopSettings $settings;
    private OaiyComputerController $controller;
    private string $desktopSecret = '';
    private string $owner = '';
    private string $other = '';
    private string $mine = '';
    private string $theirs = '';
    private string $log = '';

    protected function setUp(): void
    {
        $keys = sodium_crypto_box_keypair();
        $this->desktopSecret = sodium_crypto_box_secretkey($keys);
        $this->computers = new LinkedComputers();
        $this->owner = $this->computers->user('u-owner');
        $this->other = $this->computers->user('u-other');
        $this->mine = $this->computers->link($this->owner, 'inst-mine', base64_encode(sodium_crypto_box_publickey($keys)));
        $this->theirs = $this->computers->link($this->other, 'inst-theirs', base64_encode(random_bytes(32)));
        $this->settings = new SiteAiDesktopSettings($this->computers, sys_get_temp_dir() . '/oaiy-listing-' . bin2hex(random_bytes(4)) . '.json');
        $this->relay = new InMemoryAiRelay();
        $never = static function (): void {
            throw new \LogicException('a listing route never waits for the computer');
        };
        $this->controller = new OaiyComputerController($this->settings, new SiteDesktopAi($this->relay, $this->settings, $never, self::SECRET));
        $this->log = (string) tempnam(sys_get_temp_dir(), 'oaiy-listing-log-');
        ini_set('error_log', $this->log);
    }

    protected function tearDown(): void
    {
        ini_restore('error_log');
        @unlink($this->log);
    }

    /** GET a listing route as $user with $query: [status, body]. */
    private function get(string $route, string $user, array $query): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://127.0.0.1/api/admin/oaiy/' . $route)->withAttribute('userId', $user)->withQueryParams($query);
        $response = $route === 'providers' ? $this->controller->providers($request, new Response()) : $this->controller->models($request, new Response());
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    public function testAListingIsAskedWith202AndReadWith200OnceTheComputerAnswers(): void
    {
        [$status, $asked] = $this->get('providers', $this->owner, ['connectionId' => $this->mine]);
        $this->assertSame(202, $status);
        $handle = (string) $asked['listing'];
        [$id] = explode('.', $handle);
        $this->assertSame([['kind' => 'providers', 'owner' => $this->owner, 'requester' => $this->owner, 'laneCap' => SiteDesktopAi::MAX_WAITING]], $this->relay->enqueued);

        $this->assertSame([202, ['listing' => $handle]], $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $handle]), 'not answered yet');
        [, $pair] = $this->relay->claimAs($id, $this->desktopSecret);
        $this->assertSame([202, ['listing' => $handle]], $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $handle]), 'taken, not answered');
        $this->relay->answer($id, ['v' => 1, 'kind' => 'providers', 'providers' => [
            ['id' => 'oaiy-engine', 'label' => 'OAIY engine', 'model' => 'model-a'],
            ['id' => 'pictures-only', 'label' => 'Pictures', 'capabilities' => ['image']],
            ['id' => 'switched-off', 'label' => 'Off', 'enabled' => false],
        ]], 0, $pair);
        $this->relay->answer($id, ['v' => 1, 'kind' => 'final'], 1, $pair);
        $this->relay->finish($id);
        $this->assertSame([200, ['providers' => [['id' => 'oaiy-engine', 'label' => 'OAIY engine', 'model' => 'model-a']], 'engineProvider' => 'oaiy-engine']],
            $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $handle]), 'the providers that chat');
        $this->assertCount(1, $this->relay->enqueued, 'asked once, however often it was read');
    }

    public function testAProvidersModelsAreListedTheSameWay(): void
    {
        [$status, $asked] = $this->get('models', $this->owner, ['connectionId' => $this->mine, 'providerId' => 'oaiy-engine']);
        $this->assertSame(202, $status);
        [$id] = explode('.', (string) $asked['listing']);
        [$turn, $pair] = $this->relay->claimAs($id, $this->desktopSecret);
        $this->assertSame(['models', 'oaiy-engine'], [$turn['kind'], $turn['providerId']]);
        $this->relay->answer($id, ['v' => 1, 'kind' => 'final', 'models' => [['id' => 'model-a', 'name' => 'Model A', 'type' => 'image'], ['id' => 'model-b', 'type' => 'NOT A TYPE'], ['name' => 'no id']]], 0, $pair);
        $this->relay->finish($id);
        $this->assertSame([200, ['models' => [['id' => 'model-a', 'name' => 'Model A', 'type' => 'image'], ['id' => 'model-b', 'name' => 'model-b']]]],
            $this->get('models', $this->owner, ['connectionId' => $this->mine, 'providerId' => 'oaiy-engine', 'listing' => $asked['listing']]));
        $this->assertSame(400, $this->get('models', $this->owner, ['connectionId' => $this->mine])[0], 'a provider is named');
    }

    /**
     * `listing` is a handle or nothing: `listing[]=1` asked the computer anew on the reads' budget
     * (refused now, and nothing asked). And `letGo=1` with the handle lets an unanswered listing go
     * at once, for a page that stopped reading it; only its own handle does.
     */
    public function testAListingIsANameOrNothingAndThePageThatStopsReadingLetsItGo(): void
    {
        [$status, $body] = $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => ['1']]);
        $this->assertSame(400, $status);
        $this->assertSame('listing is the handle a listing was asked with.', $body['message']);
        $this->assertSame([], $this->relay->enqueued, 'nothing was asked of the computer');

        [, $asked] = $this->get('providers', $this->owner, ['connectionId' => $this->mine]);
        $handle = (string) $asked['listing'];
        [$id, $token] = explode('.', $handle);
        [$status] = $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $id . '.' . strrev($token), 'letGo' => '1']);
        $this->assertSame(400, $status, 'another token');
        $this->assertSame([], $this->relay->cancelled);
        $this->assertSame([200, ['letGo' => true]], $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $handle, 'letGo' => '1']));
        $this->assertSame([$id], $this->relay->cancelled, 'the computer is told to stop');
    }

    /** Owner isolation holds as before the listing was split in two: a handle carries no right to anything. */
    public function testOnlyThePersonsOwnComputerIsAskedAndOnlyTheirOwnListingReadBack(): void
    {
        [, $asked] = $this->get('providers', $this->owner, ['connectionId' => $this->mine]);
        $handle = (string) $asked['listing'];
        [$id] = explode('.', $handle);
        [, $pair] = $this->relay->claimAs($id, $this->desktopSecret);
        $this->relay->answer($id, ['v' => 1, 'kind' => 'final', 'providers' => [['id' => 'oaiy-engine', 'label' => 'Secret label']]], 0, $pair);
        $this->relay->finish($id);

        // Someone else names the owner's computer: refused before anything is asked of it.
        [$status, $body] = $this->get('providers', $this->other, ['connectionId' => $this->mine]);
        $this->assertSame([400, 'That computer is not linked to your account.'], [$status, $body['message']]);
        // With the owner's handle and their own computer: their own requests only, and this is not one.
        $this->relay->readAs = [];
        [$status, $body] = $this->get('providers', $this->other, ['connectionId' => $this->theirs, 'listing' => $handle]);
        $this->assertSame(502, $status);
        $this->assertStringNotContainsString('Secret label', json_encode($body));
        $this->assertSame([$this->other], array_values(array_unique($this->relay->readAs)), 'read as them, never as the owner');
        $this->assertCount(1, $this->relay->enqueued, 'nothing was asked of either computer for them');
        // The owner still reads it.
        $this->assertSame(200, $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $handle])[0]);
    }

    public function testAComputerThatFailsOrDoesNotAnswerInTimeIsSaid(): void
    {
        [, $asked] = $this->get('providers', $this->owner, ['connectionId' => $this->mine]);
        [$id] = explode('.', (string) $asked['listing']);
        $this->relay->claimAs($id, $this->desktopSecret);
        $this->relay->age($id, SiteDesktopAi::LISTING_SECONDS);
        [$status, $body] = $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $asked['listing']]);
        $this->assertSame([502, 'That computer did not answer: That computer took too long to answer.'], [$status, $body['message']]);
        $this->assertSame([$id], $this->relay->cancelled, 'and it was told to stop');

        $this->computers->goOffline($this->mine);
        [$status, $body] = $this->get('providers', $this->owner, ['connectionId' => $this->mine]);
        $this->assertSame([503, 'site_ai_offline', 'That computer is offline. Open OAIY on it, then try again.'], [$status, $body['code'], $body['message']]);
    }

    public function testADatabaseFailureIsLoggedAndNotShown(): void
    {
        [, $asked] = $this->get('providers', $this->owner, ['connectionId' => $this->mine]);
        $this->relay->failRead = new \PDOException('SQLSTATE[42S02]: Base table or view not found: 1146 Table \'formlogic.desktop_ai_requests\' doesn\'t exist');
        [$status, $body] = $this->get('providers', $this->owner, ['connectionId' => $this->mine, 'listing' => $asked['listing']]);
        $this->assertSame([500, 'The computer could not be asked just now. Try again in a moment.'], [$status, $body['message']]);
        $this->assertStringNotContainsString('SQLSTATE', json_encode($body));
        $this->assertStringContainsString('SQLSTATE[42S02]', (string) file_get_contents($this->log), 'logged for the administrator');
    }
}
