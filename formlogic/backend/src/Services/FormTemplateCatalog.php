<?php
declare(strict_types=1);
namespace FormLogic\Services;

/** JSON-only starter forms. No database, app source or executable template code. */
final class FormTemplateCatalog
{
    public function __construct(private ?string $bundled = null, private ?string $custom = null) {}

    public function load(): array
    {
        $root = dirname(__DIR__, 2);
        $templates = [];
        $skipped = 0;
        foreach ([$this->bundled ?? $root . '/resources/form-templates', $this->custom ?? $root . '/storage/form-templates'] as $directory) {
            if (!is_dir($directory)) continue;
            $files = glob($directory . '/*.json') ?: [];
            sort($files, SORT_STRING);
            foreach (array_slice($files, 0, 200) as $file) {
                try {
                    if (is_link($file) || !is_file($file) || filesize($file) > 262144) throw new \InvalidArgumentException('Invalid template file');
                    $value = json_decode(file_get_contents($file), true, 32, JSON_THROW_ON_ERROR);
                    $id = basename($file, '.json');
                    if (!preg_match('/^[a-z0-9][a-z0-9-]{0,79}$/D', $id) || !is_array($value) || ($value['id'] ?? null) !== $id) throw new \InvalidArgumentException('Template ID must match its filename');
                    if (($value['disabled'] ?? false) === true) { unset($templates[$id]); continue; }
                    $templates[$id] = $this->validate($value);
                } catch (\Throwable $error) {
                    $skipped++;
                    error_log('Form template skipped: ' . basename($file) . ' (' . $error->getMessage() . ')');
                }
            }
            $skipped += max(0, count($files) - 200);
        }
        $templates = array_values($templates);
        usort($templates, static fn($a, $b) => ($a['order'] <=> $b['order']) ?: strcasecmp($a['name'], $b['name']) ?: strcmp($a['id'], $b['id']));
        $categories = [['id' => 'all', 'label' => 'All templates', 'icon' => 'LayoutGrid']];
        $seen = [];
        foreach ($templates as $template) {
            if (isset($seen[$template['category']])) continue;
            $seen[$template['category']] = true;
            $categories[] = ['id' => $template['category'], 'label' => $template['categoryLabel'], 'icon' => $template['categoryIcon']];
        }
        return ['templates' => $templates, 'categories' => $categories, 'skipped' => $skipped];
    }

    private function text(array $value, string $key, int $max, string $default = ''): string
    {
        $text = $value[$key] ?? $default;
        if (!is_string($text) || mb_strlen($text) > $max) throw new \InvalidArgumentException('Invalid ' . $key);
        return $text;
    }

    private function validate(array $value): array
    {
        $name = $this->text($value, 'name', 120);
        $category = $this->text($value, 'category', 80, 'other');
        if (!trim($name) || $category === 'all' || !preg_match('/^[a-z0-9][a-z0-9-]{0,79}$/D', $category)) throw new \InvalidArgumentException('Invalid name or category');
        if (!is_array($value['fields'] ?? null) || !array_is_list($value['fields']) || count($value['fields']) > 100) throw new \InvalidArgumentException('Provide up to 100 fields');
        $types = ['short_text','long_text','email','phone','number','url','date','time','datetime','dropdown','multiple_choice','checkboxes','rating','scale','file_upload','signature','statement','welcome_screen','thank_you','calculated','linked_record','location','hidden'];
        foreach ($value['fields'] as &$field) {
            if (!is_array($field) || !in_array($field['type'] ?? null, $types, true) || !is_string($field['label'] ?? null) || strlen($field['label']) > 2000 || (isset($field['required']) && !is_bool($field['required']))) throw new \InvalidArgumentException('Invalid field');
            $properties = $field['properties'] ?? [];
            if (!is_array($properties) || ($properties && array_is_list($properties))) throw new \InvalidArgumentException('Field properties must be an object');
            if (isset($properties['options'])) {
                if (!is_array($properties['options']) || !array_is_list($properties['options']) || count($properties['options']) > 200) throw new \InvalidArgumentException('Invalid field options');
                foreach ($properties['options'] as $option) {
                    if (!is_array($option) || !is_string($option['id'] ?? null) || !is_string($option['label'] ?? null) || !is_string($option['value'] ?? null)) throw new \InvalidArgumentException('Options need id, label and value');
                }
            }
            unset($field['id'], $field['order']); // Each created form gets its own field identities.
            $field['required'] = $field['required'] ?? false;
            $field['properties'] = (object) $properties;
        }
        unset($field);
        return ['id' => $value['id'], 'name' => $name, 'description' => $this->text($value, 'description', 1000),
            'category' => $category, 'categoryLabel' => $this->text($value, 'categoryLabel', 100, ucwords(str_replace('-', ' ', $category))),
            'categoryIcon' => $this->text($value, 'categoryIcon', 60, 'LayoutGrid'), 'icon' => $this->text($value, 'icon', 60, 'FileText'),
            'estimatedTime' => $this->text($value, 'estimatedTime', 60), 'order' => is_int($value['order'] ?? null) ? $value['order'] : 1000,
            'fields' => $value['fields']];
    }
}
