<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A private form's manifest is signed over the editor's own JSON of the fields: its key order,
 * and no key at all for a value it does not have. The server keeps the same fields in another
 * shape. Whether a save changes the fields is decided by comparing the two, so both are first
 * put in the shape the store hands back (FormService::fieldsAsStored). That shape has to be the
 * store's real one, or the same fields count as changed and the save is refused with
 * manifest_required.
 */
final class PrivateFormFieldsShapeTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-fields-shape-' . bin2hex(random_bytes(5));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
    }

    /** The fields as the editor holds and signs them: JSON.stringify(form.fields). */
    private const EDITOR_JSON = '[
        {"id":"name","type":"short_text","label":"Name","required":true,"properties":{},"order":0},
        {"id":"notes","type":"textarea","label":"Notes","description":"","required":false,
         "validation":[{"type":"max_length","value":200}],"properties":{"rows":4,"hint":{}},"order":1},
        {"id":"agree","type":"checkbox","label":"Agree","required":false,"properties":{},
         "conditionalLogic":{"action":"show","rules":[{"field":"name","operator":"not_empty"}]},"order":7},
        {"id":"email","type":"email","label":"Email","required":false,"properties":{"placeholder":"a@b.c"}},
        {"id":"phone","type":"phone","label":"Phone","required":false,"properties":{},"order":3}
    ]';

    /** @return array{0: FormService, 1: SQLiteConnection} a service over a real form store, with only the form row faked */
    private function service(): array
    {
        $sqlite = new SQLiteConnection($this->dir);
        $rows = new PDO('sqlite::memory:');
        $rows->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $rows->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, field_count INTEGER)');
        $class = new \ReflectionClass(FormService::class);
        $service = $class->newInstanceWithoutConstructor();
        $class->getProperty('sqlite')->setValue($service, $sqlite);
        $class->getProperty('mysql')->setValue($service, $rows);
        return [$service, $sqlite];
    }

    private static function call(FormService $service, string $method, mixed ...$args): mixed
    {
        return (new \ReflectionMethod(FormService::class, $method))->invoke($service, ...$args);
    }

    public function testTheShapeIsWhatTheStoreHandsBack(): void
    {
        [$service, $sqlite] = $this->service();
        $editorFields = json_decode(self::EDITOR_JSON, true);
        self::assertIsArray($editorFields);

        self::call($service, 'saveFormFields', 'form-shape', $editorFields);
        $kept = self::call($service, 'getFormFields', 'form-shape');
        $sqlite->closeAll();

        // Read back by order: the two fields of order 3 as they were written, then the 7.
        self::assertSame(['name', 'notes', 'email', 'phone', 'agree'], array_column($kept, 'id'));
        self::assertSame($kept, self::call($service, 'fieldsAsStored', $editorFields));
        self::assertSame($kept, self::call($service, 'fieldsAsStored', $kept), 'a stored list is already in the shape');
        // The two really are spelled differently, which is what refused the save.
        self::assertNotSame(
            self::call($service, 'canonicalFieldsHash', $kept),
            self::call($service, 'canonicalFieldsHash', $editorFields)
        );
    }

    public function testARealChangeStillShows(): void
    {
        [$service] = $this->service();
        $editorFields = json_decode(self::EDITOR_JSON, true);
        $hash = static fn (array $fields): string => self::call($service, 'canonicalFieldsHash', self::call($service, 'fieldsAsStored', $fields));
        $signed = $hash($editorFields);

        $changes = [
            'a label' => static function (array &$f): void { $f[0]['label'] = 'Full name'; },
            'required' => static function (array &$f): void { $f[0]['required'] = false; },
            'a type' => static function (array &$f): void { $f[0]['type'] = 'long_text'; },
            'a property' => static function (array &$f): void { $f[1]['properties']['rows'] = 5; },
            'a validation rule' => static function (array &$f): void { $f[1]['validation'][0]['value'] = 100; },
            'a show-if rule' => static function (array &$f): void { $f[2]['conditionalLogic']['rules'][0]['field'] = 'notes'; },
            'a description' => static function (array &$f): void { $f[1]['description'] = 'Anything else'; },
            'the order' => static function (array &$f): void { $f[0]['order'] = 1; $f[1]['order'] = 0; },
            'a field removed' => static function (array &$f): void { array_pop($f); },
            'a field added' => static function (array &$f): void { $f[] = ['id' => 'extra', 'type' => 'short_text', 'label' => 'Extra', 'required' => false]; },
        ];
        foreach ($changes as $what => $change) {
            $fields = $editorFields;
            $change($fields);
            self::assertNotSame($signed, $hash($fields), $what);
        }
    }
}
