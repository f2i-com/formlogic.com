<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormTemplateCatalog;
use PHPUnit\Framework\TestCase;

final class FormTemplateCatalogTest extends TestCase
{
    private string $root;
    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/formlogic-template-test-' . bin2hex(random_bytes(8));
        mkdir($this->root); mkdir($this->root . '/bundled'); mkdir($this->root . '/custom');
    }
    protected function tearDown(): void
    {
        foreach (['bundled', 'custom'] as $folder) {
            foreach (glob($this->root . '/' . $folder . '/*.json') as $file) unlink($file);
            rmdir($this->root . '/' . $folder);
        }
        rmdir($this->root);
    }
    private function template(string $id = 'contact'): array
    {
        return ['id' => $id, 'name' => 'Contact', 'description' => 'A contact form', 'category' => 'service', 'categoryLabel' => 'Customer service', 'fields' => [['type' => 'email', 'label' => 'Email', 'required' => true, 'properties' => (object) []]]];
    }
    private function put(string $folder, array $template): void { file_put_contents($this->root . '/' . $folder . '/' . $template['id'] . '.json', json_encode($template, JSON_THROW_ON_ERROR)); }
    private function catalog(): FormTemplateCatalog { return new FormTemplateCatalog($this->root . '/bundled', $this->root . '/custom'); }

    public function testFilesAreDiscoveredAndUpdatedWithoutRestartOrManifest(): void
    {
        $catalog = $this->catalog();
        $this->assertSame([], $catalog->load()['templates']);
        $this->put('bundled', $this->template());
        $this->assertSame('Customer service', $catalog->load()['categories'][1]['label']);
        $this->put('custom', array_merge($this->template('quote'), ['name' => 'Quote request']));
        $this->assertCount(2, $catalog->load()['templates']);
        $this->put('custom', array_merge($this->template(), ['name' => 'Updated contact']));
        $this->assertSame(['Quote request', 'Updated contact'], array_column($catalog->load()['templates'], 'name'));
    }

    public function testAnInvalidOverrideKeepsTheDefaultAndDisabledHidesIt(): void
    {
        $this->put('bundled', $this->template());
        $this->put('custom', ['id' => 'contact', 'name' => 'Broken']);
        $result = $this->catalog()->load();
        $this->assertSame(1, $result['skipped']);
        $this->assertSame('Contact', $result['templates'][0]['name']);
        $this->put('custom', ['id' => 'contact', 'disabled' => true]);
        $this->assertSame([], $this->catalog()->load()['templates']);
    }

    public function testAllBundledStartersAreValidAndFieldsHaveNoFixedIdentity(): void
    {
        $catalog = new FormTemplateCatalog(dirname(__DIR__, 2) . '/resources/form-templates', $this->root . '/custom');
        $result = $catalog->load();
        $this->assertSame(0, $result['skipped']);
        $this->assertCount(8, $result['templates']);
        foreach ($result['templates'] as $template) foreach ($template['fields'] as $field) {
            $this->assertArrayNotHasKey('id', $field);
            $this->assertIsObject($field['properties']);
        }
    }

    public function testMalformedOptionsDoNotBreakOtherTemplates(): void
    {
        $this->put('bundled', $this->template());
        $invalid = $this->template('invalid');
        $invalid['fields'][0]['properties'] = ['options' => ['wrong']];
        $this->put('custom', $invalid);
        $result = $this->catalog()->load();
        $this->assertSame(1, $result['skipped']);
        $this->assertSame(['contact'], array_column($result['templates'], 'id'));
    }
}
