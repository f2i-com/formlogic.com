<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * Legacy field-type aliases (text/textarea) must map onto the canonical types so older
 * or imported schemas never reach the renderer with an unknown type ("Field type not
 * supported"). Mirrors the UI normalizeFieldType() in ui/src/types/form.ts.
 */
class FieldTypeAliasTest extends TestCase
{
    /** @return array<string, array{string, string}> */
    public static function aliases(): array
    {
        return [
            'text → short_text' => ['text', 'short_text'],
            'textarea → long_text' => ['textarea', 'long_text'],
            'select → dropdown' => ['select', 'dropdown'],
        ];
    }

    /** @dataProvider aliases */
    public function testLegacyAliasesMapToCanonicalTypes(string $legacy, string $canonical): void
    {
        $this->assertSame($canonical, FormService::normalizeFieldType($legacy));
    }

    /** @return array<string, array{string}> */
    public static function canonicalAndUnknown(): array
    {
        return [
            'short_text' => ['short_text'],
            'long_text' => ['long_text'],
            'file_upload' => ['file_upload'],
            'unknown passes through' => ['hologram'],
            'empty passes through' => [''],
        ];
    }

    /** @dataProvider canonicalAndUnknown */
    public function testCanonicalAndUnknownTypesPassThrough(string $type): void
    {
        $this->assertSame($type, FormService::normalizeFieldType($type));
    }

    /**
     * A tool that writes a form is told when a field's type is one no form screen draws, with the
     * types that are. Before, the field was stored as it came and the person filling in the form
     * met "Field type not supported".
     */
    public function testAToolIsToldWhenAFieldTypeIsNotOneAFormDraws(): void
    {
        foreach (FormService::FIELD_TYPES as $type) {
            $this->assertNull(FormService::fieldTypeProblem($type), $type);
        }
        // The other names for a type that the form is stored under its own name for.
        foreach (['text', 'textarea', 'select', 'checkbox'] as $alias) {
            $this->assertNull(FormService::fieldTypeProblem($alias), $alias);
            $this->assertContains(FormService::normalizeFieldType($alias), FormService::FIELD_TYPES);
        }
        // A form made before may hold a type outside the list: what the stored form already has is
        // not refused when the form is changed, so a tool can still change its other fields. A new
        // form is held to the list.
        $this->assertNull(FormService::fieldTypeProblem('radio', ['short_text', 'radio']));
        $this->assertNotNull(FormService::fieldTypeProblem('radio', ['short_text']));
        $this->assertNotNull(FormService::fieldTypeProblem('hologram', ['radio']));

        foreach (['hologram', 'toggle', 'boolean', 'radio', 'string', 'Short_Text', 'short text', 'Checkbox'] as $unknown) {
            $problem = FormService::fieldTypeProblem($unknown);
            $this->assertNotNull($problem, $unknown);
            $this->assertStringContainsString('"' . $unknown . '"', $problem);
            $this->assertStringContainsString('Use one of: short_text, long_text, email', $problem);
            $this->assertStringContainsString('checkboxes', $problem);
        }
        foreach ([null, '', '   ', 7, ['short_text'], true] as $notAType) {
            $this->assertSame('has no type', FormService::fieldTypeProblem($notAType));
        }
        // A very long made-up type is not echoed back whole.
        $this->assertLessThan(700, strlen((string) FormService::fieldTypeProblem(str_repeat('x', 5000))));
    }

    /**
     * One tick box. The diagram tool, three bundled packs and a sample app write fields of type
     * `checkbox`, and no form screen drew it: the person met "Field type not supported". It is
     * read as the list of tick boxes, with one box when the field names none.
     */
    public function testACheckboxIsAListOfTickBoxesWithOneBoxInIt(): void
    {
        $this->assertSame('checkboxes', FormService::normalizeFieldType('checkbox'));
        // A pack's "Done": no option of its own, so it is given the one box, "Yes".
        foreach ([null, [], ['options' => []], ['options' => 'none'], ['options' => ['x']], 'not properties'] as $none) {
            $this->assertSame([FormService::CHECKBOX_YES], FormService::checkboxProperties('checkbox', $none)['options'], (string) json_encode($none));
        }
        // What else the field holds is kept beside it.
        $this->assertSame(['options' => [FormService::CHECKBOX_YES], 'help' => 'Tick when finished'], FormService::checkboxProperties('checkbox', ['help' => 'Tick when finished']));
        // A pack's "Follow-up required": its own box is the box.
        $own = ['options' => [['id' => 'yes', 'label' => 'Follow-up required', 'value' => 'yes']]];
        $this->assertSame($own, FormService::checkboxProperties('checkbox', $own));
        // Every other type's properties are as they came, a list of tick boxes with none included:
        // that one is its owner's to fill.
        foreach (['checkboxes', 'dropdown', 'short_text'] as $other) {
            $this->assertSame([], FormService::checkboxProperties($other, []));
            $this->assertSame(['options' => []], FormService::checkboxProperties($other, ['options' => []]));
            $this->assertSame([], FormService::checkboxProperties($other, null));
        }
    }

    /** The list is the one the page's own type holds: a type drawn there is a type allowed here. */
    public function testTheListIsThePagesOwn(): void
    {
        $source = (string) file_get_contents(__DIR__ . '/../../../ui/src/types/form.ts');
        $this->assertSame(1, preg_match('/export type FieldType =(.*?);/s', $source, $found));
        preg_match_all("/'([a-z_]+)'/", $found[1], $names);
        $this->assertSame($names[1], FormService::FIELD_TYPES);
    }
}
