<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Support\CsvUpload;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-16 — CSV import rides the canonical response validation pipeline:
 * required fields, choice enums, ranges, and email rules apply exactly as they
 * do on the API/MCP write paths; invalid rows are never inserted (structured
 * per-row errors instead); calculated/unknown columns are stripped. Skipped
 * without a test DB.
 */
class CsvImportValidationTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $formService;
    private static ResponseService $responses;
    private static SQLiteConnection $sqlite;

    private string $userId = '';
    private string $formId = '';
    /** @var array[] */
    private array $fields = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-csvimport-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);

        $this->fields = [
            ['id' => 'email', 'type' => 'email', 'label' => 'Email', 'required' => true, 'order' => 0, 'properties' => []],
            ['id' => 'age', 'type' => 'number', 'label' => 'Age', 'required' => false, 'order' => 1, 'properties' => ['min' => 0, 'max' => 120]],
            ['id' => 'color', 'type' => 'dropdown', 'label' => 'Color', 'required' => false, 'order' => 2, 'properties' => [
                'options' => [
                    ['value' => 'opt_red', 'label' => 'Red'],
                    ['value' => 'opt_blue', 'label' => 'Blue'],
                ],
            ]],
            ['id' => 'total', 'type' => 'calculated', 'label' => 'Total', 'required' => false, 'order' => 3, 'properties' => []],
        ];
        $form = self::$formService->createForm([
            'user_id' => $this->userId,
            'title' => 'Import Target',
            'status' => 'published',
            'fields' => $this->fields,
        ]);
        $this->formId = $form['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach (array_filter([$this->formId, ...$this->roundTripForms]) as $formId) {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$formId]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$formId]);
        }
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** @return array{created:int, skipped:int, total:int, errors:array} */
    private function import(array $rows): array
    {
        $mapping = ['Email' => 'email', 'Age' => 'age', 'Color' => 'color', 'Total' => 'total'];
        return self::$responses->importResponses($this->formId, $rows, $mapping, $this->fields);
    }

    private function storedAnswers(): array
    {
        $db = self::$sqlite->getFormDatabase($this->formId);
        $rows = $db->query('SELECT answers FROM responses ORDER BY submitted_at ASC')->fetchAll(PDO::FETCH_COLUMN);
        return array_map(static fn ($json) => json_decode((string) $json, true), $rows);
    }

    public function testValidRowsNormalizeLikeApiSubmissionAndCalculatedIsStripped(): void
    {
        $result = $this->import([
            ['Email' => 'a@test.local', 'Age' => '42', 'Color' => 'opt_red', 'Total' => 'should-not-store'],
        ]);
        $this->assertSame(1, $result['created']);
        $this->assertSame(0, $result['skipped']);

        $stored = $this->storedAnswers();
        $this->assertCount(1, $stored);
        $this->assertSame('a@test.local', $stored[0]['email']);
        $this->assertSame(42.0, (float) $stored[0]['age']);
        $this->assertSame('opt_red', $stored[0]['color']);
        $this->assertArrayNotHasKey('total', $stored[0], 'calculated columns are computed, never stored raw');
    }

    public function testInvalidRowsAreNeverInsertedAndReportStructuredErrors(): void
    {
        $result = $this->import([
            ['Email' => '', 'Age' => '30', 'Color' => 'opt_red', 'Total' => ''],          // missing required
            ['Email' => 'not-an-email', 'Age' => '30', 'Color' => 'opt_red', 'Total' => ''], // bad email
            ['Email' => 'b@test.local', 'Age' => '999', 'Color' => 'opt_red', 'Total' => ''], // out of range
            ['Email' => 'c@test.local', 'Age' => '30', 'Color' => 'purple', 'Total' => ''],   // enum violation
            ['Email' => 'd@test.local', 'Age' => 'NaNful', 'Color' => 'opt_blue', 'Total' => ''], // non-numeric number
            ['Email' => 'ok@test.local', 'Age' => '25', 'Color' => 'opt_blue', 'Total' => ''],    // valid
        ]);

        $this->assertSame(1, $result['created'], 'only the valid row may be inserted');
        $this->assertSame(5, $result['skipped']);
        $this->assertCount(5, $result['errors']);
        foreach ($result['errors'] as $error) {
            $this->assertIsInt($error['row']);
            $this->assertNotEmpty($error['errors']);
        }

        $stored = $this->storedAnswers();
        $this->assertCount(1, $stored);
        $this->assertSame('ok@test.local', $stored[0]['email']);

        // The MySQL metadata mirror agrees (no orphaned/invisible records).
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM response_metadata WHERE form_id = ?');
        $count->execute([$this->formId]);
        $this->assertSame(1, (int) $count->fetchColumn());
    }

    /**
     * A record through the real export and back through the real import, as the wizard maps it: each
     * column to the first field with that label not already taken.
     *
     * @param array<int, array> $fields
     * @param array<string, mixed> $answers
     * @return array{result:array, copy:array<string, mixed>, csv:string}
     */
    private function roundTrip(array $fields, array $answers): array
    {
        $formId = self::$formService->createForm(['user_id' => $this->userId, 'title' => 'Round trip', 'status' => 'published', 'fields' => $fields])['id'];
        $this->roundTripForms[] = $formId;
        $original = self::$responses->createResponse($formId, ['answers' => $answers]);

        $out = fopen('php://memory', 'w+');
        self::$responses->exportResponsesStreaming($formId, $fields, $out);
        rewind($out);
        $csv = (string) stream_get_contents($out);
        fclose($out);

        $table = CsvUpload::parse($csv);
        $taken = [];
        $mapping = [];
        foreach ($table['headers'] as $column => $heading) {
            foreach ($fields as $field) {
                if ($field['label'] === $heading && !isset($taken[$field['id']])) {
                    $taken[$field['id']] = true;
                    $mapping[$column] = $field['id'];
                    break;
                }
            }
        }

        $result = self::$responses->importResponses($formId, $table['rows'], $mapping, $fields);
        $db = self::$sqlite->getFormDatabase($formId);
        $stmt = $db->prepare('SELECT answers FROM responses WHERE id != ?');
        $stmt->execute([$original['id']]);
        $copy = $stmt->fetchColumn();
        return ['result' => $result, 'copy' => $copy === false ? [] : json_decode((string) $copy, true), 'csv' => $csv];
    }

    /** @var string[] */
    private array $roundTripForms = [];

    private static function options(string ...$labels): array
    {
        return array_map(static fn (int $i, string $label): array => ['id' => "o{$i}", 'value' => 'option_' . ($i + 1), 'label' => $label], array_keys($labels), $labels);
    }

    public function testChoicesComeBackByLabelThoughTheOptionsAreNumberedInside(): void
    {
        $fields = [
            ['id' => 'drop', 'type' => 'dropdown', 'label' => 'Topic', 'order' => 0, 'properties' => ['options' => self::options('Sales Question', 'Support')]],
            ['id' => 'pick', 'type' => 'multiple_choice', 'label' => 'Size', 'order' => 1, 'properties' => ['options' => self::options('Small', 'Large')]],
            ['id' => 'many', 'type' => 'checkboxes', 'label' => 'Colours', 'order' => 2, 'properties' => ['options' => self::options('Red', 'Red, dark', 'Blue')]],
        ];

        $trip = $this->roundTrip($fields, ['drop' => 'option_2', 'pick' => 'option_1', 'many' => ['option_2', 'option_3']]);

        $this->assertSame(1, $trip['result']['created'], json_encode($trip['result']['errors']));
        $this->assertSame('option_2', $trip['copy']['drop']);
        $this->assertSame('option_1', $trip['copy']['pick']);
        $this->assertSame(['option_2', 'option_3'], $trip['copy']['many'], 'a label with a comma in it stays one option');
    }

    public function testACellMayStillHoldTheOptionValueAndALabelNamingAnotherValueWins(): void
    {
        $fields = [
            ['id' => 'drop', 'type' => 'dropdown', 'label' => 'Topic', 'order' => 0, 'properties' => ['options' => [
                ['value' => 'a', 'label' => 'b'],
                ['value' => 'b', 'label' => 'Bee'],
                ['value' => 'c', 'label' => 'Sea'],
            ]]],
            ['id' => 'many', 'type' => 'checkboxes', 'label' => 'Tags', 'order' => 1, 'properties' => ['options' => self::options('One', 'Two')]],
        ];
        $formId = self::$formService->createForm(['user_id' => $this->userId, 'title' => 'Values', 'status' => 'published', 'fields' => $fields])['id'];
        $this->roundTripForms[] = $formId;

        $result = self::$responses->importResponses($formId, [
            ['c', 'option_1, option_2'],
            ['b', 'One,Two'],
        ], [0 => 'drop', 1 => 'many'], $fields);

        $this->assertSame(2, $result['created'], json_encode($result['errors']));
        $rows = self::$sqlite->getFormDatabase($formId)->query('SELECT answers FROM responses')->fetchAll(PDO::FETCH_COLUMN);
        $answers = array_map(static fn ($json) => json_decode((string) $json, true), $rows);
        $byDrop = array_column($answers, 'many', 'drop');
        $this->assertSame(['option_1', 'option_2'], $byDrop['c']);
        $this->assertSame(['option_1', 'option_2'], $byDrop['a'], 'the export wrote label "b" for value "a"');
    }

    public function testALabelTwoOptionsShareIsRefusedRatherThanGuessed(): void
    {
        $fields = [['id' => 'drop', 'type' => 'dropdown', 'label' => 'Topic', 'order' => 0, 'properties' => ['options' => self::options('Same', 'Same')]]];
        $formId = self::$formService->createForm(['user_id' => $this->userId, 'title' => 'Twice', 'status' => 'published', 'fields' => $fields])['id'];
        $this->roundTripForms[] = $formId;

        $result = self::$responses->importResponses($formId, [['Same'], ['option_2']], [0 => 'drop'], $fields);

        $this->assertSame(1, $result['created']);
        $this->assertSame([['row' => 1, 'errors' => ["Field 'Topic': Invalid selection"]]], $result['errors']);
    }

    public function testACellThatMatchesNoOptionIsStillRefused(): void
    {
        $fields = [['id' => 'many', 'type' => 'checkboxes', 'label' => 'Tags', 'order' => 0, 'properties' => ['options' => self::options('One', 'Two')]]];
        $formId = self::$formService->createForm(['user_id' => $this->userId, 'title' => 'Refused', 'status' => 'published', 'fields' => $fields])['id'];
        $this->roundTripForms[] = $formId;

        $result = self::$responses->importResponses($formId, [['One, Three']], [0 => 'many'], $fields);

        $this->assertSame(0, $result['created']);
        $this->assertSame([['row' => 1, 'errors' => ["Field 'Tags': Invalid selection"]]], $result['errors']);
    }

    public function testTheApostropheTheExportAddedComesOffAnAnswer(): void
    {
        $fields = [
            ['id' => 'phone', 'type' => 'phone', 'label' => 'Phone', 'order' => 0, 'properties' => []],
            ['id' => 'text', 'type' => 'short_text', 'label' => 'Note', 'order' => 1, 'properties' => []],
            ['id' => 'pick', 'type' => 'dropdown', 'label' => 'Term', 'order' => 2, 'properties' => ['options' => self::options('+1 year', '-1 year')]],
            ['id' => 'mine', 'type' => 'short_text', 'label' => 'Quote', 'order' => 3, 'properties' => []],
        ];

        $trip = $this->roundTrip($fields, ['phone' => '+61400123456', 'text' => '=not a formula', 'pick' => 'option_2', 'mine' => "'tis mine"]);

        $this->assertStringContainsString("'+61400123456", $trip['csv'], 'the file itself stays safe to open');
        $this->assertSame(1, $trip['result']['created'], json_encode($trip['result']['errors']));
        $this->assertSame('+61400123456', $trip['copy']['phone']);
        $this->assertSame('=not a formula', $trip['copy']['text']);
        $this->assertSame('option_2', $trip['copy']['pick']);
        $this->assertSame("'tis mine", $trip['copy']['mine']);
    }

    public function testALocationComesBackFromItsTwoNumbers(): void
    {
        $fields = [['id' => 'place', 'type' => 'location', 'label' => 'Place', 'order' => 0, 'properties' => []]];

        $trip = $this->roundTrip($fields, ['place' => ['latitude' => -33.8688, 'longitude' => 151.2093]]);

        $this->assertSame(1, $trip['result']['created'], json_encode($trip['result']['errors']));
        $this->assertSame(['latitude' => -33.8688, 'longitude' => 151.2093], $trip['copy']['place']);
    }

    public function testACellThatIsNotALocationIsRefused(): void
    {
        $fields = [['id' => 'place', 'type' => 'location', 'label' => 'Place', 'order' => 0, 'properties' => []]];
        $formId = self::$formService->createForm(['user_id' => $this->userId, 'title' => 'Bad place', 'status' => 'published', 'fields' => $fields])['id'];
        $this->roundTripForms[] = $formId;

        $result = self::$responses->importResponses($formId, [['Sydney'], ['120, 10']], [0 => 'place'], $fields);

        $this->assertSame(0, $result['created']);
        $this->assertSame('Invalid location format', explode(': ', $result['errors'][0]['errors'][0])[1]);
        $this->assertSame('Latitude must be between -90 and 90', explode(': ', $result['errors'][1]['errors'][0])[1]);
    }

    public function testAFileColumnIsNotImportedAndTheRowComesInWithoutIt(): void
    {
        $fields = [
            ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'order' => 0, 'properties' => []],
            ['id' => 'photo', 'type' => 'file_upload', 'label' => 'Photo', 'order' => 1, 'properties' => []],
        ];
        $formId = self::$formService->createForm(['user_id' => $this->userId, 'title' => 'Files', 'status' => 'published', 'fields' => $fields])['id'];
        $this->roundTripForms[] = $formId;

        $result = self::$responses->importResponses($formId, [['Ada', 'cv.pdf, photo.png']], [0 => 'name', 1 => 'photo'], $fields);

        $this->assertSame(1, $result['created'], json_encode($result['errors']));
        $stored = self::$sqlite->getFormDatabase($formId)->query('SELECT answers FROM responses')->fetchColumn();
        $this->assertSame(['name' => 'Ada'], json_decode((string) $stored, true));
    }

    public function testASignatureTypedComesBackAndOneDrawnDoesNot(): void
    {
        $fields = [
            ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'order' => 0, 'properties' => []],
            ['id' => 'sign', 'type' => 'signature', 'label' => 'Sign', 'order' => 1, 'properties' => []],
        ];

        $typed = $this->roundTrip($fields, ['name' => 'Ada', 'sign' => 'typed:Ada Lovelace']);
        $drawn = $this->roundTrip($fields, ['name' => 'Bea', 'sign' => 'data:image/png;base64,AAAA']);

        $this->assertSame('typed:Ada Lovelace', $typed['copy']['sign']);
        $this->assertStringContainsString('[signature]', $drawn['csv']);
        $this->assertSame(1, $drawn['result']['created'], json_encode($drawn['result']['errors']));
        $this->assertArrayNotHasKey('sign', $drawn['copy'], 'the placeholder is not a signature');
    }

    public function testTwoFieldsWithOneLabelKeepBothColumns(): void
    {
        $fields = [
            ['id' => 'first', 'type' => 'short_text', 'label' => 'Name', 'order' => 0, 'properties' => []],
            ['id' => 'second', 'type' => 'short_text', 'label' => 'Name', 'order' => 1, 'properties' => []],
        ];

        $trip = $this->roundTrip($fields, ['first' => 'Ada', 'second' => 'Lovelace']);

        $this->assertSame('Ada', $trip['copy']['first']);
        $this->assertSame('Lovelace', $trip['copy']['second']);
    }
}
