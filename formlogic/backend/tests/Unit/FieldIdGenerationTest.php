<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AIService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * A field's id is the name its answer has in show-if rules and calculations, which are JavaScript
 * expressions. The editor (formStore.ts generateFieldId) names a new field so that name can be
 * read there: never a word of the language (`class == "5A"` does not parse), never a name the
 * expressions already use, never starting with a digit. The server named new fields too, in three
 * places, without those rules: a field saved without an id, a duplicated form's fields, and a form
 * the AI generated (which also gave two fields of one label the same id). Each now names a new
 * field as the editor does. A stored id is never renamed.
 */
final class FieldIdGenerationTest extends TestCase
{
    private const UTILS_TS = __DIR__ . '/../../../ui/src/lib/utils.ts';

    public function testANewIdCanBeReadInAnExpression(): void
    {
        $cases = [
            'Class' => 'class_1', 'Default' => 'default_1', 'New' => 'new_1', 'This' => 'this_1',
            'Print' => 'print_1', 'Count' => 'count_1', 'Value' => 'value_1', 'Eval' => 'eval_1',
            '401k' => '_401k', '1st choice' => '_1st_choice', '' => 'field', '!!!' => 'field',
            'Full name' => 'full_name', 'Class name' => 'class_name',
        ];
        foreach ($cases as $label => $expected) {
            $id = FormService::newFieldId((string) $label, []);
            self::assertSame($expected, $id, "label '{$label}'");
            self::assertNull(FormService::fieldIdError($id), "'{$id}' is an id the server takes");
            self::assertFalse(FormService::isReservedFieldName($id), "'{$id}' is not a reserved name");
        }
    }

    public function testANewIdIsNotOneTheFormAlreadyHas(): void
    {
        self::assertSame('email_1', FormService::newFieldId('Email', ['email' => true]));
        self::assertSame('email_2', FormService::newFieldId('Email', ['email' => true, 'email_1' => true]));
        self::assertSame('class_2', FormService::newFieldId('Class', ['class_1' => true]));
    }

    /**
     * The words and the names the editor will not give a field (ui/src/lib/utils.ts) are the ones
     * the server will not give one, both ways round.
     */
    public function testTheServerKeepsTheSameNamesAsTheEditor(): void
    {
        if (!is_file(self::UTILS_TS)) {
            self::markTestSkipped('The UI source is not beside this backend');
        }
        $ts = (string) file_get_contents(self::UTILS_TS);
        $ui = [];
        foreach (['EXPRESSION_RESERVED_WORDS', 'EXPRESSION_GLOBAL_NAMES'] as $name) {
            self::assertSame(1, preg_match('/export const ' . $name . '\b[^=]*= new Set\(\[([\s\S]*?)\]\);/', $ts, $m), $name);
            $words = array_map(static fn (array $w): string => $w[1], [...preg_match_all("/'([^']+)'/", $m[1], $all, PREG_SET_ORDER) ? $all : []]);
            self::assertGreaterThan(20, count($words), $name);
            $ui = array_merge($ui, $words);
        }
        $server = new \ReflectionClass(FormService::class);
        $serverNames = array_merge($server->getConstant('RESERVED_FIELD_IDS'), $server->getConstant('EXPRESSION_RESERVED_WORDS'));
        sort($ui);
        sort($serverNames);
        self::assertSame(array_values(array_unique($ui)), array_values(array_unique($serverNames)));
        foreach ($ui as $word) {
            self::assertTrue(FormService::isReservedFieldName($word), $word);
        }
    }

    /**
     * Words of the language are not refused when a client names a field with one (an import, a
     * restore, a version brought back or an API client may carry one already): only the server's
     * own new names avoid them.
     */
    public function testAnIdAClientChoseIsStillTakenWhenItIsAWordOfTheLanguage(): void
    {
        foreach (['class', 'new', 'default', 'case'] as $id) {
            self::assertNull(FormService::fieldIdError($id), $id);
        }
    }

    /** @param list<array<string,mixed>> $fields @return list<string> the ids of the generated form's fields */
    private static function aiFieldIds(array $fields): array
    {
        $parse = new \ReflectionMethod(AIService::class, 'parseFormResponse');
        $form = $parse->invoke(new AIService(), (string) json_encode(['title' => 'T', 'fields' => $fields]));
        return array_column($form['fields'], 'id');
    }

    public function testTheAiFormGeneratorNamesFieldsAsTheEditorDoes(): void
    {
        $ids = self::aiFieldIds([
            ['type' => 'short_text', 'label' => 'Class'],
            ['type' => 'short_text', 'label' => 'Class'],
            ['type' => 'short_text', 'label' => '1st choice'],
            ['type' => 'short_text', 'label' => 'Print'],
            ['type' => 'email', 'label' => 'Email', 'id' => 'email'],
            ['type' => 'email', 'label' => 'Email'],
        ]);
        self::assertSame(['class_1', 'class_2', '_1st_choice', 'print_1', 'email', 'email_1'], $ids);
    }

    /** An id the AI supplied is kept when the server would take it, and replaced when it would not. */
    public function testAnIdTheAiSuppliedIsKeptOnlyWhenTheServerWouldTakeIt(): void
    {
        $ids = self::aiFieldIds([
            ['type' => 'short_text', 'label' => 'Name', 'id' => 'customer_name'],
            ['type' => 'short_text', 'label' => 'Code', 'id' => '1code'],
            ['type' => 'short_text', 'label' => 'Total', 'id' => 'sum'],
            ['type' => 'short_text', 'label' => 'Other', 'id' => 'customer_name'],
            ['type' => 'short_text', 'label' => 'Kind', 'id' => 'class'],
        ]);
        self::assertSame(['customer_name', 'code', 'total', 'other', 'kind'], $ids);
    }
}
