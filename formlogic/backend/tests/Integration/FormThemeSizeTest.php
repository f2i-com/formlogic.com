<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FormController;
use FormLogic\Services\FormVersionService;
use FormLogic\Services\PackService;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * A logo and a background image travel inside a form's theme as data: URLs, kept small by the
 * editor. At 10KB a real logo stopped the form saving, and publishing, altogether, because the
 * theme goes out in the same save as the title, the status and the script.
 */
final class FormThemeSizeTest extends E2eeTestCase
{
    private function controller(): FormController
    {
        return new FormController(self::$forms);
    }

    private function aForm(): string
    {
        return (string) self::$forms->createForm(['title' => 'Themed', 'userId' => $this->userId, 'status' => 'draft', 'fields' => []])['id'];
    }

    /** A theme holding $images pictures of $bytes characters of base64, as the editor stores them. */
    private function themeWith(int $images, int $bytes): array
    {
        $picture = 'data:image/jpeg;base64,' . str_repeat('AAA/', (int) ($bytes / 4));
        return ['primaryColor' => '#4f46e5', 'logo' => $picture] + ($images > 1 ? ['backgroundImage' => $picture] : []);
    }

    /** MySQL's JSON keeps its keys in an order of its own, and a failure here would print 400KB. */
    private function assertTheSameTheme(array $expected, array $actual, string $message = ''): void
    {
        ksort($expected);
        ksort($actual);
        $this->assertTrue($expected === $actual, $message ?: 'the theme came back changed');
    }

    /** @return array{0:int,1:array<string,mixed>} */
    private function save(string $formId, array $body): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('PUT', 'http://localhost/api/forms/' . $formId)
            ->withParsedBody($body)
            ->withAttribute('userId', $this->userId);
        $response = $this->controller()->update($request, (new ResponseFactory())->createResponse(), ['id' => $formId]);
        $response->getBody()->rewind();
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    public function testATwoImageThemeSavesWithWhatGoesOutBesideIt(): void
    {
        $formId = $this->aForm();
        $theme = $this->themeWith(2, 100 * 1024);

        [$status] = $this->save($formId, ['title' => 'Renamed', 'status' => 'published', 'theme' => $theme]);

        $this->assertSame(200, $status);
        $stored = self::$forms->getForm($formId);
        $this->assertSame('Renamed', $stored['title']);
        $this->assertSame('published', $stored['status']);
        $this->assertTheSameTheme($theme, $stored['theme'], 'what GET /api/public/forms/{id} serves, whole');
    }

    public function testATheOneThatWouldNotFitIsStillRefusedAndNothingElseIsLost(): void
    {
        $formId = $this->aForm();

        [$status, $body] = $this->save($formId, ['title' => 'Renamed', 'theme' => $this->themeWith(1, 300 * 1024)]);

        $this->assertSame(422, $status);
        $this->assertSame('Theme must be 256KB or smaller', $body['message']);
        $this->assertSame('Themed', self::$forms->getForm($formId)['title']);
    }

    /** The builder sends the theme with every save, so a limit that came down mustn't lock a form. */
    public function testAFormAlreadyHoldingALargerThemeCanStillBeSaved(): void
    {
        $formId = $this->aForm();
        self::$forms->updateForm($formId, ['theme' => $this->themeWith(2, 190 * 1024)]);
        $theme = self::$forms->getForm($formId)['theme'];

        [$status] = $this->save($formId, ['title' => 'Renamed', 'theme' => array_reverse($theme, true)]);

        $this->assertSame(200, $status);
        $this->assertSame('Renamed', self::$forms->getForm($formId)['title']);
        $this->assertTheSameTheme($theme, self::$forms->getForm($formId)['theme']);

        [$status, $body] = $this->save($formId, ['theme' => $this->themeWith(2, 195 * 1024)]);
        $this->assertSame(422, $status, 'a new one is held to the limit');
        $this->assertSame('Theme must be 256KB or smaller', $body['message']);
    }

    public function testAVersionKeepsTheThemeAndRestoresIt(): void
    {
        $formId = $this->aForm();
        $theme = $this->themeWith(2, 100 * 1024);
        $this->assertSame(200, $this->save($formId, ['theme' => $theme])[0]);

        $versions = new FormVersionService(self::$mysql, self::$forms);
        $version = $versions->createVersion($formId, $this->userId);
        $this->assertSame(200, $this->save($formId, ['theme' => ['primaryColor' => '#000000']])[0]);

        $versions->restoreVersion($formId, $version['version'], $this->userId);

        $this->assertTheSameTheme($theme, self::$forms->getForm($formId)['theme']);
    }

    public function testADuplicateKeepsIt(): void
    {
        $formId = $this->aForm();
        $theme = $this->themeWith(2, 100 * 1024);
        $this->assertSame(200, $this->save($formId, ['theme' => $theme])[0]);

        $copy = self::$forms->duplicateForm($formId, $this->userId);

        $this->assertTheSameTheme($theme, self::$forms->getForm((string) $copy['id'])['theme']);
    }

    public function testAPackHoldsAFormToTheSameLimit(): void
    {
        $pack = fn (array $theme): array => ['formatVersion' => 1, 'packMeta' => ['name' => 'Pack'], 'forms' => [['packFormId' => 'one', 'title' => 'One', 'fields' => [], 'theme' => $theme]]];

        PackService::validateDefinition($pack($this->themeWith(2, 100 * 1024)));

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('theme exceeds 256KB limit');
        PackService::validateDefinition($pack($this->themeWith(1, 300 * 1024)));
    }

    /** A private form's read names its revision too, or a list read from it is never checked. */
    public function testAPrivateFormsReadNamesItsFieldsRevision(): void
    {
        $formId = (string) $this->makeDraftForm($this->userId, [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]])['id'];
        $this->enablePrivateForm($formId);
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/api/forms/' . $formId)
            ->withAttribute('userId', $this->userId);
        $controller = new FormController(self::$forms, null, null, null, null, null, null, self::$encryption);

        $response = $controller->show($request, (new ResponseFactory())->createResponse(), ['id' => $formId]);

        $response->getBody()->rewind();
        $form = json_decode((string) $response->getBody(), true)['form'];
        $this->assertNotEmpty($form['encryption']);
        $this->assertNotEmpty($form['fieldsRevision']);
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
    }
}
